/**
 * Interview harness: the LIVE half of the "reach out for comment" test rig (spec §5).
 *
 * Runs Sam Ortega's real interview flow - opener, a simulated manager reply, the analysis, the
 * continuation gate, the one follow-up, a second reply, the close - against a file of contexts
 * built from real league data, and applies the deterministic checks in
 * `src/lib/ai/interview-checks.ts` plus a Sonnet 5 judge to every question Sam asks.
 *
 *   npx vite-node scripts/interview-harness.ts --contexts <file.json> --out <results.json> --dump <dir>
 *       [--limit N] [--concurrency 3] [--personas terse,complete,...] [--seed 7] [--dry]
 *   npx vite-node scripts/interview-harness.ts --demo --dry --out demo.json --dump demo/    # no API key
 *   npx vite-node scripts/interview-harness.ts --demo --limit 1 --out demo.json --dump demo/  # a few cents
 *
 * INPUT  `--contexts` is either a JSON array of `{ id, label, scenario, context }` or the
 *        `{ summary, results }` file `tests/interviewContextHarness.test.ts` writes (each result
 *        carries the same four fields). `--demo` uses the fixture from `scripts/measure-interview.ts`
 *        instead, once per selected persona.
 * FLOW   Mirrors `convex/commentConversations.ts`: `processUserResponse` analyzes the reply and
 *        `evaluateConversationContinuation` continues iff this is the first reply and
 *        offTopicScore < 50; `generateAIFollowUp` records a decline when Sam says so, otherwise
 *        stores her follow-up or closing. After the second reply the gate closes.
 * MODELS Questions and analysis run through `conversationService` exactly as in production
 *        (Opus 5 questions, Sonnet 5 analysis). The simulated manager and the judge are Sonnet 5.
 *        `--dry` swaps every model for canned text so the pipeline and checks run offline.
 *
 * Needs ANTHROPIC_API_KEY (read from .env.local when not already set). Never part of `npm test`.
 * Never deploys or touches a Convex deployment.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import {
  buildClosingMessage,
  conversationService,
  managerFirstName,
  shouldUseTemplatedClose,
  type AIConversationResult,
  type ConversationContext,
  type InterviewUsage,
  type ResponseAnalysisResult,
} from "../src/lib/ai/conversation-service";
import { computeCostUsd } from "../src/lib/ai/content-generation-service";
import { looksLikeDecline } from "../convex/lib/declineDetection";
import {
  auditQuestion,
  checkDecline,
  checkFollowUpRedundancy,
  checkQuestionGrounding,
  checkQuestionShape,
  checkQuotes,
  factBlockFor,
  isDeclineReply,
  type Finding,
  type QuestionAudit,
} from "../src/lib/ai/interview-checks";

/* -------------------------------------------------------------------------- */
/* CLI                                                                         */
/* -------------------------------------------------------------------------- */

const PERSONAS = ["terse", "complete", "rant", "decline", "offtopic", "correction", "jab", "question_back"] as const;
type Persona = (typeof PERSONAS)[number];

const SIMULATOR_MODEL = "claude-sonnet-5";
const JUDGE_MODEL = "claude-sonnet-5";

interface Options {
  contexts?: string;
  out?: string;
  dump?: string;
  limit?: number;
  concurrency: number;
  personas: Persona[];
  seed: number;
  dry: boolean;
  demo: boolean;
  quiet: boolean;
}

function parseArgs(argv: string[]): Options {
  const options: Options = { concurrency: 3, personas: [...PERSONAS], seed: 7, dry: false, demo: false, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) throw new Error(`${arg} needs a value`);
      i++;
      return next;
    };
    switch (arg) {
      case "--contexts":
        options.contexts = value();
        break;
      case "--out":
        options.out = value();
        break;
      case "--dump":
        options.dump = value();
        break;
      case "--limit":
        options.limit = Math.max(1, Number(value()) || 1);
        break;
      case "--concurrency":
        options.concurrency = Math.max(1, Number(value()) || 1);
        break;
      case "--personas": {
        const chosen = value().split(",").map((p) => p.trim()).filter(Boolean);
        for (const p of chosen) {
          if (!(PERSONAS as readonly string[]).includes(p)) throw new Error(`Unknown persona "${p}". Choose from ${PERSONAS.join(", ")}`);
        }
        options.personas = chosen as Persona[];
        break;
      }
      case "--seed":
        options.seed = Number(value()) || 0;
        break;
      case "--dry":
        options.dry = true;
        break;
      case "--demo":
        options.demo = true;
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
  if (!options.contexts && !options.demo) throw new Error("Pass --contexts <file.json> or --demo");
  return options;
}

function printUsage(): void {
  console.log(`Usage: npx vite-node scripts/interview-harness.ts [options]

  --contexts <file>    JSON array of { id, label, scenario, context }, or the { summary, results }
                       file tests/interviewContextHarness.test.ts writes.
  --demo               Use the scripts/measure-interview.ts fixture instead, once per persona.
  --out <path>         Write results (turns, findings, judge verdicts, cost) as JSON.
  --dump <dir>         Write one reviewer-facing markdown file per interview.
  --limit <n>          Only run the first n contexts.
  --concurrency <n>    Interviews in flight at once (default 3). Each interview's calls are sequential.
  --personas <list>    Comma-separated reply personas to rotate through (default all):
                       ${PERSONAS.join(", ")}
  --seed <n>           Seed for the persona rotation (default 7).
  --dry                Canned models: no API key, no network, no cost.
  --quiet              Only print the final table.
  -h, --help           This message.`);
}

/* -------------------------------------------------------------------------- */
/* Environment                                                                 */
/* -------------------------------------------------------------------------- */

/** Loads ANTHROPIC_API_KEY (and nothing else) from .env.local when the environment lacks it. */
function loadApiKey(): string | undefined {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  const envPath = path.resolve(process.cwd(), ".env.local");
  if (!existsSync(envPath)) return undefined;
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?ANTHROPIC_API_KEY\s*=\s*(.*)\s*$/);
    if (!match) continue;
    const raw = match[1].trim();
    const unquoted = raw.replace(/^(['"])(.*)\1$/, "$2");
    if (unquoted) {
      process.env.ANTHROPIC_API_KEY = unquoted;
      return unquoted;
    }
  }
  return undefined;
}

/* -------------------------------------------------------------------------- */
/* Input                                                                       */
/* -------------------------------------------------------------------------- */

interface InterviewInput {
  id: string;
  label: string;
  scenario: Record<string, unknown>;
  context: ConversationContext;
  /** Optional: pin a persona instead of taking one from the rotation. */
  persona?: Persona;
}

function loadContexts(file: string): InterviewInput[] {
  const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
  const rows: unknown[] = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { results?: unknown[] }).results)
      ? (parsed as { results: unknown[] }).results
      : [];
  if (rows.length === 0) throw new Error(`${file}: expected a JSON array or a { results: [...] } object with at least one entry`);
  return rows.map((row, index) => {
    const entry = row as Partial<InterviewInput>;
    if (!entry.context || !entry.context.teamPerformance || !entry.context.leagueContext) {
      throw new Error(`${file}: entry ${index} (${entry.id ?? "no id"}) has no usable context`);
    }
    return {
      id: String(entry.id ?? `ctx-${index}`),
      label: String(entry.label ?? entry.id ?? `context ${index}`),
      scenario: (entry.scenario ?? {}) as Record<string, unknown>,
      context: entry.context,
      persona: entry.persona,
    };
  });
}

