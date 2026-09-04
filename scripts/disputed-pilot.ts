/**
 * "Disputed" pilot script (spec: Disputed) — produces one episode transcript against the real
 * Anthropic API, entirely offline (a frozen eval fixture, or a JSON dump from a deployment).
 *
 *   npm run disputed:pilot                                    # rich-week fixture, budget 10
 *   npm run disputed:pilot -- --fixture sparse-week
 *   npm run disputed:pilot -- --league-file league.json --budget 10 --out /tmp/disputed
 *   npm run disputed:pilot -- --help
 *
 * Needs ANTHROPIC_API_KEY in the environment. This script never touches a Convex deployment —
 * `--dry` is implied and is the only mode there is here. `convex/disputedNode.ts`'s own `dryRun`
 * argument is the flag that gates a real deployment write; this script never calls that action.
 *
 * Mirrors scripts/eval-articles.ts's style: vite-node, a dynamic import of the module that pulls
 * in the Anthropic SDK (so `--help` never loads it), no test framework.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fixturesByName, factsRequestFor } from "../src/lib/ai/__fixtures__";
import { buildFactsBlock, serializeFacts, type FactsBlock } from "../src/lib/ai/facts";
import { effectiveLanguageRange, personaPrompts } from "../src/lib/ai/persona-prompts";
import { countProfanity, mentionRatio, type LanguageRating } from "../src/lib/ai/language";
import type {
  CommentResponseData,
  WriterRelationshipContext,
} from "../src/lib/ai/content-generation-service";
import type { LeagueDataContext } from "../src/lib/ai/prompt-builder";
import type { ShowBrief, ShowTranscript } from "../src/lib/ai/disputed";

/**
 * The seven writer slugs (mirrors `ACTIVE_WRITERS` in convex/relationships.ts, which this plain
 * script does not import — that module pulls in Convex's generated server types). Same derivation
 * scripts/eval-articles.ts already uses for its own local `ACTIVE_WRITERS`.
 */
const ACTIVE_WRITERS = Object.values(personaPrompts)
  .filter((persona) => persona.isWriter)
  .map((persona) => persona.slug);

interface Options {
  fixture: string;
  leagueFile?: string;
  /** Main-event debater turns. Unset means the producer's own default (DEFAULT_BUDGETS.mainEvent). */
  budget?: number;
  out: string;
  help: boolean;
  language: LanguageRating;
  cleanTeams: string[];
}

const VALID_LANGUAGE_RATINGS: LanguageRating[] = ["clean", "salty", "unfiltered"];

function parseArgs(argv: string[]): Options {
  const options: Options = {
    fixture: "rich-week",
    out: "scripts/eval-runs/disputed/",
    help: false,
    language: "clean",
    cleanTeams: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) throw new Error(`${arg} needs a value`);
      i++;
      return next;
    };
    switch (arg) {
      case "--fixture":
        options.fixture = value();
        break;
      case "--league-file":
        options.leagueFile = value();
        break;
      case "--budget":
        options.budget = Math.max(1, Number(value()) || 8);
        break;
      case "--out":
        options.out = value();
        break;
      case "--language": {
        const language = value();
        if (!(VALID_LANGUAGE_RATINGS as string[]).includes(language)) {
          throw new Error(`--language must be one of ${VALID_LANGUAGE_RATINGS.join(", ")}, got "${language}"`);
        }
        options.language = language as LanguageRating;
        break;
      }
      case "--clean-team":
        options.cleanTeams.push(value());
        break;
      case "--dry":
        // Implied — this script never writes to a Convex deployment. Accepted so a copy-pasted
        // invocation of convex/disputedNode.ts's own flag doesn't blow up here.
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error(`Unknown flag: ${arg}. Run with --help for usage.`);
    }
  }
  return options;
}

/** "mel-diaper 5/4-12, reggie-banks 2/3-10 UNDER, curtis-vaughn 1/0-1" — used/floor-ceiling for every speaker who swore, plus every carrier (FLAT when none). */
function profanityBySpeakerLine(bySpeaker: Record<string, number>, rating: LanguageRating, seed: string): string {
  if (rating === "clean") return Object.keys(bySpeaker).length === 0 ? "none (clean)" : Object.entries(bySpeaker).map(([slug, n]) => `${slug} ${n} (must be clean)`).join(", ");
  const slugs = new Set<string>(Object.keys(bySpeaker));
  for (const slug of Object.keys(personaPrompts)) {
    if (personaPrompts[slug].language.allowance[rating] >= 4) slugs.add(slug);
  }
  const parts = [...slugs].sort().map((slug) => {
    const persona = personaPrompts[slug];
    const range = persona ? effectiveLanguageRange(persona, rating, seed) : { floor: 0, ceiling: 0 };
    const used = bySpeaker[slug] ?? 0;
    const flag =
      range.ceiling >= 4 && used === 0 ? " FLAT" : used > range.ceiling ? " OVER" : used < range.floor ? " UNDER" : "";
    return `${slug} ${used}/${range.floor}-${range.ceiling}${flag}`;
  });
  return parts.length === 0 ? "none" : parts.join(", ");
}

