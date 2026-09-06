/**
 * Shared Convex validators for the Broadcast Desk.
 *
 * These mirror the TypeScript interfaces in `src/lib/ai/content-generation-service.ts`
 * (spec §4.2) so the same shapes can be used for stored documents (`convex/schema.ts`),
 * function arguments, and function return validators without redeclaring fields.
 *
 * This module registers no Convex functions - it only exports validators.
 */

import { v } from "convex/values";

/* -------------------------------------------------------------------------- */
/* Language rating                                                             */
/* -------------------------------------------------------------------------- */

/** `LanguageRating` from `src/lib/ai/language.ts` (owner ask, Sept 2026). Absent means "clean". */
export const languageRatingValidator = v.union(
  v.literal("clean"),
  v.literal("salty"),
  v.literal("unfiltered"),
);

/* -------------------------------------------------------------------------- */
/* Relationship primitives                                                     */
/* -------------------------------------------------------------------------- */

/** `RelationshipTier` from `src/lib/ai/persona-prompts.ts`. */
export const relationshipTierValidator = v.union(
  v.literal("feud"),
  v.literal("cold"),
  v.literal("neutral"),
  v.literal("warm"),
  v.literal("favorite"),
);

/** The kinds of events that move a manager <-> writer relationship score. */
export const relationshipEventTypeValidator = v.union(
  v.literal("article_roast"),
  v.literal("article_praise"),
  v.literal("interview_jab"),
  v.literal("interview_praise"),
  v.literal("reaction"),
  v.literal("decay"),
  v.literal("manual"),
  // The Wire (spec §17): how the writer read a manager's reply to them.
  v.literal("wire_jab"),
  v.literal("wire_praise"),
);

/** `RelationshipEventSummary` (spec §4.2). */
export const relationshipEventSummaryValidator = v.object({
  type: v.string(),
  delta: v.number(),
  evidence: v.string(),
  week: v.optional(v.number()),
});

/** `WriterRelationshipContext` (spec §4.2). Ids are strings on the prompt layer. */
export const writerRelationshipContextValidator = v.object({
  userId: v.string(),
  teamId: v.string(),
  teamName: v.string(),
  managerName: v.string(),
  score: v.number(),
  tier: relationshipTierValidator,
  recentEvents: v.array(relationshipEventSummaryValidator),
});

/* -------------------------------------------------------------------------- */
/* Comment flow                                                                */
/* -------------------------------------------------------------------------- */

/** Where a quotable manager statement came from - the interview flow, or a wire post (spec §17.5). */
export const commentSourceValidator = v.union(v.literal("interview"), v.literal("wire"));

/** `CommentResponseData` (spec §4.2). */
export const commentResponseDataValidator = v.object({
  userId: v.string(),
  userName: v.string(),
  teamId: v.string(),
  teamName: v.string(),
  questionTopic: v.string(),
  quotes: v.array(v.string()),
  rawResponse: v.string(),
  // The Wire (spec §17.5): absent (or "interview") is the existing comment-request path; "wire"
  // marks an entry built from `wire.getManagerStatementsForArticle` so the prompt layer can label
  // it "said on The Wire" instead of treating it as an interview answer.
  source: v.optional(commentSourceValidator),
});

/** `NonRespondent` (spec §4.2). */
export const nonRespondentValidator = v.object({
  userId: v.string(),
  userName: v.string(),
  teamName: v.string(),
  status: v.union(v.literal("no_response"), v.literal("declined")),
});

/**
 * One quote the manager is being asked to sign off on (spec §8.1).
 *
 * `original` is the verbatim span the interview produced and never changes;
 * `text` is what actually goes to print. An `edited` entry's `text` is what the
 * manager typed, so it is the verbatim of record and is not re-checked against
 * the raw reply. `withdrawn` entries are never sent to the writer.
 */
export const quoteReviewEntryValidator = v.object({
  original: v.string(),
  text: v.string(),
  status: v.union(
    v.literal("pending"),
    v.literal("approved"),
    v.literal("edited"),
    v.literal("withdrawn"),
  ),
});

/** What the manager may do to one pending quote (spec §8.1 `reviewQuote`). */
export const quoteReviewActionValidator = v.union(
  v.literal("approve"),
  v.literal("edit"),
  v.literal("withdraw"),
);

