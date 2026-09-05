// The Wire — shared contract between the Convex side (convex/wire*.ts), the prompt layer
// (src/lib/ai/wire/*) and the UI (src/components/wire/*). Spec: ffsn-the-wire-spec.md.
//
// This file is deliberately dependency-free (types + constants only) so both the Convex default
// runtime and the browser can import it. Nothing here touches the database or the model.
//
// Module map (owners in spec §14):
//   src/lib/ai/wire/types.ts        this contract
//   src/lib/ai/wire/timetable.ts    extractTimetable(text) — verbatim ESPN phrase or undefined (§8.3)
//   src/lib/ai/wire/interest.ts     scoreInterest(card) 0–100 (§7)
//   src/lib/ai/wire/card.ts         validateFactCard, renderCard (plain wire text), cardNumbers/cardNames
//   src/lib/ai/wire/fill.ts         fillVariant(template, slots), defaultVariants(card) (§3.2)
//   src/lib/ai/wire/stock-lines.ts  pickStockLine(persona, kind, slots, seed, rating) (§3.3)
//   src/lib/ai/wire/verify.ts       verifyTake(text, card), verifyLeagueText(text, rating, cleanTeams)
//   src/lib/ai/wire/take.ts         prepareWireTakeRequest / parseWireTakes / generateWireTakes (§3.1)
//   convex/wireSourcesNode.ts       "use node" pollers (ESPN injuries)          → wireEvents
//   convex/wireDetect.ts            detectors + dedupe/coalesce                  → wireEvents, wirePosts
//   convex/wireGenerate.ts          "use node" take batch flush                  → wirePosts.text/variants
//   convex/wireOverlay.ts           per-league fan-out with slot fill            → wireLeaguePosts
//   convex/wireRoutine.ts           league routine posts from existing syncs     → wireLeaguePosts
//   convex/wire.ts                  public queries/mutations for the UI

import type { LanguageRating } from "../language";

/* ------------------------------------------------------------------------------------------- *
 * Event kinds
 * ------------------------------------------------------------------------------------------- */

/** Global kinds are NFL-wide facts shared by every league. P2 kinds are reserved names. */
export const GLOBAL_EVENT_KINDS = [
  // P1
  "injury_status",
  "injury_note",
  "news",
  "depth_chart",
  "trending",
  // P2 (reserved; no detector in P1)
  "game_started",
  "game_final",
  "scoring_play",
  "big_line",
  "bust_watch",
  "weather",
] as const;

/** League kinds happen inside one league; they never get a global post. */
export const LEAGUE_EVENT_KINDS = [
  // Social layer (spec §17): managers post and reply; a writer answers a manager reply.
  "manager_post",
  "manager_reply",
  "writer_reply",
  // P1 (stock lines, no model)
  "waiver_processed",
  "add_drop",
  "trade",
  "week_final",
  "game_of_week",
  "top_score",
  "low_score",
  "bench_points",
  "streak",
  "article_published",
  "claim_settled",
  // P2 (reserved)
  "ir_move",
  "lineup_lock_warning",
  "matchup_live",
  "monday_needs",
  "clinch",
  "elimination",
  "league_record",
  "relationship_tier",
  "quote_approved",
] as const;

export type GlobalEventKind = (typeof GLOBAL_EVENT_KINDS)[number];
export type LeagueEventKind = (typeof LEAGUE_EVENT_KINDS)[number];
export type WireEventKind = GlobalEventKind | LeagueEventKind;

export const GLOBAL_KIND_SET: ReadonlySet<string> = new Set(GLOBAL_EVENT_KINDS);
export const LEAGUE_KIND_SET: ReadonlySet<string> = new Set(LEAGUE_EVENT_KINDS);

export function isGlobalKind(kind: string): kind is GlobalEventKind {
  return GLOBAL_KIND_SET.has(kind);
}
export function isLeagueKind(kind: string): kind is LeagueEventKind {
  return LEAGUE_KIND_SET.has(kind);
}

/* ------------------------------------------------------------------------------------------- *
 * Personas and tags
 * ------------------------------------------------------------------------------------------- */

export type WirePersona =
  | "curtis-vaughn"
  | "sam-ortega"
  | "nina-sharpe"
  | "dex-alvarez"
  | "mel-diaper"
  | "reggie-banks"
  | "walt-brennan";