function printUsage(): void {
  console.log(`Usage: npm run disputed:pilot -- [options]

  --fixture <name>       Frozen eval fixture to build FACTS from (default: rich-week).
                          One of: ${Object.keys(fixturesByName).join(", ")}
  --league-file <path>   JSON file, instead of a fixture:
                          { "leagueData": ..., "relationshipsByWriter": { "mel-diaper": [...], ... },
                            "commentResponses": [...], "ledger": { "mel-diaper": {"hits":n,"misses":n}, ... } }
                          Only "leagueData" is required; everything else defaults to empty.
  --budget <n>            Main-event debater turns (default: the producer's own, currently 8).
  --out <dir>             Where to write the transcript + stats (default scripts/eval-runs/disputed/).
  --language <rating>     League-level language rating: clean, salty, or unfiltered (default clean).
  --clean-team <name>     A team whose manager opted down to clean coverage. Repeatable.
  --dry                   Implied — accepted for symmetry with convex/disputedNode.ts's own flag.
  -h, --help              This message.

Needs ANTHROPIC_API_KEY in the environment. Costs money — this calls the real Anthropic API.

To build --league-file from a real deployment:

  npx convex run --prod aiContent:getLeagueDataForGenerationInternal '{"leagueId":"<id>"}'
    -> save the result as the "leagueData" field.

  # Once per ACTIVE_WRITERS slug (curtis-vaughn, sam-ortega, nina-sharpe, dex-alvarez, mel-diaper,
  # reggie-banks, walt-brennan):
  npx convex run --prod relationships:getRelationshipsForWriter '{"leagueId":"<id>","persona":"mel-diaper"}'
    -> save each result under "relationshipsByWriter.<slug>".

  Assemble both into one JSON file and pass it with --league-file.`);
}

interface LeagueFilePayload {
  leagueData: unknown;
  relationshipsByWriter?: Record<string, WriterRelationshipContext[]>;
  commentResponses?: unknown[];
  ledger?: ShowBrief["ledger"];
}

const EMPTY_LEDGER: ShowBrief["ledger"] = {
  "mel-diaper": { hits: 0, misses: 0 },
  "reggie-banks": { hits: 0, misses: 0 },
};

/**
 * FACTS + the relationship ledger for the episode, from either source. `factsRequestFor` (the
 * eval harness's own helper) does not validate `contentType` against any list — it is a plain
 * string field on the request object — so this passes "desk_show" straight through rather than
 * borrowing "weekly_recap"; `buildFactsBlock`'s `computeMissingRequiredData` is driven by the
 * template's own `requiredData` array, and `desk_show`'s two entries ("standings",
 * "matchup_results") already have generic handlers there.
 */
function loadFactsAndRelationships(options: Options): {
  facts: FactsBlock;
  relationshipsByWriter: Record<string, WriterRelationshipContext[]>;
  ledger: ShowBrief["ledger"];
} {
  if (options.leagueFile) {
    const payload = JSON.parse(readFileSync(options.leagueFile, "utf8")) as LeagueFilePayload;
    const facts = buildFactsBlock({
      contentType: "desk_show",
      persona: "curtis-vaughn",
      leagueData: payload.leagueData as LeagueDataContext,
      commentResponses: (payload.commentResponses ?? []) as CommentResponseData[],
      nonRespondents: [],
      relationships: [],
      priorClaims: [],
    });
    return {
      facts,
      relationshipsByWriter: payload.relationshipsByWriter ?? {},
      ledger: payload.ledger ?? EMPTY_LEDGER,
    };
  }

  const fixture = fixturesByName[options.fixture];
  if (!fixture) {
    throw new Error(
      `--fixture ${options.fixture} is not a fixture. One of: ${Object.keys(fixturesByName).join(", ")}`
    );
  }

  const facts = buildFactsBlock(factsRequestFor(fixture, "desk_show"));

  // The fixture carries one flat relationship list (no per-writer map — spec: EvalFixture), so it
  // goes to Mel; every other writer gets an empty list, same as the brief's contingency for a
  // fixture with no per-writer breakdown.
  const relationshipsByWriter: Record<string, WriterRelationshipContext[]> = {};
  for (const slug of ACTIVE_WRITERS) relationshipsByWriter[slug] = [];
  relationshipsByWriter["mel-diaper"] = fixture.relationships;

  return { facts, relationshipsByWriter, ledger: EMPTY_LEDGER };
}