/** How a manager talked about a named writer during an interview (spec §5). */
export const writerSentimentValidator = v.object({
  persona: v.string(),
  sentiment: v.union(
    v.literal("hostile"),
    v.literal("dismissive"),
    v.literal("neutral"),
    v.literal("friendly"),
  ),
  evidence: v.string(),
});

/* -------------------------------------------------------------------------- */
/* Generation / verification                                                   */
/* -------------------------------------------------------------------------- */

/** `Violation` from `src/lib/ai/fact-verifier.ts` (spec §4.5). */
export const reviewFlagValidator = v.object({
  kind: v.string(),
  detail: v.string(),
  section: v.optional(v.string()),
  severity: v.union(v.literal("block"), v.literal("strip"), v.literal("warn")),
});

/** A past on-the-record prediction the writer may claim (spec §4.2 / §4.3). */
export const priorClaimValidator = v.object({
  articleId: v.string(),
  week: v.optional(v.number()),
  claim: v.string(),
  outcome: v.optional(
    v.union(v.literal("hit"), v.literal("miss"), v.literal("open")),
  ),
});

/** The writer's running record on their own predictions (spec §8.4). */
export const priorRecordValidator = v.object({
  hits: v.number(),
  misses: v.number(),
  open: v.number(),
});

/**
 * One explicit prediction as the model emits it (spec §8.4 output schema).
 *
 * `subjectTeamId` / `opponentTeamId` arrive as FACTS ids ("T" + externalId) or as
 * Convex team ids; `claims.ts` accepts both. Everything except `text`/`kind` is
 * optional because a claim only carries the fields its kind can be judged on.
 */
export const generatedClaimValidator = v.object({
  text: v.string(),
  kind: v.union(
    v.literal("team_win"),
    v.literal("team_finish"),
    v.literal("player_points"),
    v.literal("trade_verdict"),
    v.literal("general"),
  ),
  subjectTeamId: v.optional(v.string()),
  opponentTeamId: v.optional(v.string()),
  subjectPlayer: v.optional(v.string()),
  week: v.optional(v.number()),
  minRank: v.optional(v.number()),
  maxRank: v.optional(v.number()),
  minPoints: v.optional(v.number()),
  // Which desk member actually made this claim (spec: Disputed) — a multi-speaker piece's
  // claims are not all the article's own byline. Absent on an ordinary single-writer article,
  // where `updateGeneratedContent` stamps the stored claim with `article.persona`.
  persona: v.optional(v.string()),
});

/**
 * A claim as stored on `aiContent.claims`: the emitted shape plus who said it,
 * when, and how it turned out. Written with `outcome: "open"`; `claims.ts`
 * `resolveOpenClaims` settles it to `hit` / `miss` and stamps `resolvedAt`.
 */
export const articleClaimValidator = generatedClaimValidator.extend({
  outcome: v.union(v.literal("open"), v.literal("hit"), v.literal("miss")),
  resolvedAt: v.optional(v.number()),
  persona: v.string(),
  season: v.optional(v.number()),
});

/** `ArticleQuote` as stored on the article (spec §4.2). */
export const articleQuoteValidator = v.object({
  quoteId: v.string(),
  speaker: v.string(),
  teamId: v.string(),
  text: v.string(),
  questionTopic: v.string(),
  sectionName: v.string(),
  writerResponse: v.optional(v.string()),
  // The Wire (spec §17.5): see `commentResponseDataValidator.source` above.
  source: v.optional(commentSourceValidator),
});

/**
 * `ManagerMention` as stored on the article (spec §4.2). Drives relationship events.
 *
 * `persona` is optional and only meaningful on a multi-speaker piece (the "Disputed" show,
 * spec: Disputed): which desk member actually made the mention, when that differs from the
 * article's own top-level `persona`. Absent on an ordinary article, where the byline is the
 * only speaker and `relationships.recordArticleMentions` falls back to `article.persona`.
 */
export const managerMentionValidator = v.object({
  teamId: v.string(),
  managerName: v.string(),
  stance: v.union(v.literal("roast"), v.literal("praise"), v.literal("neutral")),
  intensity: v.number(),
  evidence: v.string(),
  persona: v.optional(v.string()),
});

