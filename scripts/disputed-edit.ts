/**
 * "Disputed" edit-bay script (spec: edit bay, pass two) — runs the edit bay over an already-produced
 * pilot transcript, against the real Anthropic API, entirely offline otherwise (a JSON dump written
 * by `scripts/disputed-pilot.ts`).
 *
 *   npm run disputed:edit -- --in scripts/eval-runs/disputed/ffl-2025-w8.league-20260903-1714.json
 *   npm run disputed:edit -- --in <path> --league-file league.json --ratio 0.6
 *   npm run disputed:edit -- --help
 *
 * Needs ANTHROPIC_API_KEY in the environment.
 *
 * Mirrors scripts/disputed-pilot.ts's style: vite-node, a dynamic import of the module that pulls in
 * the Anthropic SDK (so --help never loads it), no test framework.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { buildFactsBlock } from "../src/lib/ai/facts";
import type { FactsBlock } from "../src/lib/ai/facts";
import type { CommentResponseData } from "../src/lib/ai/content-generation-service";
import type { LeagueDataContext } from "../src/lib/ai/prompt-builder";
import { countProfanity, mentionRatio } from "../src/lib/ai/language";
import type { ShowStats, ShowTranscript } from "../src/lib/ai/disputed";

interface Options {
  in: string;
  leagueFile?: string;
  ratio: number;
  help: boolean;
}

function parseArgs(argv: string[]): Options {
  // 0.6 matches the edit bay's own DEFAULT_TARGET_RATIO (src/lib/ai/disputed/edit-bay.ts).
  const options: Options = { in: "", ratio: 0.6, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) throw new Error(`${arg} needs a value`);
      i++;
      return next;
    };
    switch (arg) {
      case "--in":
        options.in = value();
        break;
      case "--league-file":
        options.leagueFile = value();
        break;
      case "--ratio":
        options.ratio = Math.min(1, Math.max(0.01, Number(value()) || 0.6));
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

function printUsage(): void {
  console.log(`Usage: npm run disputed:edit -- --in <pilot json> [options]

  --in <path>             Required. A JSON file written by scripts/disputed-pilot.ts: { transcript, stats }.
  --league-file <path>    Optional. Same shape disputed-pilot.ts's own --league-file reads
                          ({ "leagueData": ... }); rebuilds FACTS so the edit-bay guard's verifier
                          check (step e) runs. Without it, the guard still runs every other check —
                          the sourceTurn/locked-turn/no-growth/no-new-facts checks — just not the
                          verifier pass.
  --ratio <0-1>           Target word ratio per segment (default 0.6, the edit bay's own default).
  -h, --help              This message.

Needs ANTHROPIC_API_KEY in the environment. Costs money — this calls the real Anthropic API.

Writes <in without .json>-edited.md and -edited.json next to --in.`);
}

interface PilotFile {
  transcript: ShowTranscript;
  stats: ShowStats;
}

interface LeagueFilePayload {
  leagueData: unknown;
  commentResponses?: unknown[];
}

/** Rebuilds FACTS from a `--league-file` payload, the same way `disputed-pilot.ts`'s own `--league-file` branch does. */
function loadFacts(leagueFilePath: string): FactsBlock {
  const payload = JSON.parse(readFileSync(leagueFilePath, "utf8")) as LeagueFilePayload;
  return buildFactsBlock({
    contentType: "desk_show",
    persona: "curtis-vaughn",
    leagueData: payload.leagueData as LeagueDataContext,
    commentResponses: (payload.commentResponses ?? []) as CommentResponseData[],
    nonRespondents: [],
    relationships: [],
    priorClaims: [],
  });
}

function wordCount(text: string): number {
  const trimmed = text.trim();
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
}