/** "20260903-1430" — sortable, filesystem-safe. */
function timestamp(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  // Seconds included: two pilots launched side by side (salty + unfiltered, 2026-09-03) landed in the
  // same minute and the second overwrote the first.
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

/** Every turn's spoken text, in order, joined into one string — what a listener actually hears. */
function transcriptTextOf(transcript: ShowTranscript): string {
  return transcript.segments.flatMap((segment) => segment.turns.map((turn) => turn.text)).join(" ");
}

function labelFor(options: Options): string {
  if (options.leagueFile) {
    return (options.leagueFile.split("/").pop() ?? options.leagueFile).replace(/\.json$/, "");
  }
  return options.fixture;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("disputed:pilot needs ANTHROPIC_API_KEY in the environment.");
    process.exitCode = 1;
    return;
  }

  const { facts, relationshipsByWriter, ledger } = loadFactsAndRelationships(options);
  const factsText = serializeFacts(facts);

  // Everything below touches the Anthropic SDK transitively (src/lib/ai/disputed re-exports
  // anthropic-caller.ts alongside the pure modules), so it is loaded only once a real run is
  // actually happening — never for --help, and never just to build FACTS.
  const { chooseHotSeat, fallbackQuestionFor, produceEpisode, createAnthropicTurnCaller, renderTranscriptMarkdown } =
    await import("../src/lib/ai/disputed");

  const hotSeat = chooseHotSeat(facts, relationshipsByWriter);
  if (!hotSeat) {
    console.error(
      "Disputed needs standings and matchups to build an episode — this fixture/league-file has neither."
    );
    process.exitCode = 1;
    return;
  }

  const brief: ShowBrief = {
    week: facts.league.week,
    hotSeat,
    fallbackQuestion: fallbackQuestionFor(hotSeat),
    ledger,
    languageRating: options.language,
    cleanTeamNames: options.cleanTeams,
  };

  const label = labelFor(options);
  console.log(`Producing Disputed for "${label}" (main-event budget ${options.budget ?? "producer default"})…`);
  console.log(`Hot seat: ${hotSeat.managerName} — ${hotSeat.why}`);

  const result = await produceEpisode({
    facts,
    factsText,
    brief,
    relationshipsByWriter,
    call: createAnthropicTurnCaller(apiKey),
    options: options.budget !== undefined ? { budgets: { mainEvent: options.budget } } : undefined,
  });

  const markdown = renderTranscriptMarkdown(result.transcript);
  const stats = result.stats;

  const statsLines = [
    `- Turns: ${stats.turns}`,
    `- Witness calls: ${stats.witnessCalls}`,
    `- Redirects: ${stats.redirects}`,
    `- Retries: ${stats.retries}`,
    `- Dropped: ${stats.dropped}`,
    `- Agreements: ${stats.agreements}`,
    `- Prompt tokens: ${stats.promptTokens}`,
    `- Completion tokens: ${stats.completionTokens}`,
    `- Cost: $${stats.costUsd.toFixed(4)}`,
    `- Models used: ${stats.modelsUsed.join(", ") || "none"}`,
  ];
  const violationLines =
    stats.violations.length === 0
      ? ["No violations."]
      : [
          `Violations (${stats.violations.length}):`,
          ...stats.violations.map((v) => `  - [${v.severity}] ${v.speaker} ${v.kind}: ${v.detail}`),
        ];

  const transcriptText = transcriptTextOf(result.transcript);
  const mentions = mentionRatio(transcriptText, facts.teams);
  const profanity = countProfanity(transcriptText, facts.teams.map((team) => team.name));
  const houseStyleLines = [
    `- Team/manager mentions: ${mentions.teamMentions}/${mentions.managerMentions} (ratio ${mentions.ratio === null ? "n/a" : mentions.ratio.toFixed(2)})`,
    `- Profanity: ${profanity.mild} mild / ${profanity.strong} strong`,
    `- Profanity by speaker (in tier, vs allowance at ${brief.languageRating ?? "clean"}): ${profanityBySpeakerLine(stats.profanityBySpeaker, brief.languageRating ?? "clean", `w${brief.week}`)}`,
  ];

  const statsFooter = [
    "",
    "---",
    "",
    "## Stats",
    "",
    ...statsLines,
    "",
    ...houseStyleLines,
    "",
    ...violationLines,
  ].join("\n");

  const outDir = options.out.replace(/\/$/, "");
  mkdirSync(outDir, { recursive: true });
  const base = `${label}-${timestamp()}`;
  const mdPath = `${outDir}/${base}.md`;
  const jsonPath = `${outDir}/${base}.json`;

  writeFileSync(mdPath, `${markdown}\n${statsFooter}\n`);
  writeFileSync(jsonPath, JSON.stringify({ transcript: result.transcript, stats }, null, 2));

  console.log(`\nWrote ${mdPath}`);
  console.log(`Wrote ${jsonPath}\n`);
  console.log("Stats");
  for (const line of statsLines) console.log(`  ${line.replace(/^- /, "")}`);
  for (const line of houseStyleLines) console.log(`  ${line.replace(/^- /, "")}`);
  if (stats.violations.length > 0) {
    console.log(`\n${stats.violations.length} violation(s):`);
    for (const v of stats.violations) {
      console.log(`  ${v.severity.padEnd(5)} ${v.speaker.padEnd(14)} ${v.kind.padEnd(20)} ${v.detail.slice(0, 120)}`);
    }
  }
}

await main();