/** Verifier + model bookkeeping for one generation run (spec §4.2). */
export const generationStatsValidator = v.object({
  blocks: v.number(),
  strips: v.number(),
  warns: v.number(),
  sectionsRegenerated: v.number(),
  promptTokens: v.optional(v.number()),
  completionTokens: v.optional(v.number()),
  modelUsed: v.optional(v.string()),
  // Desk metrics (spec §8.7). All optional: a run from before the verifier
  // reported them still saves, and `getDeskMetrics` skips what it does not have.
  factsCount: v.optional(v.number()),
  wordCount: v.optional(v.number()),
  quotesOffered: v.optional(v.number()),
  quotesUsed: v.optional(v.number()),
  // Whole-article regenerations before the article was accepted or held
  // (spec §11.2.8).
  fullRegenerations: v.optional(v.number()),
});

/** The `verifierStats` half of `GeneratedContent.metadata` (spec §4.2 + §8.7). */
export const verifierStatsValidator = v.object({
  blocks: v.number(),
  strips: v.number(),
  warns: v.number(),
  sectionsRegenerated: v.number(),
  factsCount: v.optional(v.number()),
  wordCount: v.optional(v.number()),
  quotesOffered: v.optional(v.number()),
  quotesUsed: v.optional(v.number()),
  // Whole-article regenerations this piece took: the thin retry, or the one
  // full retry the publish gate allows before holding (spec §11.2.8).
  // Optional, like the §8.7 fields, so a run from before it shipped saves.
  fullRegenerations: v.optional(v.number()),
});

/* -------------------------------------------------------------------------- */
/* "Disputed" show transcript                                                  */
/* -------------------------------------------------------------------------- */

/**
 * One turn of a produced "Disputed" episode, as stored on `aiContent.transcript`. Mirrors
 * `src/lib/ai/disputed/types.ts`'s `ShowTurn`, minus `managerMentions` and `claim`: those are
 * extracted once per episode onto the article's own `managerMentions` / `claims` fields (each
 * stamped with the turn's own `persona`), so the transcript stays a plain structured rendering
 * of who said what rather than a second copy of the grounding data.
 */
export const showTurnValidator = v.object({
  speaker: v.string(),
  kind: v.string(),
  text: v.string(),
  jab: v.boolean(),
  factsCited: v.array(v.string()),
  witnessRequested: v.optional(v.string()),
  agreesWithOpponent: v.optional(v.boolean()),
  verdict: v.optional(v.object({ winner: v.string(), reason: v.string() })),
  model: v.optional(v.string()),
  retried: v.optional(v.boolean()),
  // Set by the edit-bay pass: this turn cuts in before the previous speaker finished.
  interrupts: v.optional(v.boolean()),
});


/** One segment of the show's rundown (cold open, opening statements, main event, verdict, last jabs). */
export const showSegmentValidator = v.object({
  id: v.string(),
  title: v.string(),
  turns: v.array(showTurnValidator),
});

/** The full produced transcript for one "Disputed" episode. Mirrors `disputed/types.ts`'s `ShowTranscript`. */
export const showTranscriptValidator = v.object({
  schema: v.literal("ffsn.transcript.v1"),
  show: v.literal("disputed"),
  week: v.optional(v.number()),
  question: v.string(),
  hotSeat: v.optional(
    v.object({
      teamId: v.string(),
      // Optional so a row produced before today (when hotSeat carried no team name) still
      // validates.
      teamName: v.optional(v.string()),
      managerName: v.string(),
      why: v.string(),
    })
  ),
  // The position each debater was assigned in the cold open (one sentence each), so a
  // reader can see what the two of them were actually arguing for.
  // Stored as an array, not an object keyed by slug: Convex field names may not contain hyphens,
  // so `{ "mel-diaper": ... }` fails the schema push (caught 2026-09-03 when codegen refused it).
  // `disputedNode.toStoredTranscript` converts from `ShowTranscript.sides`.
  sides: v.optional(v.array(v.object({ persona: v.string(), position: v.string() }))),
  // The rating this episode was produced at (owner ask, Sept 2026); absent means "clean" -
  // mirrors `ShowTranscript.language` in src/lib/ai/disputed/types.ts.
  language: v.optional(languageRatingValidator),
  // Bookkeeping from the edit-bay pass (pass two), when it ran: how much it cut and which
  // segments it had to leave as pass one produced them.
  edited: v.optional(
    v.object({
      pass: v.string(),
      wordsBefore: v.number(),
      wordsAfter: v.number(),
      segmentsEdited: v.number(),
      segmentsRejected: v.number(),
      rejections: v.array(v.object({ segment: v.string(), reason: v.string() })),
    })
  ),
  segments: v.array(showSegmentValidator),
});
