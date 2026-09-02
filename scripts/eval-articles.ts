/**
 * Article eval harness (spec §8.7).
 *
 *   npm run eval:articles                     # offline, no API key, no network
 *   npm run eval:articles -- --route          # print the model/effort/credit table and exit
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
import { contentTypePersonaMap, getPersona, personaPrompts } from "../src/lib/ai/persona-prompts";
import {
  contentTemplates,
  creditCostFor,
  INTERVIEW_CREDITS_PER_MANAGER,
} from "../src/lib/ai/content-templates";
import { resolveRoute } from "../src/lib/ai/content-generation-service";
import type { GeneratedArticleT, GenerationRoute } from "../src/lib/ai/content-generation-service";

/* -------------------------------------------------------------------------- */
/* CLI                                                                         */
/* -------------------------------------------------------------------------- */

interface Options {
  live: boolean;
  persona?: string;
  type?: string;
  fixture?: string;
  quiet: boolean;
  /** Live matrix: every content type with its preferred writer, plus every writer on weekly_recap. */
  matrix: boolean;
  /** Write live results (tokens, cost, violations) as JSON to this path. */
  out?: string;
  /** Write every live article body (markdown, with its flags) into this directory. */
  dump?: string;
  concurrency: number;
  /** Matrix: also grade each article with the Sonnet 5 persona-adherence rubric. */
  rubric: boolean;
  /** Print the model/effort/credit table and exit. No API key, no network. */
  route: boolean;
}