/** The fixture from scripts/measure-interview.ts (kept in step by hand; that script has no export). */
function demoContext(): ConversationContext {
  return {
    userId: "user_measure",
    leagueId: "league_measure",
    scheduledContentId: undefined,
    contentType: "weekly_recap",
    week: 7,
    seasonId: 2026,
    managerName: "Priya Rao",
    teamName: "Sunday Scaries",
    interviewerPersona: "sam-ortega",
    writerPersona: "mel-diaper",
    opponentName: "Kittle Me This",
    opponentScore: 118.4,
    margin: 5.5,
    benchPoints: 31.2,
    topBenchPlayer: { player: "Jaylen Waddle", position: "WR", points: 22.6, projectedPoints: 14.1 },
    lineupDecisions: [
      {
        benchedPlayer: "Jaylen Waddle",
        benchedPoints: 22.6,
        startedPlayer: "Rome Odunze",
        startedPoints: 6.4,
        position: "WR",
        pointGain: 16.2,
      },
    ],
    transactionsThisWeek: [
      { type: "waiver", playersAdded: ["Tyjae Spears"], playersDropped: ["Rico Dowdle"], bidAmount: 17 },
    ],
    teamPerformance: {
      teamId: "T2",
      teamName: "Sunday Scaries",
      score: 112.9,
      projectedScore: 121.3,
      won: false,
      underperformers: [{ player: "Rome Odunze", position: "WR", expectedPts: 13.2, actualPts: 6.4 }],
      overperformers: [{ player: "Bijan Robinson", position: "RB", expectedPts: 18.6, actualPts: 27.9 }],
    },
    leagueContext: {
      standings: [
        { teamId: "T1", teamName: "Kittle Me This", rank: 2, record: "5-2" },
        { teamId: "T2", teamName: "Sunday Scaries", rank: 6, record: "4-3" },
      ],
    },
    writerContext: {
      persona: "mel-diaper",
      name: "Mel Diaper",
      relationship: { score: -22, tier: "cold" },
      recentMentions: [
        {
          week: 6,
          stance: "roast",
          evidence: "Priya Rao paid nineteen picks of air for Jalen Hurts and is still paying.",
          articleTitle: "Draft Grades: Receipts Edition",
        },
      ],
    },
    conversationHistory: [],
  };
}

function demoInputs(personas: Persona[]): InterviewInput[] {
  return personas.map((persona) => ({
    id: `demo-${persona}`,
    label: `demo · weekly_recap wk 7 · Sunday Scaries · ${persona}`,
    scenario: { source: "scripts/measure-interview.ts fixture", contentType: "weekly_recap", week: 7 },
    context: demoContext(),
    persona,
  }));
}

/** mulberry32: a tiny seeded PRNG so a persona rotation is reproducible from --seed. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function assignPersonas(inputs: InterviewInput[], personas: Persona[], seed: number): Array<InterviewInput & { persona: Persona }> {
  const random = seededRandom(seed);
  const start = Math.floor(random() * personas.length);
  return inputs.map((input, index) => ({
    ...input,
    persona: input.persona ?? personas[(start + index) % personas.length],
  }));
}

/* -------------------------------------------------------------------------- */
/* Records                                                                     */
/* -------------------------------------------------------------------------- */

type TurnKind = "opener" | "reply" | "follow_up" | "closing" | "templated_close";

interface Turn {
  index: number;
  role: "sam" | "manager";
  kind: TurnKind;
  text: string;
  source: "model" | "simulated" | "template" | "canned";
  intent?: AIConversationResult["intent"];
  confidence?: number;
  contextualReasons?: string[];
  shouldEndAfterResponse?: boolean;
  shouldRecordDecline?: boolean;
  detectedAbuse?: AIConversationResult["detectedAbuse"];
  /** On a manager turn: what `analyzeUserResponse` made of it. */
  analysis?: {
    quotableSegments: string[];
    writerSentiment: ResponseAnalysisResult["writerSentiment"];
    sentiment: ResponseAnalysisResult["sentiment"];
    offTopicScore: number;
    responseQuality: number;
    completeness: number;
    needsFollowUp: boolean;
    relevantTopics: string[];
    usage?: InterviewUsage;
    costUsd: number;
  };
  /** On a Sam turn: every number/name/vocabulary item the grounding check looked at. */
  audit?: QuestionAudit;
  usage?: InterviewUsage;
  costUsd: number;
}

interface JudgeVerdict {
  inventedFact: boolean;
  inventedFactDetail: string;
  redundant: boolean;
  redundantDetail: string;
  toneOk: boolean;
  oneQuestion: boolean;
}

interface JudgeRecord {
  turn: number;
  kind: "opener" | "follow_up";
  verdict: JudgeVerdict;
  usage?: InterviewUsage;
  costUsd: number;
}

type Outcome = "followed_up" | "closed_by_model" | "declined" | "ended_off_topic" | "error";

interface InterviewResult {
  id: string;
  label: string;
  scenario: Record<string, unknown>;
  persona: Persona;
  outcome: Outcome;
  continuation: { shouldContinue: boolean; offTopicScore: number; reason: string };
  turns: Turn[];
  findings: Array<Finding & { turn: number; stage: string }>;
  judge: JudgeRecord[];
  costUsd: number;
  durationMs: number;
  error?: string;
}

interface Summary {
  interviews: number;
  blocks: number;
  warns: number;
  infos: number;
  byCode: Record<string, number>;
  byPersona: Record<string, { interviews: number; blocks: number; warns: number; costUsd: number; outcomes: Record<string, number> }>;
  byOutcome: Record<string, number>;
  judge: { questions: number; inventedFacts: number; redundant: number; toneProblems: number; multiQuestion: number };
  totalCostUsd: number;
}

/* -------------------------------------------------------------------------- */
/* Engines                                                                     */
/* -------------------------------------------------------------------------- */

