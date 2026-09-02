/**
 * Article eval harness (spec §8.7).
 *
 *   npm run eval:articles                     # offline, no API key, no network
 *   npm run eval:articles -- --live --persona mel-diaper --type draft_rankings --fixture draft-day
 *
 * The runner is `vite-node` (already a dependency, via vitest) because this repo has no `tsx` and
 * `node --experimental-strip-types` cannot load `src/lib/ai/*` — those modules import types as
 * values, which type stripping is not allowed to erase. `npx tsx scripts/eval-articles.ts` works
 * too if you have tsx on your machine; nothing here depends on which runner you use.
 *
 * OFFLINE MODE (default) is the one that runs in CI. For every fixture x active writer x the four
 * highest-volume content types it builds the FACTS block and both prompts and asserts:
 *   - the system prompt is in §4.4 order: contract, voice, quotes, relationships, template, gaps;
 *   - the user prompt opens with the <FACTS> block;
 *   - `facts.missing` is exactly what the fixture's `expected.json` says it should be;
 *   - a content type whose core data is absent refuses with `InsufficientDataError`.
 * It then runs the deterministic verifier over the recorded sample articles in
 * `__fixtures__/samples/` and asserts each one produces exactly the violations it is recorded with.
 *
 * LIVE MODE (`--live`, needs ANTHROPIC_API_KEY) generates one real article per selected fixture,
 * verifies it, and prints the quality panel: attribution accuracy, quote fidelity, ghost speakers,
 * number precision, source validity, the sparse-week restraint ratio, and a Sonnet 5 rubric.
 * It costs money and is never part of `npm test`.
 */

import {
  EVAL_CONTENT_TYPES,
  expectations,
  factsRequestFor,
  fixtures,
  fixturesByName,
  samples,
  type EvalFixture,
} from "../src/lib/ai/__fixtures__";
import { buildFactsBlock, type FactsBlock } from "../src/lib/ai/facts";
import { verifyArticle, type Violation } from "../src/lib/ai/fact-verifier";
import { InsufficientDataError, PromptBuilder } from "../src/lib/ai/prompt-builder";
import { getPersona, personaPrompts } from "../src/lib/ai/persona-prompts";
import type { GeneratedArticleT } from "../src/lib/ai/content-generation-service";

/* -------------------------------------------------------------------------- */
/* CLI                                                                         */
/* -------------------------------------------------------------------------- */

interface Options {
  live: boolean;
  persona?: string;
  type?: string;
  fixture?: string;
  quiet: boolean;
}