function parseArgs(argv: string[]): Options {
  const options: Options = { live: false, quiet: false, matrix: false, concurrency: 3, rubric: false, route: false };
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
      case "--matrix":
        options.matrix = true;
        options.live = true;
        break;
      case "--out":
        options.out = value();
        break;
      case "--concurrency":
        options.concurrency = Math.max(1, Number(value()) || 1);
        break;
      case "--rubric":
        options.rubric = true;
        break;
      case "--dump":
        options.dump = value();
        break;
      case "--route":
        options.route = true;
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
  --matrix             Live: every content type with its preferred writer (draft types on draft-day,
                       the rest on rich-week) plus every writer on weekly_recap. Costs real money.
  --out <path>         Write live results (tokens, cost, violations, words) as JSON.
  --concurrency <n>    Parallel generations in matrix mode (default 3).
  --rubric             Matrix: grade each article with the Sonnet 5 persona rubric (adds ~2¢ each).
  --route              Print the model/effort/credit table (spec §10.2-§10.3) and exit.
  -h, --help           This message.`);
}

/* -------------------------------------------------------------------------- */
/* Route table (--route)                                                       */
/* -------------------------------------------------------------------------- */

/** What every content type generates on, after `GENERATION_ROUTE_OVERRIDES` is applied. */
function printRouteTable(): void {
  const rows = Object.keys(contentTemplates)
    .sort()
    .map(contentType => {
      const route = resolveRoute(contentType);
      return [
        contentType,
        route.model.replace("claude-", ""),
        route.effort,
        String(contentTemplates[contentType].creditCost),
        String(creditCostFor(contentType, 4)),
        contentTypePersonaMap[contentType]?.[0] ?? "curtis-vaughn",
      ];
    });

  console.log("\nGeneration routes (env GENERATION_ROUTE_OVERRIDES applied)\n");
  printTable(["type", "model", "effort", "credits", "+4 asked", "writer"], rows);

  const byRoute = new Map<string, number>();
  for (const contentType of Object.keys(contentTemplates)) {
    const route = resolveRoute(contentType);
    const key = `${route.model} / ${route.effort}`;
    byRoute.set(key, (byRoute.get(key) ?? 0) + 1);
  }
  console.log(
    `\n${[...byRoute.entries()].map(([key, count]) => `${key}: ${count}`).join("  ·  ")}` +
      `\nInterview add-on: ${INTERVIEW_CREDITS_PER_MANAGER} credits per manager asked.`
  );
  const overrides = process.env.GENERATION_ROUTE_OVERRIDES;
  console.log(overrides ? `Overrides in effect: ${overrides}` : "No GENERATION_ROUTE_OVERRIDES set.");
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

async function dumpBody(
  dir: string,
  result: { fixture: string; contentType: string; persona: string; body: string; violations: unknown[] }
): Promise<void> {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  mkdirSync(dir, { recursive: true });
  const name = `${result.contentType}--${result.persona}--${result.fixture}.md`;
  writeFileSync(`${dir}/${name}`, `${result.body}\n\n<!-- flags: ${JSON.stringify(result.violations)} -->\n`);
}

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
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  modelUsed: string;
  /** The route the service picked for this content type (spec §10.3.1). */
  route: GenerationRoute;
  durationMs: number;
  /** Measured, from `metadata.costUsd`: every call the article took, cache pricing included. */
  costUsd: number;
  sectionsRegenerated: number;
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
  const startedAt = Date.now();

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
    promptTokens: generated.metadata.promptTokens ?? 0,
    completionTokens: generated.metadata.completionTokens ?? 0,
    cacheReadTokens: generated.metadata.cacheReadTokens ?? 0,
    modelUsed: generated.metadata.modelUsed ?? "claude-opus-5",
    route: generated.metadata.route ?? resolveRoute(contentType),
    durationMs: Date.now() - startedAt,
    // The service measures this across the primary call, any fallback, section regeneration and
    // the optional fact-check pass, with cache pricing applied. Never recompute it here.
    costUsd: generated.metadata.costUsd ?? 0,
    sectionsRegenerated: generated.metadata.verifierStats?.sectionsRegenerated ?? 0,
  };
}

/* -------------------------------------------------------------------------- */
/* Live matrix: every content type × its preferred writer, plus every writer   */
/* on weekly_recap. Records tokens and cost so the run doubles as a cost model. */
/* -------------------------------------------------------------------------- */

interface MatrixRow {
  fixture: string;
  persona: string;
  contentType: string;
  status: "ok" | "insufficient_data" | "failed";
  message?: string;
  words?: number;
  promptTokens?: number;
  completionTokens?: number;
  cacheReadTokens?: number;
  modelUsed?: string;
  /** The route the row ran on, so a re-route shows up in the matrix without a code diff. */
  model?: string;
  effort?: string;
  costUsd?: number;
  durationMs?: number;
  blocks?: number;
  strips?: number;
  warns?: number;
  sectionsRegenerated?: number;
  quotesUsed?: number;
  title?: string;
  /** Sonnet 5 persona-adherence rubric, when --rubric was passed. */
  rubric?: string;
  rubricScores?: Record<string, number>;
  /** Every verifier flag on the article (kind, severity, detail, section). */
  flags?: Array<{ kind: string; severity: string; detail: string; section?: string }>;
}

function parseRubricScores(rubric: string): Record<string, number> {
  const scores: Record<string, number> = {};
  for (const match of rubric.matchAll(/(\w+) (\d)\/5/g)) scores[match[1]] = Number(match[2]);
  return scores;
}

const DRAFT_TYPES = new Set(["mock_draft", "draft_rankings", "draft_strategy_guide"]);

function matrixPlan(): Array<{ fixture: string; persona: string; contentType: string }> {
  const plan: Array<{ fixture: string; persona: string; contentType: string }> = [];
  for (const contentType of Object.keys(contentTemplates)) {
    const persona = contentTypePersonaMap[contentType]?.[0] ?? "curtis-vaughn";
    plan.push({ fixture: DRAFT_TYPES.has(contentType) ? "draft-day" : "rich-week", persona, contentType });
  }
  for (const persona of Object.keys(personaPrompts)) {
    if (!personaPrompts[persona].isWriter) continue;
    if (contentTypePersonaMap.weekly_recap?.[0] === persona) continue; // already covered above
    plan.push({ fixture: "rich-week", persona, contentType: "weekly_recap" });
  }
  return plan;
}

async function runMatrix(options: Options): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    failures.push("--matrix needs ANTHROPIC_API_KEY in the environment");
    return;
  }
  const plan = matrixPlan();
  console.log(`\nLive matrix: ${plan.length} generations, concurrency ${options.concurrency}\n`);
  const rows: MatrixRow[] = [];
  let next = 0;

  const worker = async (): Promise<void> => {
    while (next < plan.length) {
      const job = plan[next++];
      const fixture = fixturesByName[job.fixture];
      const label = `${job.contentType} / ${job.persona} / ${job.fixture}`;
      if (!fixture) {
        rows.push({ ...job, status: "failed", message: "fixture missing" });
        continue;
      }
      try {
        const result = await generateOne(fixture, job.persona, job.contentType, apiKey);
        if (options.dump) await dumpBody(options.dump, result);
        const rubric = options.rubric ? await runRubric(result, apiKey) : undefined;
        rows.push({
          ...job,
          status: "ok",
          title: result.body.split("\n").find(line => line.trim().length > 0)?.replace(/^#+\s*/, "").slice(0, 120),
          rubric,
          rubricScores: rubric ? parseRubricScores(rubric) : undefined,
          words: result.words,
          promptTokens: result.promptTokens,
          completionTokens: result.completionTokens,
          cacheReadTokens: result.cacheReadTokens,
          modelUsed: result.modelUsed,
          model: result.route.model,
          effort: result.route.effort,
          costUsd: result.costUsd,
          durationMs: result.durationMs,
          blocks: result.violations.filter(v => v.severity === "block").length,
          strips: result.violations.filter(v => v.severity === "strip").length,
          warns: result.violations.filter(v => v.severity === "warn").length,
          sectionsRegenerated: result.sectionsRegenerated,
          quotesUsed: result.quotes.length,
          flags: result.violations.map(v => ({
            kind: v.kind,
            severity: v.severity,
            detail: v.detail.slice(0, 160),
            section: v.section,
          })),
        });
        console.log(
          `  ok    ${label} [${result.route.model.replace("claude-", "")}/${result.route.effort}]: ` +
            `${result.words} words, ${result.promptTokens} in / ${result.completionTokens} out` +
            `${result.cacheReadTokens ? ` (+${result.cacheReadTokens} cached)` : ""}, ` +
            `$${result.costUsd.toFixed(3)}, ${Math.round(result.durationMs / 1000)}s`
        );
      } catch (error) {
        const message = (error as Error).message;
        if (error instanceof InsufficientDataError) {
          rows.push({ ...job, status: "insufficient_data", message });
          console.log(`  data  ${label}: ${message}`);
        } else {
          rows.push({ ...job, status: "failed", message });
          console.log(`  FAIL  ${label}: ${message}`);
          failures.push(`matrix ${label}: ${message}`);
        }
      }
    }
  };

  await Promise.all(Array.from({ length: options.concurrency }, () => worker()));

  const ok = rows.filter(row => row.status === "ok");
  const totalCost = ok.reduce((sum, row) => sum + (row.costUsd ?? 0), 0);
  console.log("\nMatrix summary\n");
  printTable(
    ["type", "writer", "model", "effort", "words", "in", "cached", "out", "cost", "blocks", "strips", "warns", "regen"],
    rows
      .slice()
      .sort((a, b) => a.contentType.localeCompare(b.contentType))
      .map(row => {
        const route = { model: row.model, effort: row.effort };
        const planned = resolveRoute(row.contentType);
        return [
          row.contentType,
          row.persona,
          (route.model ?? planned.model).replace("claude-", ""),
          route.effort ?? planned.effort,
          row.status === "ok" ? String(row.words) : row.status,
          String(row.promptTokens ?? ""),
          String(row.cacheReadTokens ?? ""),
          String(row.completionTokens ?? ""),
          row.costUsd !== undefined ? `$${row.costUsd.toFixed(3)}` : "",
          String(row.blocks ?? ""),
          String(row.strips ?? ""),
          String(row.warns ?? ""),
          String(row.sectionsRegenerated ?? ""),
        ];
      })
  );
  console.log(
    `\n${ok.length}/${rows.length} generated, total $${totalCost.toFixed(2)}, mean $${(totalCost / Math.max(ok.length, 1)).toFixed(3)} per article`
  );

  // Cost by route: this is the number the §10.3.1 gate is argued from.
  const byRoute = new Map<string, { n: number; usd: number }>();
  for (const row of ok) {
    const key = `${(row.model ?? "?").replace("claude-", "")} / ${row.effort ?? "?"}`;
    const entry = byRoute.get(key) ?? { n: 0, usd: 0 };
    entry.n += 1;
    entry.usd += row.costUsd ?? 0;
    byRoute.set(key, entry);
  }
  console.log("\nCost by route\n");
  printTable(
    ["route", "articles", "total", "mean"],
    [...byRoute.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([key, entry]) => [
        key,
        String(entry.n),
        `$${entry.usd.toFixed(2)}`,
        `$${(entry.usd / Math.max(entry.n, 1)).toFixed(3)}`,
      ])
  );

  if (options.rubric) {
    console.log("\nPersona adherence (Sonnet 5, 1-5), mean per writer\n");
    const byWriter = new Map<string, Record<string, number>[]>();
    for (const row of ok) {
      if (!row.rubricScores) continue;
      byWriter.set(row.persona, [...(byWriter.get(row.persona) ?? []), row.rubricScores]);
    }
    const axes = ["voiceDistinctness", "signatureMoves", "tonalConsistency", "respectsTheFacts"];
    printTable(
      ["writer", "n", ...axes],
      [...byWriter.entries()].map(([persona, scores]) => [
        persona,
        String(scores.length),
        ...axes.map(axis => {
          const values = scores.map(score => score[axis]).filter(value => Number.isFinite(value));
          return values.length ? (values.reduce((a, b) => a + b, 0) / values.length).toFixed(1) : "?";
        }),
      ])
    );
  }

  if (options.out) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      options.out,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          routes: Object.fromEntries(
            Object.keys(contentTemplates).map(type => [type, resolveRoute(type)])
          ),
          rows,
        },
        null,
        2
      )
    );
    console.log(`Wrote ${options.out}`);
  }
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
      const liveResult = await generateOne(fixture, persona, contentType, apiKey);
      results.push(liveResult);
      if (options.dump) await dumpBody(options.dump, liveResult);
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
    ["fixture", "model", "effort", "words", "cost", "attribution", "quote fidelity", "ghosts", "numbers", "sources"],
    results.map(result => [
      result.fixture,
      result.route.model.replace("claude-", ""),
      result.route.effort,
      String(result.words),
      `$${result.costUsd.toFixed(3)}`,
      attributionAccuracy(result),
      quoteFidelity(result),
      String(countKinds(result, ["ghost_speaker"])),
      String(countKinds(result, ["unverified_number"])),
      String(countKinds(result, ["bad_source_path"])),
    ])
  );

  for (const result of results) {
    const flagged = result.violations.filter(v => v.severity !== "warn");
    if (flagged.length === 0 && options.quiet) continue;
    console.log(`\nFlags on ${result.fixture}/${result.contentType}/${result.persona} (${result.violations.length}):`);
    for (const v of result.violations.slice(0, 25)) {
      console.log(`  ${v.severity.padEnd(5)} ${v.kind.padEnd(22)} ${v.section ? `[${v.section}] ` : ""}${v.detail.slice(0, 140)}`);
    }
  }

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

  if (options.route) {
    printRouteTable();
    return;
  }

  runOffline(options);
  if (options.matrix) await runMatrix(options);
  else if (options.live) await runLive(options);

  if (failures.length > 0) {
    console.error(`\n${failures.length} failure(s):`);
    failures.forEach(failure => console.error(`  - ${failure}`));
    process.exitCode = 1;
    return;
  }
  console.log("\nAll eval checks passed.");
}

await main();