/** Fixed desk per kind (spec §5). `article_published` uses the article's own byline instead. */
export const WIRE_PERSONA_FOR_KIND: Record<WireEventKind, WirePersona> = {
  injury_status: "dex-alvarez",
  injury_note: "dex-alvarez",
  news: "dex-alvarez",
  depth_chart: "dex-alvarez",
  trending: "nina-sharpe",
  game_started: "curtis-vaughn",
  game_final: "curtis-vaughn",
  scoring_play: "reggie-banks",
  big_line: "reggie-banks",
  bust_watch: "mel-diaper",
  weather: "nina-sharpe",
  manager_post: "curtis-vaughn", // unused: a manager post has an author, not a persona
  manager_reply: "curtis-vaughn", // unused, as above
  writer_reply: "curtis-vaughn", // overridden by the writer being answered
  waiver_processed: "dex-alvarez",
  add_drop: "dex-alvarez",
  trade: "dex-alvarez",
  week_final: "curtis-vaughn",
  game_of_week: "curtis-vaughn",
  top_score: "reggie-banks",
  low_score: "walt-brennan",
  bench_points: "nina-sharpe",
  streak: "curtis-vaughn",
  article_published: "curtis-vaughn", // overridden by the byline at post time
  claim_settled: "nina-sharpe",
  ir_move: "dex-alvarez",
  lineup_lock_warning: "dex-alvarez",
  matchup_live: "curtis-vaughn",
  monday_needs: "nina-sharpe",
  clinch: "curtis-vaughn",
  elimination: "curtis-vaughn",
  league_record: "reggie-banks",
  relationship_tier: "curtis-vaughn", // overridden by the writer in the relationship
  quote_approved: "sam-ortega",
};

/** Tag chips. Dex's tiers (REPORTED / STATED / OPINION) plus the live desk's LIVE / FINAL / UPDATE. */
export const WIRE_TAGS = ["REPORTED", "STATED", "OPINION", "LIVE", "FINAL", "UPDATE"] as const;
export type WireTag = (typeof WIRE_TAGS)[number];

/* ------------------------------------------------------------------------------------------- *
 * Fact card — the only thing the model ever sees (spec §3.1, §8.1)
 * ------------------------------------------------------------------------------------------- */

export type WireSourceType =
  | "espn_injuries"
  | "espn_news"
  | "espn_scoreboard"
  | "espn_summary"
  | "espn_fantasy"
  | "sleeper"
  | "nflverse"
  | "internal";

export interface WireSourceRef {
  type: WireSourceType;
  /** The source's own id for the item (ESPN injury entry id, news espnId, …). */
  id?: string;
  url?: string;
  fetchedAt: number;
}

export interface WireCardPlayer {
  /** ESPN athlete id as a string — the codebase's primary player key (`playersEnhanced.espnId`). */
  espnId: string;
  name: string;
  position?: string;
  nflTeam?: string;
  /** ESPN `ownership.percentOwned` when known (0–100). */
  percentOwned?: number;
  /** FFC positional ADP rank when known (1 = first at the position). */
  adpPositionRank?: number;
}

/** Injury designations as ESPN spells them in `status`. Anything else passes through verbatim. */
export type InjuryStatus =
  | "Active"
  | "Questionable"
  | "Doubtful"
  | "Out"
  | "Injured Reserve"
  | "Suspension"
  | "Physically Unable to Perform"
  | "Non-Football Injury"
  | string;

export interface WireFactCard {
  kind: GlobalEventKind;
  /** The source's own timestamp for the item (ESPN entry `date`, news `published`). */
  observedAt: number;
  players: WireCardPlayer[];
  nflTeam?: string;
  // injury_status
  statusFrom?: InjuryStatus;
  statusTo?: InjuryStatus;
  /** ESPN `shortComment` / news `description`, verbatim, trimmed to 400 chars. Never paraphrased here. */
  note?: string;
  /** News headline, verbatim. */
  headline?: string;
  /** The exact timetable phrase found in `note`/`headline` by timetable.ts, e.g. "6-8 weeks". Absent = no timetable known. */
  timetable?: string;
  // depth_chart
  depthOrderFrom?: number;
  depthOrderTo?: number;
  depthPosition?: string;
  // trending
  trendingAdds?: number;
  source: WireSourceRef;
}

/* ------------------------------------------------------------------------------------------- *
 * Slots and variants (spec §3.2, §3.3)
 * ------------------------------------------------------------------------------------------- */

/**
 * Every token a template may carry, written `{token}`. The model may use only these; fill.ts
 * drops any sentence whose tokens do not all resolve.
 */
