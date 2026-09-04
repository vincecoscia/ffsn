// "Disputed" — a weekly, transcript-only debate show for a fantasy league (BUILD 1).
//
// This module is pure TypeScript: no Anthropic SDK import, no Convex import, no network, no I/O.
// Every shape a model produces is a Zod schema (so it can be parsed with `.safeParse` off a forced
// tool call); shapes the producer alone assembles from those turns are plain, exported TS
// interfaces — there is nothing external to validate them against.

import { z } from "zod";
import { ArticleClaim as ArticleClaimSchema } from "../content-generation-service";
import type { ArticleClaimT } from "../content-generation-service";
import type { LanguageRating } from "../language";

/** Re-exported so callers of this module never need to reach into content-generation-service.ts. */
export type { ArticleClaimT as ArticleClaim } from "../content-generation-service";

/**
 * `content-generation-service.ts` never exports its `ManagerMention` Zod schema (only the inferred
 * `GeneratedArticleT["managerMentions"]` array type is reachable), and this build may not edit that
 * file. This mirrors that schema exactly — same fields, same constraints — so a turn's structured
 * output can carry manager mentions the same way an article does.
 */
export const ManagerMentionSchema = z.object({
  teamId: z.string().describe("MUST be a FACTS team id"),
  managerName: z.string(),
  stance: z.enum(["roast", "praise", "neutral"]),
  intensity: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  evidence: z.string().describe("The sentence from your turn that carries the stance"),
});
/** Structurally identical to `GeneratedArticleT["managerMentions"][number]`. */
export type ManagerMention = z.infer<typeof ManagerMentionSchema>;

/* -------------------------------------------------------------------------- *
 * Roster (spec: the desk)
 * -------------------------------------------------------------------------- */

export const HOST_SLUG = "curtis-vaughn" as const;
export const DEBATER_SLUGS = ["mel-diaper", "reggie-banks"] as const;
export const WITNESS_SLUGS = ["sam-ortega", "nina-sharpe", "dex-alvarez", "walt-brennan"] as const;

export const DebaterSlugSchema = z.enum(DEBATER_SLUGS);
export type DebaterSlug = z.infer<typeof DebaterSlugSchema>;

export const WitnessSlugSchema = z.enum(WITNESS_SLUGS);
export type WitnessSlug = z.infer<typeof WitnessSlugSchema>;

/** A speaker's role on the show, which decides its word ceiling and model route. */
export type ShowRole = "host" | "debater" | "witness";

export function roleOf(slug: string): ShowRole {
  if ((DEBATER_SLUGS as readonly string[]).includes(slug)) return "debater";
  if ((WITNESS_SLUGS as readonly string[]).includes(slug)) return "witness";
  return "host";
}

/* -------------------------------------------------------------------------- *
 * The rundown
 * -------------------------------------------------------------------------- */

export const SEGMENT_IDS = ["cold_open", "opening_statements", "main_event", "verdict", "last_jabs"] as const;
export const SegmentIdSchema = z.enum(SEGMENT_IDS);
export type SegmentId = z.infer<typeof SegmentIdSchema>;

export const TURN_KINDS = [
  "cold_open",
  "opening",
  "argument",
  "witness",
  "redirect",
  "grade",
  "ledger",
  "jab",
  "close",
] as const;
export const TurnKindSchema = z.enum(TURN_KINDS);
export type TurnKind = z.infer<typeof TurnKindSchema>;

const VerdictSchema = z.object({
  winner: DebaterSlugSchema.describe("Which debater won the exchange, by slug"),
  reason: z.string().describe("One sentence: the number or fact that decided it"),
});

/**
 * Each debater's contradicting position on the hot-seat question, set once by the cold open (spec
 * follow-up, 2026-09-03: without this Mel and Reggie could both open on the same side and the
 * binary question dissolved). Keyed by slug so it lines up with {@link DEBATER_SLUGS}.
 */
const DebaterSidesSchema = z.object({
  "mel-diaper": z.string().describe("Mel's side: the draft-board/process answer."),
  "reggie-banks": z.string().describe("Reggie's side: the scoreboard/results answer."),
});
export type DebaterSides = z.infer<typeof DebaterSidesSchema>;

/**
 * What the model returns for one turn, via a forced tool call. The producer decides which of these
 * optional fields are meaningful for a given `TurnKind` and strips the rest (see
 * `producer.ts#sanitizeTurnOutput`) — the schema itself stays permissive so a model that includes an
 * extra field (e.g. a stray `claim` on a witness turn) still parses.
 */
export const TurnOutputSchema = z.object({
  text: z.string().describe("What this speaker says. No speaker label, no stage directions."),
  jab: z.boolean().describe("True only if this turn takes a shot at the other debater."),
  factsCited: z
    .array(z.string())
    .default([])
    .describe("Which FACTS entries (ids or plain descriptions) this turn is grounded in."),
  witnessRequested: WitnessSlugSchema.optional().describe(
    "Call this witness to the stand next, by slug. Only meaningful for a debater's argument or the host's redirect."
  ),
  agreesWithOpponent: z
    .boolean()
    .optional()
    .describe("True only if this turn concedes a point to the other debater. Rare — agreement is the verdict."),
  managerMentions: z
    .array(ManagerMentionSchema)
    .optional()
    .describe("Every manager this turn roasted, praised, or treated neutrally, with the sentence that did it."),
  claim: ArticleClaimSchema.optional().describe(
    "An opening statement's position, phrased as a resolvable prediction with FACTS team ids."
  ),
  question: z
    .string()
    .optional()
    .describe("The cold open's binary question for the episode. Only meaningful for the cold_open turn."),
  verdict: VerdictSchema.optional().describe("Nina's grade turn only: who won and why."),
  sides: DebaterSidesSchema.optional().describe(
    "Only for the cold_open turn: each debater's contradicting position, one sentence each — one " +
      "from the draft board/process (Mel's), one from the scoreboard/this season's results (Reggie's)."
  ),
});
export type TurnOutput = z.infer<typeof TurnOutputSchema>;