interface Spend {
  usage?: InterviewUsage;
  costUsd: number;
}

interface TranscriptLine {
  speaker: "Sam" | "Manager";
  text: string;
}

interface Engine {
  question(context: ConversationContext, hint: { persona: Persona }): Promise<AIConversationResult>;
  analyze(reply: string, context: ConversationContext, hint: { persona: Persona }): Promise<ResponseAnalysisResult>;
  simulate(persona: Persona, context: ConversationContext, transcript: TranscriptLine[], replyNumber: 1 | 2): Promise<{ text: string } & Spend>;
  judge(input: { context: ConversationContext; transcript: TranscriptLine[]; question: string; kind: "opener" | "follow_up" }): Promise<{ verdict: JudgeVerdict } & Spend>;
}

function spendOf(message: Anthropic.Message): Spend {
  if (!message.usage) return { costUsd: 0 };
  return {
    usage: {
      model: message.model,
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
      cacheReadTokens: message.usage.cache_read_input_tokens || 0,
      cacheCreationTokens: message.usage.cache_creation_input_tokens || 0,
    },
    costUsd: computeCostUsd(message.model, message.usage),
  };
}

/** Retries 529/overloaded (and 429) with jittered backoff, the way conversation-service does. */
async function withRetry<T>(label: string, call: () => Promise<T>): Promise<T> {
  const maxRetries = 3;
  const baseDelay = 1000;
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await call();
    } catch (error) {
      lastError = error as Error;
      const status = error instanceof Anthropic.APIError ? error.status : undefined;
      const errorObj = error as { name?: string; type?: string };
      const overloaded = status === 529 || status === 429 || errorObj.name === "OverloadedError" || errorObj.type === "overloaded_error";
      if (overloaded && attempt < maxRetries) {
        const delay = baseDelay * Math.pow(2, attempt) + Math.random() * 1000;
        console.warn(`${label}: overloaded (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${Math.round(delay)}ms`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      throw error;
    }
  }
  throw lastError ?? new Error(`${label} failed`);
}

const PERSONA_INSTRUCTIONS: Record<Persona, string> = {
  terse: "Answer in one short sentence. No elaboration, no second sentence.",
  complete:
    "Answer everything Sam could possibly ask about this in 3-4 sentences: what you did, why, how you feel about it, and what you'd do differently. Leave nothing for a follow-up question.",
  rant: "You are angry about the result. Blame your players by name (only players named in CONTEXT). 2-3 sentences. Mild language only: nothing stronger than 'damn' or 'hell'.",
  decline: "Politely decline to comment: say something like 'No comment' or that you'd rather not get into it today. One sentence. Do not answer the question.",
  offtopic:
    "Ignore the question entirely. Talk about something unrelated - weekend plans, a recipe, your kid's soccer game. 1-2 sentences. Do not mention fantasy football, your team or any player.",
  correction:
    "Politely correct one specific thing Sam stated in her question - a number, a player, or the reason she implied - claiming it was different, and give your version in 1-2 sentences. Stay civil.",
  jab: "Take a shot at the writer named in CONTEXT, by name: dismissive or mocking, never hateful. Then answer the question briefly. 2 sentences total.",
  question_back: "Do not answer. Instead ask Sam what she thinks about the decision, in 1-2 sentences.",
};

function transcriptText(transcript: TranscriptLine[]): string {
  return transcript.map((line) => `${line.speaker}: ${line.text}`).join("\n") || "(nothing yet)";
}

class LiveEngine implements Engine {
  private readonly client: Anthropic;