export const SLOT_TOKENS = [
  "team", // the fantasy team the post is about
  "ownerTeam", // in an opponent variant: the team that rosters the player
  "opponentTeam",
  "manager", // display name of the team's manager
  "player",
  "pos",
  "nflTeam",
  "status",
  "timetable",
  "faab", // "$31"
  "bestFA", // best free agent at the position in this league
  "backup", // next man up on the NFL depth chart, if unrostered here
  "adp", // FFC overall ADP, e.g. "18.4" (pre-draft keeper leagues, spec §3.2)
  "adpRank", // FFC positional ADP rank, e.g. "QB3"
  "trendingAdds",
  "week",
  "score", // "142.8"
  "opponentScore",
  "margin",
  "points",
  "bid", // "$14"
  "losingBids", // "2 losing bids"
  "record", // "5-2"
  "streak", // "W4"
  "title", // article title
  "url",
  "writer", // display name of a writer
  "claim", // the settled claim text
  "outcome", // "hit" | "miss"
] as const;
export type SlotToken = (typeof SLOT_TOKENS)[number];
export type WireSlots = Partial<Record<SlotToken, string>>;

/**
 * owner / opponent / freeAgent are the in-season variants (spec §3.2). draftBoard is the pre-draft
 * KEEPER-league stand-in for freeAgent: an unrostered player is not "on the wire" before a draft, he
 * is on the board, so the note talks ADP, never waivers. Pre-draft REDRAFT leagues get no overlay.
 */
export type OverlayVariant = "owner" | "opponent" | "freeAgent" | "draftBoard";

/** What one Sonnet call returns per fact card (spec §3.1). Strings ≤ MAX_POST_CHARS. */
export interface WireTakeSet {
  global: string;
  owner?: string;
  opponent?: string;
  freeAgent?: string;
  tags: WireTag[];
}

/* ------------------------------------------------------------------------------------------- *
 * Thresholds and limits (spec §7, §11)
 * ------------------------------------------------------------------------------------------- */

export const MAX_POST_CHARS = 280;
export const MAX_NOTE_CHARS = 400;

/** Interest ≥ this → tier-1 take (one model call, batched). */
export const TAKE_MIN_INTEREST = 50;
/** Interest ≥ this → posted as a plain card; below → stored event only. */
export const CARD_MIN_INTEREST = 25;
/** Added to a global card's interest for a league where the player starts, before the CARD_MIN check. */
export const STARTER_OVERLAY_BONUS = 20;
/** Free-agent overlay only if the player is this widely rostered or trending this hard. */
export const FREE_AGENT_MIN_PERCENT_OWNED = 30;
export const FREE_AGENT_MIN_TRENDING_ADDS = 500;

export const GLOBAL_TAKES_PER_HOUR = 40;
export const LEAGUE_POSTS_PER_HOUR = 15;
export const LEAGUE_POSTS_PER_DAY = 80;
/** Kinds exempt from the per-league limits (they land together by design). `writer_reply` has its
 *  own limits (`WRITER_REPLIES_PER_*` below), so the general per-league cap must not also apply. */
export const LEAGUE_LIMIT_EXEMPT_KINDS: ReadonlySet<string> = new Set([
  "week_final",
  "game_of_week",
  "top_score",
  "low_score",
  "bench_points",
  "writer_reply",
]);

export const TAKE_BATCH_WINDOW_MINUTES = 10;
/** A second event about the same player inside this window edits the first post ("UPDATE:"). */
export const COALESCE_WINDOW_MS = 60 * 60 * 1000;
/** A second source reporting the same status inside this window is a confirmation, not an event. */
export const STATUS_DEDUPE_WINDOW_MS = 6 * 60 * 60 * 1000;
/** Same-player posts inside this window take the §7 penalty. */
export const SAME_PLAYER_PENALTY_WINDOW_MS = 6 * 60 * 60 * 1000;

export const WIRE_DEFAULT_ROUTE = { model: "claude-sonnet-5", effort: "low" } as const;
export const DEFAULT_GLOBAL_DAILY_CAP_USD = 3;

/* ------------------------------------------------------------------------------------------- *
 * Stock lines (spec §3.3)
 * ------------------------------------------------------------------------------------------- */