/**
 * One turn of the finished transcript: a sanitised `TurnOutput` plus the bookkeeping the producer
 * adds (who spoke, what kind of turn, which model answered, whether it took a retry). Never parsed
 * from anywhere external, so this is a plain interface rather than a second Zod schema.
 */
export interface ShowTurn {
  /** Persona slug, e.g. "mel-diaper". */
  speaker: string;
  kind: TurnKind;
  text: string;
  jab: boolean;
  factsCited: string[];
  witnessRequested?: WitnessSlug;
  agreesWithOpponent?: boolean;
  managerMentions?: ManagerMention[];
  claim?: ArticleClaimT;
  verdict?: { winner: DebaterSlug; reason: string };
  model?: string;
  retried?: boolean;
  /**
   * Edit-bay (pass two) only: this turn cuts in before the previous speaker finished. The
   * PREVIOUS turn's text should then end with an em dash (see `renderTranscriptMarkdown`, which
   * renders this turn's plate as "NAME (Role), cutting in:").
   */
  interrupts?: boolean;
}

export interface ShowSegment {
  id: SegmentId;
  title: string;
  turns: ShowTurn[];
}

export interface ShowTranscript {
  schema: "ffsn.transcript.v1";
  show: "disputed";
  week?: number;
  question: string;
  hotSeat?: { teamId: string; teamName: string; managerName: string; why: string };
  /** The resolved debater sides (from the cold open, or the deterministic fallback). */
  sides?: DebaterSides;
  /** The rating this episode was produced at; defaults to "clean" when the producer never set it. */
  language?: LanguageRating;
  segments: ShowSegment[];
  /** Set only once the edit bay (pass two, `naturalizeTranscript`) has run over this transcript. */
  edited?: {
    pass: "edit-bay-v1";
    wordsBefore: number;
    wordsAfter: number;
    segmentsEdited: number;
    segmentsRejected: number;
    rejections: Array<{ segment: string; reason: string }>;
  };
}

/* -------------------------------------------------------------------------- *
 * Edit bay (pass two) — a model-produced rewrite of one segment's turns, forced through a tool call
 * and validated by `edit-bay.ts#checkEditedSegment` before it ever replaces the original segment.
 * -------------------------------------------------------------------------- */

export const EditedTurnSchema = z.object({
  // No `.nonnegative()`: it becomes `minimum: 0` in the tool schema, which the API rejects for
  // integers in a strict tool ("For 'integer' type, property 'minimum' is not supported"). The
  // guard in edit-bay.ts already rejects any index outside the segment.
  sourceTurn: z.number().int().describe("Index into the segment's original turns array (0-based)."),
  speaker: z.string().describe("Must equal sourceTurn's speaker."),
  text: z.string().describe("The rewritten line. No new facts, names or numbers."),
  interrupts: z
    .boolean()
    .optional()
    .describe("True only if this turn cuts in before the previous speaker finished."),
});
export type EditedTurn = z.infer<typeof EditedTurnSchema>;

export const EditedSegmentSchema = z.object({
  turns: z.array(EditedTurnSchema),
});
export type EditedSegment = z.infer<typeof EditedSegmentSchema>;

/* -------------------------------------------------------------------------- *
 * Producer inputs / outputs — pure bookkeeping the producer builds and reads. Never parsed off a
 * model response, so these stay plain interfaces rather than Zod schemas.
 * -------------------------------------------------------------------------- */

export interface ShowBrief {
  week?: number;
  hotSeat: { teamId: string; teamName: string; managerName: string; why: string };
  fallbackQuestion: string;
  ledger: {
    "mel-diaper": { hits: number; misses: number };
    "reggie-banks": { hits: number; misses: number };
  };
  /** League-level language rating for this episode; defaults to "clean" when absent. */
  languageRating?: LanguageRating;
  /** Team names whose managers opted down to clean coverage, regardless of `languageRating`. */
  cleanTeamNames?: string[];
}

export interface ShowStats {
  turns: number;
  witnessCalls: number;
  redirects: number;
  retries: number;
  dropped: number;
  agreements: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  modelsUsed: string[];
  /** Times Reggie's catchphrase was stripped from a non-jab turn after surviving a retry (spec follow-up). */
  catchphraseStripped: number;
  /** Turns whose text broke the league's language rating twice and had the offending sentence removed. */
  languageStripped: number;
  /** Turns that swore about an opted-down team twice and had those sentences removed (the manager opt-down, enforced). */
  cleanTeamStripped: number;
  /**
   * Tracked profanity words each speaker actually carried into the finished transcript (team names
   * exempt), keyed by slug — the per-episode number the persona's language allowance is measured
   * against, and the pilot's read on whether a rating produced character or nothing.
   */
  profanityBySpeaker: Record<string, number>;
  /** Times Reggie's opening claim duplicated Mel's and was dropped after surviving a retry (spec follow-up). */
  duplicateClaimsDropped: number;
  /**
   * Every verifier finding kept for a turn (block/strip/warn, whatever survived verification) plus
   * producer-level notes (an agreement stripped by the cap, a turn over its word ceiling, a
   * catchphrase stripped outside the last jab). `kind` is a free-form string on purpose: it carries
   * both `fact-verifier.ts`'s `ViolationKind` values and producer-only tags that have no verifier
   * equivalent.
   */
  violations: Array<{ speaker: string; kind: string; detail: string; severity: string }>;
}