  constructor(private readonly apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  question(context: ConversationContext): Promise<AIConversationResult> {
    return conversationService.generateConversationQuestion(context, this.apiKey);
  }

  analyze(reply: string, context: ConversationContext): Promise<ResponseAnalysisResult> {
    return conversationService.analyzeUserResponse(reply, context, this.apiKey);
  }

  async simulate(persona: Persona, context: ConversationContext, transcript: TranscriptLine[], replyNumber: 1 | 2): Promise<{ text: string } & Spend> {
    const manager = context.managerName ?? "the manager";
    const team = context.teamName ?? context.teamPerformance.teamName;
    const system = `You are role-playing ${manager}, manager of the fantasy football team "${team}", replying by text message to Sam Ortega, an FFSN sideline reporter collecting a quick on-the-record comment before a story runs.

Reply in the first person as ${manager}. Plain text only: no quotation marks around the reply, no stage directions, no preamble. At most 80 words. You may add your own reasoning and feelings, but do not invent statistics - the only facts available are in CONTEXT.

Absolutely forbidden: slurs, hate speech, harassment, threats, or anything targeting a protected group. Mild language only (nothing stronger than "damn" or "hell").

REPLY STYLE: ${PERSONA_INSTRUCTIONS[persona]}${replyNumber === 2 ? " This is your second reply in the same conversation; stay in the same style and do not repeat yourself." : ""}`;
    const user = `CONTEXT (what the reporter knows about you)
${factBlockFor(context)}

TRANSCRIPT SO FAR
${transcriptText(transcript)}

Write your reply to Sam's latest message.`;
    const message = await withRetry(`simulate ${persona}`, () =>
      this.client.messages.create({
        model: SIMULATOR_MODEL,
        max_tokens: 400,
        output_config: { effort: "low" },
        system,
        messages: [{ role: "user", content: user }],
      })
    );
    const text = message.content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("")
      .trim()
      .replace(/^["“]|["”]$/g, "");
    if (!text) throw new Error(`simulated ${persona} reply came back empty (stop_reason ${message.stop_reason})`);
    return { text, ...spendOf(message) };
  }

  async judge(input: { context: ConversationContext; transcript: TranscriptLine[]; question: string; kind: "opener" | "follow_up" }): Promise<{ verdict: JudgeVerdict } & Spend> {
    const system = `You audit an AI sideline reporter's interview questions against the facts she was given. The reporter is Simone "Sam" Ortega of FFSN; her introducing herself by name and outlet, and saying the conversation is on the record, are never invented facts. Anything the manager said earlier in the transcript may be quoted back and is not invented either. Be strict and literal about everything else. A fact is invented if it is stated or presupposed in the question but is not in CONTEXT or the manager's own replies and cannot be derived from CONTEXT by simple arithmetic; a player's NFL team, injury status, rookie status, bye week or any speculation about other managers counts as invented unless CONTEXT says so. Paraphrase of a CONTEXT fact is fine. Tone is OK when the question is brisk, warm and neutral: no advice, no judgement of the decision, no jokes at the manager's expense, no exclamation points. Always answer with the judge_question tool.`;
    const user = `CONTEXT (the only facts the reporter may state)
${factBlockFor(input.context)}

TRANSCRIPT SO FAR
${transcriptText(input.transcript)}

QUESTION UNDER TEST (${input.kind === "opener" ? "the opener" : "the follow-up"})
${input.question}

${input.kind === "opener"
  ? "This is the opener, so redundant is always false."
  : "For redundant: does the follow-up re-ask something the manager already answered explicitly, or restate the opener's facts instead of digging into something the manager actually said?"}`;
    const message = await withRetry(`judge ${input.kind}`, () =>
      this.client.messages.create({
        model: JUDGE_MODEL,
        max_tokens: 600,
        output_config: { effort: "low" },
        system,
        messages: [{ role: "user", content: user }],
        tools: [
          {
            name: "judge_question",
            description: "Record the verdict on one interview question",
            strict: true,
            input_schema: {
              type: "object",
              additionalProperties: false,
              properties: {
                inventedFact: { type: "boolean", description: "True if the question states or presupposes a fact that is not in CONTEXT" },
                inventedFactDetail: { type: "string", description: "The invented fact, quoted. Write \"none\" when inventedFact is false" },
                redundant: { type: "boolean", description: "Follow-up only: re-asks something already answered or restates the opener. Always false for the opener" },
                redundantDetail: { type: "string", description: "What it re-asks or restates. Write \"none\" when redundant is false" },
                toneOk: { type: "boolean", description: "Brisk, warm, neutral; no advice, judgement or jokes at the manager's expense" },
                oneQuestion: { type: "boolean", description: "Exactly one question is asked" },
              },
              required: ["inventedFact", "inventedFactDetail", "redundant", "redundantDetail", "toneOk", "oneQuestion"],
            },
          },
        ],
        tool_choice: { type: "tool", name: "judge_question" },
      })
    );
    const toolUse = message.content.find((block) => block.type === "tool_use");
    if (!toolUse || toolUse.type !== "tool_use") throw new Error(`judge returned no tool call (stop_reason ${message.stop_reason})`);
    const raw = toolUse.input as Partial<Record<keyof JudgeVerdict, unknown>>;
    const verdict: JudgeVerdict = {
      inventedFact: raw.inventedFact === true,
      inventedFactDetail: cleanJudgeText(raw.inventedFactDetail),
      redundant: input.kind === "follow_up" && raw.redundant === true,
      redundantDetail: cleanJudgeText(raw.redundantDetail),
      toneOk: raw.toneOk !== false,
      oneQuestion: raw.oneQuestion !== false,
    };
    return { verdict, ...spendOf(message) };
  }
}

/**
 * Sonnet occasionally leaks tool-call tag fragments into an empty string field
 * (`</antml parameter>\n<parameter name="redundant">false`). Strip them, and read "none" as empty.
 */
function cleanJudgeText(value: unknown): string {
  if (typeof value !== "string") return "";
  const cleaned = value
    .replace(/<\/?(?:antml[:\w-]*|parameter|invoke|function_calls)\b[^>]*>/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return /^(none|n\/a|null|true|false|-)?$/i.test(cleaned) ? "" : cleaned;
}

function fmt(n: number | undefined, digits = 1): string {
  if (n === undefined || Number.isNaN(n)) return "";
  return Number.isInteger(n) ? String(n) : n.toFixed(digits);
}

function firstSentence(text: string): string {
  return text.split(/(?<=[.!?])\s+/)[0] ?? text;
}

/**
 * Canned models for --dry. The opener and follow-up are built from the context so the checks have
 * real facts to ground against. Two flaws are planted on purpose so a dry run demonstrates the
 * findings pipeline: the "complete" persona's follow-up re-asks the opener, and the "rant"
 * persona's follow-up brings up an NFL team CONTEXT never mentioned. The default canned follow-up
 * quotes the reply back ("You said ... - what did you mean?"), so `already_answered` warns are
 * expected in --dry output; they say nothing about the real model.
 */
class DryEngine implements Engine {
  private opener(context: ConversationContext): string {
    const tp = context.teamPerformance;
    const bench = context.topBenchPlayer ? ` with ${context.topBenchPlayer.player}'s ${fmt(context.topBenchPlayer.points)} on the bench` : "";
    const standing = context.leagueContext.standings.find((s) => s.teamId === tp.teamId);
    const lead =
      context.opponentName && context.margin !== undefined && tp.score > 0
        ? `That ${fmt(context.margin)}-point ${tp.won ? "win over" : "loss to"} ${context.opponentName}${bench}`
        : context.upcomingOpponentName
          ? `Your matchup against ${context.upcomingOpponentName}`
          : standing && !/^0-0(-0)?$/.test(standing.record)
            ? `Sitting at #${standing.rank} with a ${standing.record} record`
            : `Your ${context.contentType.replace(/_/g, " ")}`;
    return `Sam Ortega with FFSN, and this is on the record. ${lead} - walk me through it?`;
  }

  async question(context: ConversationContext, hint: { persona: Persona }): Promise<AIConversationResult> {
    const base = {
      confidence: 80,
      expectedResponseType: "explanation" as const,
      contextualReasons: ["dry run: canned"],
      shouldEndAfterResponse: false,
      shouldRecordDecline: false,
      costUsd: 0,
    };
    const history = context.conversationHistory ?? [];
    if (history.length === 0) return { ...base, question: this.opener(context), intent: "initial" };
    if (shouldUseTemplatedClose(context)) {
      return { ...base, question: buildClosingMessage(managerFirstName(context.managerName)), intent: "closing", shouldEndAfterResponse: true, confidence: 100 };
    }
    const lastReply = [...history].reverse().find((m) => m.role === "user")?.content ?? "";
    if (isDeclineReply(lastReply)) {
      return { ...base, question: "Understood, thanks for your time. Anything else you want on the record?", intent: "closing", shouldEndAfterResponse: true, shouldRecordDecline: true };
    }
    if (hint.persona === "complete") {
      const opener = history.find((m) => m.role === "ai")?.content ?? this.opener(context);
      return { ...base, question: opener.replace(/^Sam Ortega with FFSN, and this is on the record\. /, ""), intent: "follow_up", shouldEndAfterResponse: true };
    }
    if (hint.persona === "rant") {
      return { ...base, question: "Did the Dolphins' schedule factor into that call?", intent: "follow_up", shouldEndAfterResponse: true };
    }
    const clause = firstSentence(lastReply).split(/\s+/).slice(0, 8).join(" ").replace(/[.,;:!?]+$/, "");
    return { ...base, question: `You said "${clause}" - what did you mean by that?`, intent: "follow_up", shouldEndAfterResponse: true };
  }

  async analyze(reply: string, context: ConversationContext, hint: { persona: Persona }): Promise<ResponseAnalysisResult> {
    const decline = isDeclineReply(reply);
    const writer = context.writerContext;
    const writerNamed = writer && writer.name.split(/\s+/).some((w) => new RegExp(`\\b${w}\\b`, "i").test(reply));
    return {
      responseQuality: decline ? 10 : 60,
      completeness: decline ? 10 : 60,
      relevantTopics: decline ? [] : ["lineup decision"],
      needsFollowUp: !decline,
      sentiment: hint.persona === "rant" ? "negative" : "neutral",
      quotableSegments: decline ? [] : [firstSentence(reply)],
      offTopicScore: hint.persona === "offtopic" ? 85 : 10,
      writerSentiment: writerNamed && writer ? [{ persona: writer.persona, sentiment: "dismissive", evidence: firstSentence(reply) }] : [],
      costUsd: 0,
    };
  }

  async simulate(persona: Persona, context: ConversationContext, _transcript: TranscriptLine[], replyNumber: 1 | 2): Promise<{ text: string } & Spend> {
    const benched = context.lineupDecisions?.[0]?.benchedPlayer ?? context.topBenchPlayer?.player ?? "my guy";
    const started = context.lineupDecisions?.[0]?.startedPlayer ?? context.teamPerformance.underperformers[0]?.player ?? "the other guy";
    const opponent = context.opponentName ?? context.upcomingOpponentName ?? "them";
    const writer = context.writerContext?.name ?? "that writer";
    const points = fmt(context.lineupDecisions?.[0]?.benchedPoints ?? context.topBenchPlayer?.points);
    const first: Record<Persona, string> = {
      terse: `Got cute, benched ${benched}.`,
      complete: `I had ${benched} in the lineup until Sunday morning, then swapped him for ${started} because I liked the matchup. It cost me the game against ${opponent} and I know it. I'm not overthinking it, I'll set the lineup earlier next week and stop chasing matchups.`,
      rant: `${started} was a disaster and ${benched} sat there mocking me with ${points} points. Damn it, these players are killing me.`,
      decline: "No comment today, thanks Sam.",
      offtopic: "Honestly I've been busy planning a camping trip this weekend and haven't thought about much else. The kids are thrilled.",
      correction: `Actually it wasn't the matchup, I benched ${benched} because I thought he was a game-time decision. So that part of your question is off.`,
      jab: `${writer} can stick to mock drafts, he has never watched one of my games. As for the lineup, I got cute and it bit me.`,
      question_back: `What do you think, Sam? Would you have started ${benched} there?`,
    };
    const second: Record<Persona, string> = {
      terse: "That's it.",
      complete: "Nothing more to add, I covered it.",
      rant: "Same answer, the players let me down.",
      decline: "Still no comment.",
      offtopic: "Anyway, the campsite has a lake, so that's the weekend sorted.",
      correction: "Like I said, game-time decision, nothing more to it.",
      jab: "Tell him I said that, word for word.",
      question_back: "You didn't answer me, but fine, I'd make the same call again.",
    };
    return { text: replyNumber === 1 ? first[persona] : second[persona], costUsd: 0 };
  }

  async judge(input: { question: string; kind: "opener" | "follow_up" }): Promise<{ verdict: JudgeVerdict } & Spend> {
    const marks = (input.question.match(/\?/g) ?? []).length;
    return {
      verdict: {
        inventedFact: false,
        inventedFactDetail: "",
        redundant: false,
        redundantDetail: "",
        toneOk: !input.question.includes("!"),
        oneQuestion: marks === 1,
      },
      costUsd: 0,
    };
  }
}

/* -------------------------------------------------------------------------- */
/* One interview                                                               */
/* -------------------------------------------------------------------------- */

const SYSTEM_CLOSE_NOTE =
  "Production (convex/commentConversations.ts) never sends this line: after the second reply evaluateConversationContinuation returns false and completeConversation posts a system message instead. shouldUseTemplatedClose is only reached when a caller asks Sam for a third question.";

async function runInterview(input: InterviewInput & { persona: Persona }, engine: Engine): Promise<InterviewResult> {
  const startedAt = Date.now();
  const { persona } = input;
  const hint = { persona };
  const turns: Turn[] = [];
  const findings: InterviewResult["findings"] = [];
  const judge: JudgeRecord[] = [];
  const transcript: TranscriptLine[] = [];
  const history: NonNullable<ConversationContext["conversationHistory"]> = [];
  const withHistory = (): ConversationContext => ({ ...input.context, conversationHistory: history.map((m) => ({ ...m })) });
  const stamp = () => Date.now();

  const note = (turn: number, stage: string, list: Finding[]) => {
    for (const finding of list) findings.push({ ...finding, turn, stage });
  };
  const samTurn = (kind: TurnKind, result: AIConversationResult, source: Turn["source"]): Turn => {
    const turn: Turn = {
      index: turns.length,
      role: "sam",
      kind,
      text: result.question,
      source,
      intent: result.intent,
      confidence: result.confidence,
      contextualReasons: result.contextualReasons,
      shouldEndAfterResponse: result.shouldEndAfterResponse,
      shouldRecordDecline: result.shouldRecordDecline,
      detectedAbuse: result.detectedAbuse,
      audit: auditQuestion(result.question, input.context),
      usage: result.usage,
      costUsd: result.costUsd,
    };
    turns.push(turn);
    transcript.push({ speaker: "Sam", text: result.question });
    history.push({ role: "ai", content: result.question, timestamp: stamp() });
    return turn;
  };
  const managerTurn = (text: string, spend: Spend, source: Turn["source"]): Turn => {
    const turn: Turn = { index: turns.length, role: "manager", kind: "reply", text, source, usage: spend.usage, costUsd: spend.costUsd };
    turns.push(turn);
    transcript.push({ speaker: "Manager", text });
    history.push({ role: "user", content: text, timestamp: stamp() });
    return turn;
  };
  const attachAnalysis = (turn: Turn, analysis: ResponseAnalysisResult) => {
    turn.analysis = {
      quotableSegments: analysis.quotableSegments,
      writerSentiment: analysis.writerSentiment,
      sentiment: analysis.sentiment,
      offTopicScore: analysis.offTopicScore,
      responseQuality: analysis.responseQuality,
      completeness: analysis.completeness,
      needsFollowUp: analysis.needsFollowUp,
      relevantTopics: analysis.relevantTopics,
      usage: analysis.usage,
      costUsd: analysis.costUsd,
    };
    turn.costUsd += analysis.costUsd;
    note(turn.index, "quotes", checkQuotes(turn.text, analysis.quotableSegments));
  };
  const judgeQuestion = async (turn: Turn, kind: "opener" | "follow_up") => {
    const transcriptBefore = transcript.slice(0, -1);
    const { verdict, usage, costUsd } = await engine.judge({ context: input.context, transcript: transcriptBefore, question: turn.text, kind });
    judge.push({ turn: turn.index, kind, verdict, usage, costUsd });
  };

  let outcome: Outcome = "error";
  let continuation: InterviewResult["continuation"] = { shouldContinue: false, offTopicScore: NaN, reason: "not reached" };
  let error: string | undefined;

  try {
    // 1. Opener (production: `generateConversationQuestion` on the freshly built context).
    const openerResult = await engine.question(withHistory(), hint);
    const opener = samTurn("opener", openerResult, openerResult.usage ? "model" : "canned");
    note(opener.index, "grounding", checkQuestionGrounding(opener.text, input.context));
    note(opener.index, "shape", checkQuestionShape(opener.text, { isOpener: true }));
    if (openerResult.intent !== "initial") {
      note(opener.index, "flow", [{ code: "opener_intent", severity: "warn", detail: `opener intent is "${openerResult.intent}", expected "initial"` }]);
    }
    await judgeQuestion(opener, "opener");

    // 2. Reply 1 and its analysis (production: `processUserResponse`).
    const reply1 = await engine.simulate(persona, input.context, transcript, 1);
    const replyTurn1 = managerTurn(reply1.text, reply1, reply1.usage ? "simulated" : "canned");
    const analysis1 = await engine.analyze(reply1.text, withHistory(), hint);
    attachAnalysis(replyTurn1, analysis1);

    // 3. The continuation gate (production: `evaluateConversationContinuation`), preceded by
    //    production's bare-decline check (`processUserResponse` -> `looksLikeDecline`): a reply
    //    with nothing quotable that reads as "no comment" is recorded as a decline before the gate.
    const userMessages = history.filter((m) => m.role === "user").length;
    const bareDecline = looksLikeDecline(reply1.text);
    const shouldContinue = !bareDecline && userMessages === 1 && analysis1.offTopicScore < 50;
    if (bareDecline) {
      note(replyTurn1.index, "flow", [
        { code: "decline_recorded_pre_gate", severity: "info", detail: "bare decline: production records the decline before the continuation gate" },
      ]);
      continuation = { shouldContinue: false, offTopicScore: analysis1.offTopicScore, reason: "DECLINE: bare 'no comment' recorded before the gate" };
      outcome = "declined";
    }
    continuation = {
      shouldContinue,
      offTopicScore: analysis1.offTopicScore,
      reason: shouldContinue
        ? "CONTINUE: first reply on topic, asking the one follow-up"
        : `CLOSE: userMessages=${userMessages}, offTopicScore=${analysis1.offTopicScore}`,
    };

    if (bareDecline) {
      // Recorded as a decline before the gate (outcome set above); nothing else runs.
    } else if (!shouldContinue) {
      outcome = "ended_off_topic";
      if (isDeclineReply(reply1.text)) {
        note(replyTurn1.index, "flow", [
          {
            code: "decline_skipped_by_offtopic_gate",
            severity: "block",
            detail: `the manager declined but offTopicScore ${analysis1.offTopicScore} closed the conversation before Sam could record the decline; the request completes as "${analysis1.responseQuality >= 70 ? "sufficient_response" : analysis1.offTopicScore > 70 ? "off_topic" : "auto_ended"}" instead of "declined"`,
          },
        ]);
      }
    } else {
      // 4. Sam's second message (production: `generateAIFollowUp`).
      const secondResult = await engine.question(withHistory(), hint);
      note(turns.length, "decline", checkDecline(reply1.text, secondResult));

      if (secondResult.shouldRecordDecline) {
        // Production records the decline and returns without storing the message.
        const declineTurn = samTurn("closing", secondResult, secondResult.usage ? "model" : "canned");
        note(declineTurn.index, "flow", [{ code: "decline_recorded_by_sam", severity: "info", detail: "request marked declined; this message is not stored or sent in production" }]);
        outcome = "declined";
      } else if (secondResult.intent === "closing") {
        const closeTurn = samTurn("closing", secondResult, secondResult.usage ? "model" : "canned");
        note(closeTurn.index, "grounding", checkQuestionGrounding(closeTurn.text, input.context, { replies: [reply1.text] }));
        note(closeTurn.index, "shape", checkQuestionShape(closeTurn.text, { isOpener: false }));
        outcome = "closed_by_model";
      } else {
        const followUp = samTurn("follow_up", secondResult, secondResult.usage ? "model" : "canned");
        note(followUp.index, "grounding", checkQuestionGrounding(followUp.text, input.context, { replies: [reply1.text] }));
        note(followUp.index, "shape", checkQuestionShape(followUp.text, { isOpener: false }));
        note(followUp.index, "redundancy", checkFollowUpRedundancy(opener.text, reply1.text, followUp.text, input.context));
        if (!secondResult.shouldEndAfterResponse) {
          note(followUp.index, "flow", [{ code: "follow_up_not_final", severity: "warn", detail: "follow-up did not set shouldEndAfterResponse" }]);
        }
        await judgeQuestion(followUp, "follow_up");

        // 5. Reply 2 and its analysis; the gate then closes (userMessages === 2).
        const reply2 = await engine.simulate(persona, input.context, transcript, 2);
        const replyTurn2 = managerTurn(reply2.text, reply2, reply2.usage ? "simulated" : "canned");
        const analysis2 = await engine.analyze(reply2.text, withHistory(), hint);
        attachAnalysis(replyTurn2, analysis2);

        // 6. The close is a template: no model call, no cost.
        const closingContext = withHistory();
        const templated = shouldUseTemplatedClose(closingContext);
        const closeText = buildClosingMessage(managerFirstName(input.context.managerName));
        const close: Turn = {
          index: turns.length,
          role: "sam",
          kind: "templated_close",
          text: closeText,
          source: "template",
          intent: "closing",
          shouldEndAfterResponse: true,
          shouldRecordDecline: false,
          costUsd: 0,
        };
        turns.push(close);
        transcript.push({ speaker: "Sam", text: closeText });
        if (!templated) {
          note(close.index, "flow", [{ code: "templated_close_not_ready", severity: "block", detail: "shouldUseTemplatedClose returned false after the follow-up was answered" }]);
        }
        note(close.index, "flow", [{ code: "prod_close_is_system_message", severity: "info", detail: SYSTEM_CLOSE_NOTE }]);
        outcome = "followed_up";
      }
    }
  } catch (caught) {
    error = (caught as Error).message;
    outcome = "error";
  }

  const costUsd = turns.reduce((sum, turn) => sum + turn.costUsd, 0) + judge.reduce((sum, entry) => sum + entry.costUsd, 0);
  return {
    id: input.id,
    label: input.label,
    scenario: input.scenario,
    persona,
    outcome,
    continuation,
    turns,
    findings,
    judge,
    costUsd,
    durationMs: Date.now() - startedAt,
    error,
  };
}

/* -------------------------------------------------------------------------- */
/* Output                                                                      */
/* -------------------------------------------------------------------------- */

function summarize(results: InterviewResult[]): Summary {
  const summary: Summary = {
    interviews: results.length,
    blocks: 0,
    warns: 0,
    infos: 0,
    byCode: {},
    byPersona: {},
    byOutcome: {},
    judge: { questions: 0, inventedFacts: 0, redundant: 0, toneProblems: 0, multiQuestion: 0 },
    totalCostUsd: 0,
  };
  for (const result of results) {
    const persona = (summary.byPersona[result.persona] ??= { interviews: 0, blocks: 0, warns: 0, costUsd: 0, outcomes: {} });
    persona.interviews++;
    persona.costUsd += result.costUsd;
    persona.outcomes[result.outcome] = (persona.outcomes[result.outcome] ?? 0) + 1;
    summary.byOutcome[result.outcome] = (summary.byOutcome[result.outcome] ?? 0) + 1;
    summary.totalCostUsd += result.costUsd;
    for (const finding of result.findings) {
      summary.byCode[finding.code] = (summary.byCode[finding.code] ?? 0) + 1;
      if (finding.severity === "block") {
        summary.blocks++;
        persona.blocks++;
      } else if (finding.severity === "warn") {
        summary.warns++;
        persona.warns++;
      } else {
        summary.infos++;
      }
    }
    for (const entry of result.judge) {
      summary.judge.questions++;
      if (entry.verdict.inventedFact) summary.judge.inventedFacts++;
      if (entry.verdict.redundant) summary.judge.redundant++;
      if (!entry.verdict.toneOk) summary.judge.toneProblems++;
      if (!entry.verdict.oneQuestion) summary.judge.multiQuestion++;
    }
  }
  return summary;
}

function safeFileName(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120) || "interview";
}

function mdCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function dumpMarkdown(dir: string, result: InterviewResult, context: ConversationContext): void {
  const lines: string[] = [];
  const speakerLabel = (turn: Turn) =>
    turn.role === "sam"
      ? `Sam (${turn.kind}${turn.intent ? `, intent ${turn.intent}` : ""}${turn.source !== "model" ? `, ${turn.source}` : ""})`
      : `Manager (${result.persona}${turn.source !== "simulated" ? `, ${turn.source}` : ""})`;

  lines.push(`# ${result.label}`);
  lines.push("");
  lines.push(`- id: \`${result.id}\``);
  lines.push(`- persona: **${result.persona}**`);
  lines.push(`- outcome: **${result.outcome}**${result.error ? ` - ${result.error}` : ""}`);
  lines.push(`- continuation: ${result.continuation.reason}`);
  lines.push(`- cost: $${result.costUsd.toFixed(4)} · ${Math.round(result.durationMs / 1000)}s`);
  lines.push("");
  lines.push("## Scenario");
  lines.push("");
  lines.push("```json");
  lines.push(JSON.stringify(result.scenario, null, 2));
  lines.push("```");
  lines.push("");
  lines.push("## CONTEXT (everything Sam was allowed to state)");
  lines.push("");
  lines.push("```text");
  lines.push(factBlockFor(context));
  lines.push("```");
  lines.push("");
  lines.push("## Transcript");
  lines.push("");
  for (const turn of result.turns) {
    lines.push(`**[${turn.index}] ${speakerLabel(turn)}:** ${turn.text}`);
    lines.push("");
    if (turn.role === "sam") {
      const flags = [
        turn.shouldEndAfterResponse ? "shouldEndAfterResponse" : "",
        turn.shouldRecordDecline ? "shouldRecordDecline" : "",
        turn.detectedAbuse ? `detectedAbuse ${turn.detectedAbuse.type}/${turn.detectedAbuse.severity}` : "",
      ].filter(Boolean);
      if (flags.length || turn.contextualReasons?.length) {
        lines.push(`> ${flags.join(" · ") || "no flags"}${turn.contextualReasons?.length ? ` · reasons: ${turn.contextualReasons.join("; ")}` : ""}`);
        lines.push("");
      }
    }
    if (turn.analysis) {
      const a = turn.analysis;
      lines.push(
        `> analysis: offTopic ${a.offTopicScore} · quality ${a.responseQuality} · completeness ${a.completeness} · sentiment ${a.sentiment} · needsFollowUp ${a.needsFollowUp}`
      );
      lines.push(`> quotes: ${a.quotableSegments.length ? a.quotableSegments.map((q) => `"${q}"`).join(" | ") : "(none)"}`);
      if (a.writerSentiment.length) {
        lines.push(`> writerSentiment: ${a.writerSentiment.map((w) => `${w.persona} ${w.sentiment} ("${w.evidence}")`).join(" | ")}`);
      }
      lines.push("");
    }
  }

  lines.push("## Fact audit (verify by hand against CONTEXT)");
  lines.push("");
  for (const turn of result.turns) {
    if (!turn.audit) continue;
    lines.push(`### [${turn.index}] ${turn.kind}`);
    lines.push("");
    if (turn.audit.numbers.length) {
      lines.push("| number | grounded | via |");
      lines.push("|---|---|---|");
      for (const n of turn.audit.numbers) lines.push(`| ${mdCell(n.raw)} | ${n.grounded ? "yes" : "**NO**"} | ${mdCell(n.via)} |`);
      lines.push("");
    }
    if (turn.audit.names.length) {
      lines.push("| name | kind | grounded | via |");
      lines.push("|---|---|---|---|");
      for (const n of turn.audit.names) lines.push(`| ${mdCell(n.name)} | ${n.kind} | ${n.grounded ? "yes" : "**NO**"} | ${mdCell(n.via)} |`);
      lines.push("");
    }
    if (turn.audit.vocabulary.length) {
      lines.push("| word | implies | in CONTEXT |");
      lines.push("|---|---|---|");
      for (const v of turn.audit.vocabulary) lines.push(`| ${mdCell(v.word)} | ${v.category} | ${v.inBlock ? "yes" : "**NO**"} |`);
      lines.push("");
    }
    if (!turn.audit.numbers.length && !turn.audit.names.length && !turn.audit.vocabulary.length) {
      lines.push("_no numbers, proper nouns or flagged vocabulary_");
      lines.push("");
    }
  }

  lines.push("## Findings");
  lines.push("");
  if (result.findings.length === 0) {
    lines.push("_none_");
  } else {
    lines.push("| turn | severity | code | stage | detail |");
    lines.push("|---|---|---|---|---|");
    for (const f of result.findings) {
      lines.push(`| ${f.turn} | ${f.severity === "block" ? "**block**" : f.severity} | ${f.code} | ${f.stage} | ${mdCell(f.detail)} |`);
    }
  }
  lines.push("");

  lines.push("## Judge (Sonnet 5)");
  lines.push("");
  if (result.judge.length === 0) {
    lines.push("_no questions judged_");
  } else {
    lines.push("| turn | kind | invented fact | redundant | tone ok | one question |");
    lines.push("|---|---|---|---|---|---|");
    for (const j of result.judge) {
      const v = j.verdict;
      lines.push(
        `| ${j.turn} | ${j.kind} | ${v.inventedFact ? `**yes** - ${mdCell(v.inventedFactDetail)}` : "no"} | ${v.redundant ? `**yes** - ${mdCell(v.redundantDetail)}` : "no"} | ${v.toneOk ? "yes" : "**no**"} | ${v.oneQuestion ? "yes" : "**no**"} |`
      );
    }
  }
  lines.push("");

  lines.push("## Cost");
  lines.push("");
  lines.push("| call | model | input | output | cached | cost |");
  lines.push("|---|---|---|---|---|---|");
  for (const turn of result.turns) {
    if (turn.usage) {
      lines.push(`| ${turn.kind} | ${turn.usage.model} | ${turn.usage.inputTokens} | ${turn.usage.outputTokens} | ${turn.usage.cacheReadTokens} | $${(turn.costUsd - (turn.analysis?.costUsd ?? 0)).toFixed(4)} |`);
    } else if (turn.role === "sam") {
      lines.push(`| ${turn.kind} | (${turn.source}, no call) | 0 | 0 | 0 | $0.0000 |`);
    }
    if (turn.analysis?.usage) {
      const u = turn.analysis.usage;
      lines.push(`| analysis of [${turn.index}] | ${u.model} | ${u.inputTokens} | ${u.outputTokens} | ${u.cacheReadTokens} | $${turn.analysis.costUsd.toFixed(4)} |`);
    }
  }
  for (const j of result.judge) {
    if (j.usage) lines.push(`| judge [${j.turn}] | ${j.usage.model} | ${j.usage.inputTokens} | ${j.usage.outputTokens} | ${j.usage.cacheReadTokens} | $${j.costUsd.toFixed(4)} |`);
  }
  lines.push(`| **total** | | | | | **$${result.costUsd.toFixed(4)}** |`);
  lines.push("");

  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${safeFileName(result.id)}.md`), lines.join("\n"));
}

function printTable(headers: string[], rows: string[][]): void {
  const widths = headers.map((header, column) => Math.max(header.length, ...rows.map((row) => (row[column] ?? "").length)));
  const line = (cells: string[]) => cells.map((cell, column) => (cell ?? "").padEnd(widths[column])).join("  ").trimEnd();
  console.log(line(headers));
  console.log(widths.map((width) => "-".repeat(width)).join("  "));
  rows.forEach((row) => console.log(line(row)));
}

/* -------------------------------------------------------------------------- */
/* Main                                                                        */
/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  let engine: Engine;
  if (options.dry) {
    engine = new DryEngine();
  } else {
    const apiKey = loadApiKey();
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set and .env.local has no ANTHROPIC_API_KEY line (or pass --dry)");
    engine = new LiveEngine(apiKey);
  }

  const raw = options.demo ? demoInputs(options.personas) : loadContexts(options.contexts!);
  const limited = options.limit ? raw.slice(0, options.limit) : raw;
  const jobs = assignPersonas(limited, options.personas, options.seed);
  if (!options.quiet) {
    console.log(
      `${options.dry ? "DRY" : "LIVE"} · ${jobs.length} interview(s) · personas ${options.personas.join(",")} · seed ${options.seed} · concurrency ${options.concurrency}\n`
    );
  }

  const results: InterviewResult[] = new Array(jobs.length);
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const index = next++;
      const job = jobs[index];
      const result = await runInterview(job, engine);
      results[index] = result;
      if (options.dump) dumpMarkdown(options.dump, result, job.context);
      if (!options.quiet) {
        const blocks = result.findings.filter((f) => f.severity === "block").length;
        const warns = result.findings.filter((f) => f.severity === "warn").length;
        console.log(
          `  ${result.outcome === "error" ? "FAIL" : "done"}  ${result.id} [${result.persona}] ${result.outcome}: ` +
            `${result.turns.length} turns, ${blocks} block(s), ${warns} warn(s), $${result.costUsd.toFixed(4)}` +
            (result.error ? ` - ${result.error}` : "")
        );
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(options.concurrency, jobs.length) }, () => worker()));

  const summary = summarize(results);
  if (options.out) {
    mkdirSync(path.dirname(path.resolve(options.out)), { recursive: true });
    writeFileSync(
      options.out,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          mode: options.dry ? "dry" : "live",
          models: options.dry ? null : { questions: "conversationService (Opus 5 -> Sonnet 5)", analysis: "conversationService (Sonnet 5 -> Opus 5)", simulator: SIMULATOR_MODEL, judge: JUDGE_MODEL },
          options: { ...options, contexts: options.contexts ?? null },
          interviews: results,
          summary,
        },
        null,
        2
      )
    );
  }

  console.log("");
  printTable(
    ["id", "persona", "outcome", "turns", "blocks", "warns", "cost"],
    results.map((r) => [
      r.id,
      r.persona,
      r.outcome,
      String(r.turns.length),
      String(r.findings.filter((f) => f.severity === "block").length),
      String(r.findings.filter((f) => f.severity === "warn").length),
      `$${r.costUsd.toFixed(4)}`,
    ])
  );
  console.log(
    `\n${summary.interviews} interview(s): ${summary.blocks} block(s), ${summary.warns} warn(s), ${summary.infos} info · ` +
      `judge: ${summary.judge.inventedFacts} invented fact(s), ${summary.judge.redundant} redundant, ${summary.judge.toneProblems} tone, ${summary.judge.multiQuestion} multi-question of ${summary.judge.questions} · ` +
      `total $${summary.totalCostUsd.toFixed(4)}`
  );
  const codes = Object.entries(summary.byCode).sort((a, b) => b[1] - a[1]);
  if (codes.length) console.log(`by code: ${codes.map(([code, count]) => `${code}=${count}`).join("  ")}`);
  if (options.out) console.log(`results: ${options.out}`);
  if (options.dump) console.log(`dumps:   ${options.dump}/`);

  const failed = results.filter((r) => r.outcome === "error").length;
  if (failed > 0) process.exitCode = 1;
}

await main();