export interface StockLine {
  /** Template text with `{token}` slots. */
  text: string;
  /**
   * The lowest league rating this line may appear at. "clean" lines are usable everywhere;
   * "salty"/"unfiltered" lines only when the league rating is at least that AND the persona's
   * language allowance at that rating is > 0 AND no featured team has opted down.
   */
  rating: LanguageRating;
  /** Tag chips to attach when this line is used. */
  tags?: WireTag[];
}

/* ------------------------------------------------------------------------------------------- *
 * Social layer (spec §17): reactions, manager posts and replies, writer replies
 * ------------------------------------------------------------------------------------------- */

/** Same set as article reactions (articleReactions.reaction). */
export const WIRE_REACTIONS = ["fire", "lol", "salty", "respect"] as const;
export type WireReaction = (typeof WIRE_REACTIONS)[number];
export type WireReactionCounts = Record<WireReaction, number>;
export const EMPTY_REACTION_COUNTS: WireReactionCounts = { fire: 0, lol: 0, salty: 0, respect: 0 };

/** A reaction on a WRITER's post moves the reader's relationship with that writer by this much
 *  (spec §17.1: a third of the article deltas, rounded to whole points; lol is neutral). */
export const WIRE_REACTION_DELTAS: Record<WireReaction, number> = { fire: 1, lol: 0, salty: -1, respect: 1 };
/** A manager's reply that jabs / thanks the writer it answers (sentiment from the writer-reply call). */
export const WIRE_JAB_DELTA = -4;
export const WIRE_THANKS_DELTA = 4;

export const MANAGER_POST_MAX_CHARS = 280;
export const MANAGER_POSTS_PER_HOUR = 10;
export const MANAGER_POSTS_PER_DAY = 40;
/** Writer replies (one Sonnet call each): per manager per hour, per league per day, per thread. */
export const WRITER_REPLIES_PER_MANAGER_PER_HOUR = 3;
export const WRITER_REPLIES_PER_LEAGUE_PER_DAY = 30;
export const WRITER_REPLIES_PER_THREAD_PER_MANAGER = 2;
/** Sam chases a standalone manager post with one question this often (seeded), at most once per manager per day. */
export const SAM_CHASE_ONE_IN = 3;
/** How many prior turns of a thread the writer-reply call sees. */
export const MAX_THREAD_CONTEXT = 6;
/** Manager wire statements stay quotable by the article writers for this long. */
export const WIRE_STATEMENT_QUOTABLE_MS = 7 * 24 * 60 * 60 * 1000;
/** Content types that never draw a manager's Wire statements into their FACTS block (spec §17.5) -
 *  a mock draft, draft rankings/strategy guide and the season welcome all run before or outside
 *  the season's Wire activity, so there is nothing relevant for them to quote. */
export const WIRE_STATEMENT_EXCLUDED_CONTENT_TYPES: ReadonlySet<string> = new Set([
  "mock_draft",
  "draft_rankings",
  "draft_strategy_guide",
  "season_welcome",
]);

/**
 * Where a ledger quote came from (spec §17.4): a Sam interview (the default, and what every quote
 * was before the Wire) or a manager's public post on The Wire. Carried on `CommentResponseData`,
 * `FactsBlock.quotes[]` and the stored article quote; the article prompt attributes "wire" quotes
 * as said on The Wire, never as told to Sam.
 */
export type WireQuoteSource = "interview" | "wire";

/** Where a reply hangs: a global writer post or a league post. */
export interface WireReplyTarget {
  scope: "global" | "league";
  id: string;
}

/** The manager behind a manager post/reply, as the UI shows it. */
export interface WireAuthorRef {
  /** Clerk subject. */
  userId: string;
  displayName: string;
  team?: WireTeamRef;
}

export type ManagerTextRating = LanguageRating;

/** `moderateManagerText` (src/lib/ai/wire/moderate.ts): what a manager may post at this league's rating. */
export interface ModerationResult {
  ok: boolean;
  /** Trimmed, whitespace-collapsed text (unchanged content). */
  text: string;
  /** Human-readable reasons, e.g. "Too long (312/280)", "This league is rated Clean: drop 'damn'". */
  violations: string[];
}

export type WriterReplySentiment = "jab" | "thanks" | "neutral";