function parseArgs(argv: string[]): Options {
  const options: Options = { live: false, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) throw new Error(`${arg} needs a value`);
      i++;
      return next;
    };
    switch (arg) {
      case "--live":
        options.live = true;
        break;
      case "--persona":
        options.persona = value();
        break;
      case "--type":
        options.type = value();
        break;
      case "--fixture":
        options.fixture = value();
        break;
      case "--quiet":
        options.quiet = true;
        break;
      case "--help":
      case "-h":
        printUsage();
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown flag: ${arg}`);
    }
  }
  return options;
}

function printUsage(): void {
  console.log(`Usage: npm run eval:articles -- [options]

  --live               Generate real articles (requires ANTHROPIC_API_KEY). Costs money.
  --persona <slug>     Writer to use in live mode (default: the type's preferred writer).
  --type <content>     Content type (default: weekly_recap). One of:
                       ${EVAL_CONTENT_TYPES.join(", ")}
  --fixture <name>     Fixture to use (default: rich-week + sparse-week, for the restraint ratio).
                       One of: ${fixtures.map(f => f.name).join(", ")}
  --quiet              Only print the summary lines.
  -h, --help           This message.`);
}

/* -------------------------------------------------------------------------- */
/* Tiny table + result plumbing                                                */
/* -------------------------------------------------------------------------- */

const PASS = "PASS";
const FAIL = "FAIL";

function printTable(headers: string[], rows: string[][]): void {
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map(row => (row[column] ?? "").length))
  );
  const line = (cells: string[]) =>
    cells.map((cell, column) => (cell ?? "").padEnd(widths[column])).join("  ").trimEnd();
  console.log(line(headers));
  console.log(widths.map(width => "-".repeat(width)).join("  "));
  rows.forEach(row => console.log(line(row)));
}

const failures: string[] = [];

function check(condition: boolean, message: string): boolean {
  if (!condition) failures.push(message);
  return condition;
}

/* -------------------------------------------------------------------------- */
/* Offline mode                                                                */
/* -------------------------------------------------------------------------- */

const ACTIVE_WRITERS = Object.values(personaPrompts)
  .filter(persona => persona.isWriter)
  .map(persona => persona.slug);

/** The §4.4 system prompt order. A missing optional block is skipped, never reordered. */
const PROMPT_ORDER = ["GROUNDING CONTRACT", "WHO YOU ARE", "QUOTES", "RELATIONSHIPS", "TEMPLATE", "MISSING DATA"];

function checkPromptOrder(systemPrompt: string, userPrompt: string, personaVoice: string, label: string): boolean {
  let ok = check(systemPrompt.indexOf("GROUNDING CONTRACT") === 0, `${label}: grounding contract is not first`);

  let previous = -1;
  let previousHeading = "";
  for (const heading of PROMPT_ORDER) {
    const index = systemPrompt.indexOf(`\n${heading}`) >= 0
      ? systemPrompt.indexOf(`\n${heading}`)
      : systemPrompt.indexOf(heading) === 0
        ? 0
        : -1;
    if (index < 0) continue; // optional block (RELATIONSHIPS / MISSING DATA) not emitted
    ok = check(index > previous, `${label}: ${heading} came before ${previousHeading}`) && ok;
    previous = index;
    previousHeading = heading;
  }

  const voiceIndex = systemPrompt.indexOf(personaVoice);
  ok = check(voiceIndex > 0, `${label}: persona voice missing from the system prompt`) && ok;
  ok = check(
    voiceIndex > systemPrompt.indexOf("GROUNDING CONTRACT"),
    `${label}: persona voice appears before the grounding contract`
  ) && ok;
  ok = check(userPrompt.startsWith("<FACTS>"), `${label}: user prompt does not open with <FACTS>`) && ok;
  return ok;
}

function countUnresolvedTeamRefs(facts: FactsBlock): number {
  const refs = [
    ...facts.matchups.flatMap(matchup => [
      matchup.home.teamId,
      matchup.away.teamId,
      ...matchup.players.map(player => player.fantasyTeamId),
    ]),
    ...facts.standings.map(row => row.teamId),
    ...facts.transactions.map(row => row.teamId),
    ...facts.trades.flatMap(trade => trade.sides.map(side => side.teamId)),
    ...(facts.draftPicks ?? []).map(pick => pick.teamId),
    ...facts.quotes.map(quote => quote.teamId),
    ...facts.nonRespondents.map(entry => entry.teamId),
    ...facts.relationships.map(entry => entry.teamId),
  ];
  return refs.filter(id => id === "T?").length;
}

function sameStrings(actual: string[], expected: string[]): boolean {
  return actual.length === expected.length && actual.every((entry, index) => entry === expected[index]);
}

function runFactsCounts(fixture: EvalFixture): string[][] {
  const expectation = expectations[fixture.name];
  const facts = buildFactsBlock(factsRequestFor(fixture, "weekly_recap"));
  const actual = {
    teams: facts.teams.length,
    matchups: facts.matchups.length,
    matchupPlayers: facts.matchups.reduce((total, matchup) => total + matchup.players.length, 0),
    standings: facts.standings.length,
    transactions: facts.transactions.length,
    trades: facts.trades.length,
    draftPicks: facts.draftPicks?.length ?? 0,
    quotes: facts.quotes.length,
    nonRespondents: facts.nonRespondents.length,
    relationships: facts.relationships.length,
    priorClaims: facts.priorClaims.length,
  };

  const rows: string[][] = [];
  for (const [key, value] of Object.entries(expectation.facts)) {
    const got = actual[key as keyof typeof actual];
    const ok = check(got === value, `${fixture.name}: facts.${key} is ${got}, expected ${value}`);
    rows.push([fixture.name, key, String(value), String(got), ok ? PASS : FAIL]);
  }
  const unresolved = countUnresolvedTeamRefs(facts);
  const ok = check(
    unresolved === expectation.unresolvedTeamRefs,
    `${fixture.name}: ${unresolved} FACTS reference(s) did not resolve to a team`
  );
  rows.push([fixture.name, "unresolvedTeamRefs", String(expectation.unresolvedTeamRefs), String(unresolved), ok ? PASS : FAIL]);
  return rows;
}

function runSweep(): string[][] {
  const rows: string[][] = [];

  for (const fixture of fixtures) {
    const expectation = expectations[fixture.name];
    for (const contentType of EVAL_CONTENT_TYPES) {
      const expected = expectation.byType[contentType];
      const label = `${fixture.name}/${contentType}`;

      const facts = buildFactsBlock(factsRequestFor(fixture, contentType));
      const missingOk = check(
        sameStrings(facts.missing, expected.missing),
        `${label}: facts.missing mismatch\n    expected: ${JSON.stringify(expected.missing, null, 2)}\n    actual:   ${JSON.stringify(facts.missing, null, 2)}`
      );

      let orderOk = true;
      let refusals = 0;
      for (const persona of ACTIVE_WRITERS) {
        const options = { ...factsRequestFor(fixture, contentType), leagueId: `eval_${fixture.name}`, persona };
        try {
          const built = new PromptBuilder(options).build();
          if (expected.throws) {
            orderOk = check(false, `${label}/${persona}: expected ${expected.throws} and got a prompt`) && orderOk;
            continue;
          }
          orderOk = checkPromptOrder(
            built.systemPrompt,
            built.userPrompt,
            getPersona(persona).voice,
            `${label}/${persona}`
          ) && orderOk;
        } catch (error) {
          if (expected.throws && error instanceof InsufficientDataError) {
            refusals++;
            continue;
          }
          orderOk = check(
            false,
            `${label}/${persona}: unexpected ${(error as Error).name}: ${(error as Error).message}`
          ) && orderOk;
        }
      }

      const refusalOk = expected.throws
        ? check(refusals === ACTIVE_WRITERS.length, `${label}: only ${refusals}/${ACTIVE_WRITERS.length} writers refused`)
        : true;

      rows.push([
        fixture.name,
        contentType,
        String(ACTIVE_WRITERS.length),
        expected.throws ? "refuses" : "builds",
        `${facts.missing.length}`,
        missingOk ? PASS : FAIL,
        orderOk && refusalOk ? PASS : FAIL,
      ]);
    }
  }

  return rows;
}

function runSamples(): string[][] {
  const rows: string[][] = [];

  for (const sample of samples) {
    const fixture = fixturesByName[sample.fixture];
    if (!fixture) {
      check(false, `sample ${sample.name}: unknown fixture ${sample.fixture}`);
      continue;
    }
    const facts = buildFactsBlock(factsRequestFor(fixture, sample.contentType));
    const violations = verifyArticle(sample.article, facts);

    const actual = violations.map(v => `${v.kind}/${v.severity}`).sort();
    const expected = sample.expected.map(v => `${v.kind}/${v.severity}`).sort();
    const ok = check(
      sameStrings(actual, expected),
      `sample ${sample.name}: verifier mismatch\n    expected: ${expected.join(", ") || "(clean)"}\n    actual:   ${actual.join(", ") || "(clean)"}`
    );

    rows.push([
      sample.name,
      sample.persona,
      expected.join(", ") || "(clean)",
      actual.join(", ") || "(clean)",
      ok ? PASS : FAIL,
    ]);
  }

  return rows;
}

function runOffline(options: Options): void {
  if (!options.quiet) {
    console.log("\nFACTS counts\n");
    printTable(["fixture", "field", "expected", "actual", ""], fixtures.flatMap(runFactsCounts));
  } else {
    fixtures.forEach(runFactsCounts);
  }

  const sweep = runSweep();
  if (!options.quiet) {
    console.log("\nPrompt sweep — every fixture x writer x content type\n");
    printTable(["fixture", "type", "writers", "expect", "gaps", "missing", "order"], sweep);
  }

  const sampleRows = runSamples();
  if (!options.quiet) {
    console.log("\nVerifier on recorded samples\n");
    printTable(["sample", "writer", "expected", "actual", ""], sampleRows);
  }

  const combos = fixtures.length * EVAL_CONTENT_TYPES.length * ACTIVE_WRITERS.length;
  console.log(
    `\nOffline eval: ${combos} fixture x writer x type combinations, ${samples.length} recorded samples.`
  );
}

/* -------------------------------------------------------------------------- */
/* Live mode                                                                   */
/* -------------------------------------------------------------------------- */

interface LiveResult {
  fixture: string;
  persona: string;
  contentType: string;
  words: number;
  violations: Violation[];
  /** The verified quotes the service actually stored on the article. */
  quotes: GeneratedArticleT["quotes"];
  /** As stored: a Convex team id when the id resolved, otherwise the team name. */
  featuredTeams: string[];
  featuredPlayers: string[];
  facts: FactsBlock;
  body: string;
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Share of the teams and players the article ended up featuring that name something in FACTS.
 * The service stores resolved values (a Convex team id where the FACTS id resolved, a player name),
 * so this measures what a reader would actually be handed, not just what the model claimed.
 */
function attributionAccuracy(result: LiveResult): string {
  const teamKeys = new Set(
    result.facts.teams.flatMap(team => [team.id, team.teamId, team.name.toLowerCase()])
  );
  const playerNames = new Set([
    ...result.facts.matchups.flatMap(matchup => matchup.players.map(player => player.name.toLowerCase())),
    ...(result.facts.draftPicks ?? []).map(pick => pick.player.toLowerCase()),
  ]);

  let total = 0;
  let good = 0;
  for (const team of result.featuredTeams) {
    total++;
    if (teamKeys.has(team) || teamKeys.has(team.toLowerCase())) good++;
  }
  for (const player of result.featuredPlayers) {
    total++;
    if (playerNames.has(player.toLowerCase())) good++;
  }
  return total === 0 ? "n/a" : `${((good / total) * 100).toFixed(0)}% (${good}/${total})`;
}

function quoteFidelity(result: LiveResult): string {
  const offered = result.facts.quotes.length;
  const used = result.quotes.length;
  const verbatim = result.quotes.filter(quote => {
    const source = result.facts.quotes.find(entry => entry.id === quote.quoteId);
    return source !== undefined && source.text.trim() === quote.text.trim();
  }).length;
  if (offered === 0) return "n/a (no ledger)";
  return `${used}/${offered} used, ${verbatim}/${Math.max(used, 1)} verbatim`;
}

function countKinds(result: LiveResult, kinds: string[]): number {
  return result.violations.filter(violation => kinds.includes(violation.kind)).length;
}

async function generateOne(
  fixture: EvalFixture,
  persona: string,
  contentType: string,
  apiKey: string
): Promise<LiveResult> {
  const { contentGenerationService } = await import("../src/lib/ai/content-generation-service");
  const request = factsRequestFor(fixture, contentType);
  const facts = buildFactsBlock(request);

  const generated = await contentGenerationService.generateContent(
    {
      leagueId: `eval_${fixture.name}` as never,
      userId: "eval-harness",
      contentType,
      persona,
      leagueData: fixture.leagueData,
      commentResponses: fixture.commentResponses,
      nonRespondents: fixture.nonRespondents,
      relationships: fixture.relationships,
      priorClaims: fixture.priorClaims,
    },
    apiKey
  );

  // The service has already run the verifier; its findings are the article's review flags.
  return {
    fixture: fixture.name,
    persona,
    contentType,
    words: wordCount(generated.content),
    violations: generated.metadata.reviewFlags ?? [],
    quotes: generated.metadata.quotes ?? [],
    featuredTeams: generated.metadata.featuredTeams ?? [],
    featuredPlayers: generated.metadata.featuredPlayers ?? [],
    facts,
    body: generated.content,
  };
}

const RUBRIC_PROMPT = `You are grading one article against the writer's own brief. Score 1-5 on each
axis and return ONLY a JSON object, with no preamble and no code fence:
{"voiceDistinctness":n,"signatureMoves":n,"tonalConsistency":n,"respectsTheFacts":n,"note":"one sentence"}

- voiceDistinctness: could a reader tell this writer from the other five on the desk?
- signatureMoves: are the writer's listed signature moves actually present?
- tonalConsistency: does the piece hold one tone start to finish?
- respectsTheFacts: does it stay inside the FACTS block, name gaps rather than filling them, and
  avoid claiming numbers, quotes or history that are not there?`;

async function runRubric(result: LiveResult, apiKey: string): Promise<string> {
  const persona = getPersona(result.persona);
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const anthropic = new Anthropic({ apiKey });
  const message = await anthropic.messages.create({
    model: "claude-sonnet-5",
    max_tokens: 1000,
    system: RUBRIC_PROMPT,
    messages: [
      {
        role: "user",
        content: `WRITER: ${persona.name} — ${persona.role}
VOICE: ${persona.voice}
SIGNATURE MOVES: ${persona.signatureMoves.join(" | ")}
NEVER: ${persona.neverDo.join(" | ")}

<FACTS>
${JSON.stringify(result.facts).slice(0, 20000)}
</FACTS>

ARTICLE:
${result.body}`,
      },
    ],
  });
  const text = message.content
    .map(block => (block.type === "text" ? block.text : ""))
    .join("")
    .trim();
  const json = text.match(/\{[\s\S]*\}/)?.[0];
  if (!json) return text.slice(0, 200);
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    return ["voiceDistinctness", "signatureMoves", "tonalConsistency", "respectsTheFacts"]
      .map(axis => `${axis} ${String(parsed[axis] ?? "?")}/5`)
      .join(" · ") + (parsed.note ? ` — ${String(parsed.note)}` : "");
  } catch {
    return text.slice(0, 200);
  }
}

async function runLive(options: Options): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    failures.push("--live needs ANTHROPIC_API_KEY in the environment");
    return;
  }

  const contentType = options.type ?? "weekly_recap";
  const persona = options.persona ?? "curtis-vaughn";
  const names = options.fixture ? [options.fixture] : ["rich-week", "sparse-week"];

  const results: LiveResult[] = [];
  for (const name of names) {
    const fixture = fixturesByName[name];
    if (!fixture) {
      failures.push(`--fixture ${name} is not a fixture`);
      return;
    }
    console.log(`Generating ${contentType} as ${persona} on ${name}…`);
    try {
      results.push(await generateOne(fixture, persona, contentType, apiKey));
    } catch (error) {
      if (error instanceof InsufficientDataError) {
        console.log(`  refused (as designed): ${error.message}`);
        continue;
      }
      failures.push(`live ${name}/${contentType}/${persona}: ${(error as Error).message}`);
    }
  }
  if (results.length === 0) return;

  console.log("\nLive quality panel\n");
  printTable(
    ["fixture", "words", "attribution", "quote fidelity", "ghosts", "numbers", "sources"],
    results.map(result => [
      result.fixture,
      String(result.words),
      attributionAccuracy(result),
      quoteFidelity(result),
      String(countKinds(result, ["ghost_speaker"])),
      String(countKinds(result, ["unverified_number"])),
      String(countKinds(result, ["bad_source_path"])),
    ])
  );

  const rich = results.find(result => result.fixture === "rich-week");
  const sparse = results.find(result => result.fixture === "sparse-week");
  if (rich && sparse) {
    const ratio = sparse.words / Math.max(rich.words, 1);
    console.log(
      `\nSparse-week restraint ratio: ${ratio.toFixed(2)} (${sparse.words} words on thin data vs ${rich.words} on rich). Lower is better; above 1.0 means the writer padded.`
    );
  } else {
    console.log("\nSparse-week restraint ratio: n/a (needs both rich-week and sparse-week)");
  }

  console.log("\nPersona adherence (Sonnet 5, 1-5)\n");
  for (const result of results) {
    console.log(`  ${result.fixture}: ${await runRubric(result, apiKey)}`);
  }
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                 */
/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  runOffline(options);
  if (options.live) await runLive(options);

  if (failures.length > 0) {
    console.error(`\n${failures.length} failure(s):`);
    failures.forEach(failure => console.error(`  - ${failure}`));
    process.exitCode = 1;
    return;
  }
  console.log("\nAll eval checks passed.");
}

await main();