/** Every turn's spoken text, in order, joined into one string — what a listener actually hears. */
function transcriptTextOf(transcript: ShowTranscript): string {
  return transcript.segments.flatMap((segment) => segment.turns.map((turn) => turn.text)).join(" ");
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }
  if (!options.in) {
    console.error("disputed:edit needs --in <pilot json>. Run with --help for usage.");
    process.exitCode = 1;
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("disputed:edit needs ANTHROPIC_API_KEY in the environment.");
    process.exitCode = 1;
    return;
  }

  const pilot = JSON.parse(readFileSync(options.in, "utf8")) as PilotFile;
  const facts = options.leagueFile ? loadFacts(options.leagueFile) : undefined;

  // Loaded only for a real run — never for --help, and never just to build FACTS (src/lib/ai/disputed
  // re-exports anthropic-caller.ts alongside the pure modules, which is the only file here that pulls
  // in the Anthropic SDK).
  const { naturalizeTranscript, createAnthropicEditCaller, renderTranscriptMarkdown } = await import(
    "../src/lib/ai/disputed"
  );

  const languageRating = pilot.transcript.language ?? "clean";
  console.log(
    `Naturalizing "${options.in}" (target ratio ${options.ratio}, language ${languageRating})${facts ? ", verifier on" : ""}…`
  );

  const { transcript, stats } = await naturalizeTranscript(pilot.transcript, {
    call: createAnthropicEditCaller(apiKey),
    targetRatio: options.ratio,
    facts,
    languageRating,
  });

  const markdown = renderTranscriptMarkdown(transcript);

  const base = options.in.replace(/\.json$/, "");
  const mdPath = `${base}-edited.md`;
  const jsonPath = `${base}-edited.json`;

  const segmentLines = pilot.transcript.segments.map((segment) => {
    const before = segment.turns.reduce((sum, turn) => sum + wordCount(turn.text), 0);
    const editedSegment = transcript.segments.find((candidate) => candidate.id === segment.id);
    const after = (editedSegment?.turns ?? []).reduce((sum, turn) => sum + wordCount(turn.text), 0);
    return `- ${segment.title}: ${before} -> ${after} words`;
  });

  const rejectionLines =
    stats.rejections.length === 0
      ? ["No rejections."]
      : [`Rejections (${stats.rejections.length}):`, ...stats.rejections.map((r) => `  - ${r.segment}: ${r.reason}`)];

  const editedTranscriptText = transcriptTextOf(transcript);
  const mentions = mentionRatio(editedTranscriptText, facts?.teams ?? []);
  const profanity = countProfanity(editedTranscriptText, facts?.teams.map((team) => team.name) ?? []);
  const houseStyleLines = [
    `- Team/manager mentions: ${mentions.teamMentions}/${mentions.managerMentions} (ratio ${mentions.ratio === null ? "n/a" : mentions.ratio.toFixed(2)})`,
    `- Profanity: ${profanity.mild} mild / ${profanity.strong} strong`,
  ];

  const footer = [
    "",
    "---",
    "",
    "## Edit Bay",
    "",
    `- Segments edited: ${stats.segmentsEdited}`,
    `- Segments rejected: ${stats.segmentsRejected}`,
    `- Words: ${stats.wordsBefore} -> ${stats.wordsAfter}`,
    `- Prompt tokens: ${stats.promptTokens}`,
    `- Completion tokens: ${stats.completionTokens}`,
    `- Cost: $${stats.costUsd.toFixed(4)}`,
    `- Models used: ${stats.modelsUsed.join(", ") || "none"}`,
    "",
    ...houseStyleLines,
    "",
    "Per segment",
    ...segmentLines,
    "",
    ...rejectionLines,
  ].join("\n");

  writeFileSync(mdPath, `${markdown}\n${footer}\n`);
  writeFileSync(jsonPath, JSON.stringify({ transcript, editStats: stats, rawTranscript: pilot.transcript }, null, 2));

  console.log(`\nWrote ${mdPath}`);
  console.log(`Wrote ${jsonPath}\n`);
  console.log(`Segments edited: ${stats.segmentsEdited}, rejected: ${stats.segmentsRejected}`);
  console.log(`Words: ${stats.wordsBefore} -> ${stats.wordsAfter}`);
  console.log(`Cost: $${stats.costUsd.toFixed(4)}`);
  for (const line of houseStyleLines) console.log(line.replace(/^- /, ""));
  if (stats.rejections.length > 0) {
    console.log(`\n${stats.rejections.length} rejection(s):`);
    for (const r of stats.rejections) console.log(`  ${r.segment}: ${r.reason}`);
  }
}

await main();