/** Input to `generateWriterReply` (src/lib/ai/wire/reply.ts). */
export interface WriterReplyInput {
  persona: WirePersona;
  /** "reply": answer a manager who replied to this writer's post. "chase": Sam asks one follow-up on a standalone manager post. */
  mode: "reply" | "chase";
  /** The writer's own post the manager replied to (absent in chase mode). */
  writerPostText?: string;
  /** The fact card behind that post when it was a global post - the only facts the writer may restate. */
  card?: WireFactCard;
  /** The manager's text being answered (or, in chase mode, the standalone post). */
  managerText: string;
  manager: { displayName: string; teamName: string; relationshipTier: string; recentEvidence: string[] };
  /** Earlier turns in this thread, oldest first, at most MAX_THREAD_CONTEXT. */
  thread: Array<{ author: "writer" | "manager"; text: string }>;
  languageRating: LanguageRating;
  /** True when the manager opted their team down to clean language. */
  cleanTeam: boolean;
  week?: number;
}

export interface WriterReplyResult {
  /** Absent when the model's answer failed verification - no reply is posted. */
  text?: string;
  /** How the MANAGER's text read to the writer: drives the relationship meter (spec §17.3). */
  sentiment: WriterReplySentiment;
  flags: string[];
  costUsd: number;
  model: string;
  effort: string;
}

/** Reactions on one post as the UI renders them. */
export interface WireReactionsView {
  counts: WireReactionCounts;
  /** The viewer's own reaction, if any. */
  mine?: WireReaction;
}

/** One reply in a thread: a manager (author) or a writer (persona). */
export interface WireReplyView {
  _id: string;
  kind: "manager_reply" | "writer_reply";
  author?: WireAuthorRef;
  persona?: string;
  text: string;
  createdAt: number;
  reactions: WireReactionsView;
  /** Soft-deleted by the author or the commissioner; text is the placeholder. */
  deleted?: boolean;
}

/* ------------------------------------------------------------------------------------------- *
 * Post statuses and query view shapes (what convex/wire.ts returns, what the UI renders)
 * ------------------------------------------------------------------------------------------- */

export type WirePostStatus = "card" | "take_pending" | "take" | "held";

export interface WireGenerationStats {
  costUsd: number;
  model: string;
  effort: string;
  batchId?: string;
  /** Verifier/fallback flags, e.g. "take_failed_verify", "card_fallback", "rate_limited". */
  flags: string[];
}

export interface WireTeamRef {
  teamId: string;
  name: string;
  abbreviation?: string;
  logo?: string;
}

/** One league-tier post: an overlay under a global post, or a routine league item. */
export interface WireLeaguePostView {
  _id: string;
  leagueId: string;
  kind: WireEventKind;
  /** The writer, for desk posts; absent on a manager post (see `author`). */
  persona?: string;
  /** The manager, on a manager_post. */
  author?: WireAuthorRef;
  text: string;
  tags: WireTag[];
  week?: number;
  createdAt: number;
  reactions: WireReactionsView;
  /** Manager and writer replies on this post, oldest first. */
  replies: WireReplyView[];
  deleted?: boolean;
  /** True when the viewer may delete this post (author or commissioner). */
  canDelete: boolean;
  /** Set on overlays; the UI nests these under their global post and never lists them alone. */
  globalPostId?: string;
  impact?: {
    team: WireTeamRef;
    variant: OverlayVariant;
  };
  featuredTeams: WireTeamRef[];
}

/** One global post, with this league's overlays attached when the league has a pass. */
export interface WireGlobalPostView {
  _id: string;
  kind: GlobalEventKind;
  persona: string;
  text: string;
  tags: WireTag[];
  status: WirePostStatus;
  interest: number;
  createdAt: number;
  updatedAt: number;
  players: WireCardPlayer[];
  nflTeam?: string;
  timetable?: string;
  source: { type: WireSourceType; url?: string };
  overlays: WireLeaguePostView[];
  reactions: WireReactionsView;
  /** This league's manager and writer replies on the global post, oldest first. */
  replies: WireReplyView[];
}

/** `wire.getWireStatus` — what the page needs before it renders anything. */
export interface WireStatusView {
  passActive: boolean;
  wireEnabled: boolean;
  isCommissioner: boolean;
  /** The viewer's claimed team in this league; posting requires one. */
  myTeam?: WireTeamRef;
  /** The league's language rating, for the composer's hint. */
  languageRating: LanguageRating;
}

/** `wire.getRecentForTicker` item: newest global + league posts, merged, for the header strip. */
export interface WireTickerItem {
  _id: string;
  /** Writer slug, or absent for a manager post (then `authorName` is set). */
  persona?: string;
  authorName?: string;
  text: string;
  tags: WireTag[];
  createdAt: number;
  scope: "global" | "league";
}
