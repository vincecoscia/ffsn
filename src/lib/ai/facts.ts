// The FACTS block — the single normative source of truth for a generated article.
//
// `buildFactsBlock` flattens whatever `LeagueDataContext` shape the data layer produced into one
// stable, id-bearing JSON document. The model may only state facts that appear here, and
// `fact-verifier.ts` checks the finished article against this exact object.
//
// Two shape hazards this module deliberately absorbs:
//  - Matchups: the generic query returns raw ESPN ids in `teamA`/`teamB` with the names in
//    `teamAName`/`teamBName`; the weekly-recap query returns names in `teamA`/`teamB`. Both resolve.
//  - Players: `fantasyTeamId` / `fantasyTeamName` / `nflTeam` are read when present. The legacy
//    `team` key (which means "NFL team" on one path and "fantasy team" on another) is only a
//    last-resort fallback and is never emitted as-is.

import { contentTemplates } from "./content-templates";
import type { RelationshipTier } from "./persona-prompts";
import type { LeagueDataContext, LeagueFormat, WaiverLedger, WaiverLedgerSeason } from "./prompt-builder";
import type {
  CommentResponseData,
  NonRespondent,
  PriorRecord,
  RelationshipEventSummary,
  WriterRelationshipContext,
} from "./content-generation-service";

export interface FactsTeam {
  /** `"T" + externalId` — the id the model must cite. */
  id: string;
  /** The Convex `Id<"teams">` as a string, for write-back. */
  teamId: string;
  name: string;
  manager?: string;
  record: string;
  pointsFor?: number;
  rank?: number;
  /** The division's display name, when the league has divisions. */
  division?: string;
}

export interface FactsFormatDivision {
  id: string;
  name: string;
}

/**
 * League-format facts (audit: leagues differ in scoring, roster shape, playoff structure,
 * divisions and waivers, and the writers had no way to know any of it). Every field here is
 * plain English — a writer must never see a raw settings key or an ESPN enum value. Built once
 * per article by `buildFormat` from `LeagueDataContext.leagueFormat`, itself assembled by
 * `convex/aiQueries.ts#buildLeagueFormat`.
 */
export interface FactsFormat {
  /** e.g. "Half-PPR (0.5 points per reception)" or "0.25 points per reception". */
  scoring?: string;
  /** e.g. "1QB/2RB/2WR/1TE/1FLEX/1DST/1K (superflex)". */
  rosterShape?: string;
  regularSeasonWeeks?: number;
  playoffTeamCount?: number;
  playoffRounds?: number;
  /** 2 when a playoff round spans two real weeks, otherwise 1. */
  playoffRoundLengthWeeks?: number;
  /** e.g. "Weeks 15-18". */
  playoffWeeksRange?: string;
  /** Plain English, e.g. "division winners are seeded first, then the rest by record". */
  seedingRule?: string;
  divisions: FactsFormatDivision[];
  /** e.g. "FAAB waivers, $100 season budget". */
  waiverType?: string;
  /** Plain-English instant, e.g. "Tue, Nov 18, 11:59 PM ET". Never a raw timestamp. */
  tradeDeadline?: string;
  tradeDeadlineStatus?: "passed" | "soon" | "upcoming";
  isSuperflex?: boolean;
  hasIdp?: boolean;
}

/**
 * Waiver/FAAB facts (owner goal, 2026-09-02: the waiver wire report must take FAAB spend into
 * account — winning bids, losing bids, remaining budgets, season highlights and Sam's interview
 * questions should all use these numbers). Built once per article by `buildWaivers` from
 * `LeagueDataContext.waivers`, itself assembled server-side by `convex/aiQueries.ts#buildWaiverLedger`.
 * Every dollar figure a writer prints must come from one of these `W…`/`B…` ids — see the
 * `faab_amount_unverified` check in `fact-verifier.ts`.
 */
export interface FactsWaiverClaim {
  /** `"W" + index`, 1-based. */
  id: string;
  week: number;
  player: { id: string; name: string; pos: string; nflTeam?: string };
  teamId: string;
  teamName: string;
  manager?: string;
  bid: number;
  /** Losing bids for this same player in this same run, highest first. Empty for an uncontested claim. */
  competingBids: Array<{ teamId: string; teamName: string; bid: number }>;
  dropped?: { name: string; pos?: string };
  /**
   * Ready-to-cite Broadcast-register line, e.g. "W3 · Week 4 · Gabe Coscia won Tank Bigsby for $23
   * (outbid Moisty Loins $17, Team Rive $12); dropped Zach Charbonnet". Paraphrase it; never invent
   * a different number than the one printed here.
   */
  line: string;
}

/** One team's FAAB position: budget, spend and what is left, for the whole season so far. */
export interface FactsWaiverBudget {
  /** `"B" + index`, 1-based. */
  id: string;
  teamId: string;
  teamName: string;
  manager?: string;
  budget?: number;
  spent?: number;
  remaining?: number;
  acquisitions?: number;
  /** Ready-to-cite Broadcast-register line, e.g. "B2 · Moisty Loins: $61 of $100 left, 7 pickups". */
  line: string;
}

export interface FactsWaivers {
  /** False for "waivers" (rolling priority) or "free_agency" leagues — never print a dollar figure. */
  isFaab: boolean;
  /** The most recent scoring period with at least one executed waiver claim, if any. */
  latestRun?: { week: number; claims: FactsWaiverClaim[] };
  budgets: FactsWaiverBudget[];
  season: {
    biggestBid?: { teamId: string; teamName: string; player: string; bid: number; week: number };
    mostActive?: { teamId: string; teamName: string; acquisitions: number };
    /** Teams with the least FAAB left, ascending. */
    lowestRemaining: Array<{ teamId: string; teamName: string; remaining: number }>;
    totalSpent?: number;
    averageWinningBid?: number;
  };
}

export interface FactsPlayer {
  id: string;
  name: string;
  pos: string;
  nflTeam?: string;
  fantasyTeamId: string;
  points: number;
  projected?: number;
  lineup: "starter" | "bench";
  benchImpact?: { wouldHaveReplaced: string; pointGain: number };
}

export interface FactsMatchup {
  id: string;
  week: number;
  bracket?: string;
  home: { teamId: string; score: number; projected?: number; benchPoints?: number };
  away: { teamId: string; score: number; projected?: number; benchPoints?: number };
  winnerTeamId?: string;
  margin?: number;
  closeness?: string;
  isUpset?: boolean;
  players: FactsPlayer[];
}

/** One side of an unplayed game. There is no score here because there is no game yet. */
export interface FactsUpcomingSide {
  teamId: string;
  /** "w-l-t" going into the game. */
  record?: string;
  pointsFor?: number;
  /** ESPN's published projection for this game, when it has one. Never a result. */
  projected?: number;
}

/** A game on the look-ahead slate (spec 4.3). Its id space is `U1`, `U2`, ... */
export interface FactsUpcoming {
  id: string;
  week: number;
  home: FactsUpcomingSide;
  away: FactsUpcomingSide;
  /** Meetings already played between these two, so the writer can cite real history. */
  headToHead?: { homeWins: number; awayWins: number };
  isPlayoff?: boolean;
}

export interface FactsBlock {
  schema: "ffsn.facts.v1";
  league: { name: string; week?: number; season: number; teamCount: number; scoring?: string };
  /** League-format facts (scoring, roster shape, playoff structure, divisions, waivers). */
  format: FactsFormat;
  /** The FAAB/waiver ledger (owner goal: waivers must take FAAB spend into account). */
  waivers: FactsWaivers;
  teams: FactsTeam[];
  matchups: FactsMatchup[];
  /** Games that have NOT been played, for `weekly_preview`. Empty for every other type. */
  upcoming: FactsUpcoming[];
  standings: Array<{
    rank: number;
    teamId: string;
    record: string;
    pointsFor: number;
    streak?: string;
    /** ESPN's authoritative playoff seed, when known. May diverge from `rank` on older data. */
    seed?: number;
    /** The division's display name, when the league has divisions. */
    division?: string;
  }>;
  transactions: Array<{
    id: string;
    teamId: string;
    type: string;
    playerAdded?: string;
    playerDropped?: string;
    faab?: number;
    week?: number;
    timestamp?: number;
    /** The same instant in plain English (ET), for prose; the writer must never print `timestamp`. */
    when?: string;
  }>;
  trades: Array<{
    id: string;
    week?: number;
    timestamp?: number;
    /** The same instant in plain English (ET), for prose; the writer must never print `timestamp`. */
    when?: string;
    sides: Array<{ teamId: string; gave: string[]; received: string[] }>;
  }>;
  draftPicks?: Array<{
    id: string;
    teamId: string;
    overall: number;
    round: number;
    pickInRound: number;
    player: string;
    pos: string;
    adp?: number;
    adpDelta?: number;
    projected?: number;
  }>;
  quotes: Array<{ id: string; speaker: string; teamId: string; questionTopic: string; text: string }>;
  nonRespondents: Array<{ speaker: string; teamId: string; status: "no_response" | "declined" }>;
  relationships: Array<{
    teamId: string;
    manager: string;
    score: number;
    tier: RelationshipTier;
    recentEvents: RelationshipEventSummary[];
  }>;
  priorClaims: Array<{ id: string; week?: number; claim: string; outcome?: "hit" | "miss" | "open" }>;
  /** The writer's standing record in this league (spec §8.4). Absent when nothing has resolved. */
  priorRecord?: PriorRecord;
  missing: string[];
}

/**
 * The subset of a `GenerationRequest` the FACTS builder needs. A full `GenerationRequest` is
 * assignable to this, so `buildFactsBlock(request)` is the normal call.
 */
export interface FactsRequest {
  leagueId?: string;
  contentType: string;
  persona?: string;
  leagueData: LeagueDataContext;
  commentResponses?: CommentResponseData[];
  nonRespondents?: NonRespondent[];
  relationships?: WriterRelationshipContext[];
  priorClaims?: Array<{ articleId?: string; week?: number; claim: string; outcome?: "hit" | "miss" | "open" }>;
  priorRecord?: PriorRecord;
}

type Loose = Record<string, unknown>;

function asLoose(value: unknown): Loose {
  return (value && typeof value === "object" ? value : {}) as Loose;
}

function str(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  if (typeof value === "number") return String(value);
  return undefined;
}

function num(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return round1(value);
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return round1(Number(value));
  }
  return undefined;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function formatRecord(record?: { wins?: number; losses?: number; ties?: number }): string {
  if (!record) return "0-0-0";
  return `${record.wins ?? 0}-${record.losses ?? 0}-${record.ties ?? 0}`;
}

/** "Thu, Oct 9, 6:30 PM ET" — the only form of a date or time the writer should ever print. */
function toWhen(timestamp: number | undefined): string | undefined {
  if (timestamp === undefined) return undefined;
  try {
    return new Intl.DateTimeFormat("en-US", {
      weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
      timeZone: "America/New_York", timeZoneName: "short",
    }).format(new Date(timestamp));
  } catch {
    return undefined;
  }
}

/* -------------------------------------------------------------------------- *
 * FORMAT block (audit: leagues differ in scoring, roster shape, playoff structure, divisions and
 * waivers; the writers had no way to know any of it). Every function below turns a raw settings
 * value into the plain English the grounding contract requires — no ESPN enum, no field name, no
 * raw timestamp ever reaches the model.
 * -------------------------------------------------------------------------- */

const STANDARD_RECEPTION_LABELS: Record<string, string> = {
  "1": "PPR (1 point per reception)",
  "0.5": "Half-PPR (0.5 points per reception)",
  "0": "Standard (no points per reception)",
};

/**
 * Reception points can be 1, 0.5, 0.25 or absent (live ESPN payloads carry all of these). Prefer
 * the number when it is not one of the three standard values; the label otherwise.
 */
export function scoringLabel(rawScoringType: string | undefined, receptionPoints: number | undefined): string | undefined {
  if (typeof receptionPoints === "number" && Number.isFinite(receptionPoints)) {
    const standard = STANDARD_RECEPTION_LABELS[String(receptionPoints)];
    if (standard) return standard;
    return `${receptionPoints} point${receptionPoints === 1 ? "" : "s"} per reception`;
  }
  const normalized = rawScoringType?.trim().toLowerCase().replace(/[\s-]+/g, "_");
  switch (normalized) {
    case "ppr":
      return STANDARD_RECEPTION_LABELS["1"];
    case "half_ppr":
      return STANDARD_RECEPTION_LABELS["0.5"];
    case "standard":
      return STANDARD_RECEPTION_LABELS["0"];
    case "custom":
    case undefined:
      return rawScoringType || undefined;
    default:
      return rawScoringType;
  }
}

/** ESPN's `playoffSeedingRule` enum, in plain English. */
export function seedingRuleLabel(rule: string | undefined): string | undefined {
  switch (rule) {
    case "DIVISION_WINNERS":
      return "division winners are seeded first, then the rest of the field by record";
    case "H2H_RECORD":
      return "seeded by head-to-head record";
    case "TOTAL_POINTS_SCORED":
      return "seeded by total points scored";
    default:
      return undefined;
  }
}

/** ESPN's `waiverType` enum plus FAAB budget, in plain English. */
export function waiverTypeLabel(type: string | undefined, faabBudget: number | undefined): string | undefined {
  switch (type) {
    case "faab":
      return faabBudget ? `FAAB waivers, $${faabBudget} season budget` : "FAAB waivers";
    case "waivers":
      return "standard rolling waivers";
    case "free_agency":
      return "free agency, first come first served";
    default:
      return undefined;
  }
}

const ROSTER_SLOT_ORDER = ["QB", "RB", "WR", "TE", "FLEX", "SUPERFLEX", "DST", "D/ST", "K", "IDP", "BE", "BENCH"];

/** A lineup-slot map (already keyed by position label) rendered as "1QB/2RB/2WR/1TE/1FLEX". */
export function rosterShapeLabel(
  lineupSlots: Record<string, number> | undefined,
  isSuperflex: boolean | undefined,
  hasIdp: boolean | undefined
): string | undefined {
  if (!lineupSlots) return undefined;
  const parts: string[] = [];
  for (const key of ROSTER_SLOT_ORDER) {
    const count = lineupSlots[key];
    if (count) parts.push(`${count}${key}`);
  }
  for (const [key, count] of Object.entries(lineupSlots)) {
    if (!ROSTER_SLOT_ORDER.includes(key) && count) parts.push(`${count}${key}`);
  }
  if (parts.length === 0) return undefined;
  let shape = parts.join("/");
  const extras: string[] = [];
  if (isSuperflex) extras.push("superflex");
  if (hasIdp) extras.push("IDP");
  if (extras.length > 0) shape += ` (${extras.join(", ")})`;
  return shape;
}

/** "passed" once the deadline instant is behind us, "soon" inside a two-week window, else "upcoming". */
export function tradeDeadlineStatus(deadlineMs: number | undefined): FactsFormat["tradeDeadlineStatus"] {
  if (deadlineMs === undefined) return undefined;
  const now = Date.now();
  if (deadlineMs < now) return "passed";
  const TWO_WEEKS_MS = 14 * 24 * 60 * 60 * 1000;
  return deadlineMs - now <= TWO_WEEKS_MS ? "soon" : "upcoming";
}

/**
 * Assembles the FORMAT facts from `data.leagueFormat` (spec: format audit). Every field is
 * optional — a league on an old sync, or one the settings migration has not reached yet, simply
 * carries fewer of them, and the writer is told the gap through `facts.missing` rather than a
 * guess.
 */
export function buildFormat(data: LeagueDataContext): FactsFormat {
  const fmt: LeagueFormat = (data as Loose).leagueFormat as LeagueFormat | undefined ?? {};
  const regularSeasonWeeks = fmt.regularSeasonMatchupPeriods ?? data.regularSeasonWeeks;
  const playoffTeamCount = fmt.playoffTeamCount ?? data.playoffTeams;
  const divisions: FactsFormatDivision[] = (fmt.divisions ?? []).map(division => ({
    id: division.id,
    name: division.name,
  }));

  return {
    scoring: scoringLabel(fmt.scoringType ?? data.scoringType, fmt.receptionPoints),
    rosterShape: rosterShapeLabel(fmt.lineupSlots, fmt.isSuperflex, fmt.hasIdp),
    regularSeasonWeeks,
    playoffTeamCount,
    playoffRounds: fmt.playoffRounds,
    playoffRoundLengthWeeks: fmt.playoffMatchupPeriodLength,
    playoffWeeksRange: fmt.playoffWeeksRange,
    seedingRule: seedingRuleLabel(fmt.playoffSeedingRule),
    divisions,
    waiverType: waiverTypeLabel(fmt.waiverType, fmt.faabBudget),
    tradeDeadline: toWhen(fmt.tradeDeadline),
    tradeDeadlineStatus: tradeDeadlineStatus(fmt.tradeDeadline),
    isSuperflex: fmt.isSuperflex,
    hasIdp: fmt.hasIdp,
  };
}

/** "B2 · Moisty Loins: $61 of $100 left, 7 pickups" — or the honest gap when budgets aren't tracked. */
function waiverBudgetLine(
  id: string,
  budget: { teamName: string; budget?: number; remaining?: number; acquisitions?: number }
): string {
  if (budget.budget === undefined || budget.remaining === undefined) {
    return `${id} · ${budget.teamName}: FAAB budget not tracked this season`;
  }
  const pickups =
    budget.acquisitions !== undefined
      ? `, ${budget.acquisitions} pickup${budget.acquisitions === 1 ? "" : "s"}`
      : "";
  return `${id} · ${budget.teamName}: $${round1(budget.remaining)} of $${round1(budget.budget)} left${pickups}`;
}

/** "W3 · Week 4 · Gabe Coscia won Tank Bigsby for $23 (outbid Moisty Loins $17, Team Rive $12); dropped Zach Charbonnet". */
function waiverClaimLine(
  id: string,
  claim: {
    week: number;
    player: { name: string };
    teamName: string;
    manager?: string;
    bid: number;
    competingBids: Array<{ teamName: string; bid: number }>;
    dropped?: { name: string };
  }
): string {
  const winner = claim.manager ?? claim.teamName;
  const outbid =
    claim.competingBids.length > 0
      ? ` (outbid ${claim.competingBids.map(bid => `${bid.teamName} $${round1(bid.bid)}`).join(", ")})`
      : "";
  const dropped = claim.dropped ? `; dropped ${claim.dropped.name}` : "";
  return `${id} · Week ${claim.week} · ${winner} won ${claim.player.name} for $${round1(claim.bid)}${outbid}${dropped}`;
}

/**
 * Assembles the WAIVERS facts from `data.waivers` (owner goal: the waiver wire report must take
 * FAAB spend into account). `data.waivers` is built server-side by
 * `convex/aiQueries.ts#buildWaiverLedger`; this function only assigns the `W…`/`B…` ids, resolves
 * every team reference against the same `TeamIndex` every other FACTS section uses, and writes the
 * one Broadcast-register line per row that a writer may cite. Absent entirely (older payload, or a
 * league with no waiver activity yet) simply yields empty arrays — never a guess.
 */
export function buildWaivers(data: LeagueDataContext, teams: TeamIndex): FactsWaivers {
  const raw: WaiverLedger | undefined = (data as Loose).waivers as WaiverLedger | undefined;
  const isFaab = raw?.waiverType === "faab";

  const claims: FactsWaiverClaim[] = (raw?.latestRun?.claims ?? []).map((claim, index) => {
    const id = `W${index + 1}`;
    const competingBids = claim.competingBids.map(bid => ({
      teamId: teams.resolve(bid.teamId, bid.teamName),
      teamName: bid.teamName,
      bid: round1(bid.bid),
    }));
    return {
      id,
      week: claim.week,
      player: claim.player,
      teamId: teams.resolve(claim.teamId, claim.teamName),
      teamName: claim.teamName,
      manager: claim.manager,
      bid: round1(claim.bid),
      competingBids,
      dropped: claim.dropped,
      line: waiverClaimLine(id, { ...claim, competingBids }),
    };
  });

  const budgets: FactsWaiverBudget[] = (raw?.budgets ?? []).map((budget, index) => {
    const id = `B${index + 1}`;
    return {
      id,
      teamId: teams.resolve(budget.teamId, budget.teamName),
      teamName: budget.teamName,
      manager: budget.manager,
      budget: budget.budget,
      spent: budget.spent === undefined ? undefined : round1(budget.spent),
      remaining: budget.remaining === undefined ? undefined : round1(budget.remaining),
      acquisitions: budget.acquisitions,
      line: waiverBudgetLine(id, budget),
    };
  });

  const rawSeason: WaiverLedgerSeason | undefined = raw?.season;

  return {
    isFaab,
    latestRun: raw?.latestRun ? { week: raw.latestRun.scoringPeriod, claims } : undefined,
    budgets,
    season: {
      biggestBid: rawSeason?.biggestBid
        ? {
            teamId: teams.resolve(rawSeason.biggestBid.teamId, rawSeason.biggestBid.teamName),
            teamName: rawSeason.biggestBid.teamName,
            player: rawSeason.biggestBid.player,
            bid: round1(rawSeason.biggestBid.bid),
            week: rawSeason.biggestBid.week,
          }
        : undefined,
      mostActive: rawSeason?.mostActive
        ? {
            teamId: teams.resolve(rawSeason.mostActive.teamId, rawSeason.mostActive.teamName),
            teamName: rawSeason.mostActive.teamName,
            acquisitions: rawSeason.mostActive.acquisitions,
          }
        : undefined,
      lowestRemaining: (rawSeason?.lowestRemaining ?? []).map(entry => ({
        teamId: teams.resolve(entry.teamId, entry.teamName),
        teamName: entry.teamName,
        remaining: round1(entry.remaining),
      })),
      totalSpent: rawSeason?.totalSpent === undefined ? undefined : round1(rawSeason.totalSpent),
      averageWinningBid: rawSeason?.averageWinningBid,
    },
  };
}

/**
 * ESPN's draft detail carries no ADP; when the sync cannot join a real ADP it stores one default
 * for every pick (production 2025: all 170 picks at 170.0). Grading against that would call the
 * first overall pick a 169-slot steal. Treat a near-constant ADP column as "no ADP".
 */
export function adpLooksLikePlaceholder(
  picks: ReadonlyArray<{ playerADP?: number | null }> | undefined
): boolean {
  const values = (picks ?? [])
    .map(pick => pick.playerADP)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (values.length < 8) return false;
  const counts = new Map<number, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  const mostCommon = Math.max(...counts.values());
  return mostCommon / values.length >= 0.8;
}

function toTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return undefined;
}

/**
 * Recomputes the `requiredData` gaps for a content type. This is the same computation the old
 * `PromptBuilder.validateRequiredData` did privately; it lives here so the result can reach the
 * prompt as `facts.missing` instead of only reaching `console.warn`.
 */
export function computeMissingRequiredData(contentType: string, data: LeagueDataContext): string[] {
  const template = contentTemplates[contentType];
  if (!template) return [];
  const missing: string[] = [];

  for (const field of template.requiredData) {
    switch (field) {
      case "historical_data":
        if (!data.previousSeasons || Object.keys(data.previousSeasons).length === 0) {
          missing.push("historical_data (previousSeasons) — not available");
        }
        break;
      case "all_time_records":
        if (!data.leagueHistory?.allTimeRecords || Object.keys(data.leagueHistory.allTimeRecords).length === 0) {
          missing.push("all_time_records — not available");
        }
        break;
      case "championship_history":
        if (!data.leagueHistory?.seasons || data.leagueHistory.seasons.length === 0) {
          missing.push("championship_history — not available");
        }
        break;
      case "upcoming_matchups":
        if (!data.upcomingMatchups || data.upcomingMatchups.length === 0) {
          missing.push("upcoming matchups — not available");
        }
        break;
      case "matchup_results":
        if (!data.recentMatchups || data.recentMatchups.length === 0) {
          missing.push("matchup_results — no matchups in the payload");
        }
        break;
      case "player_scores": {
        // The weekly-recap path carries rosters on the matchups, not on the teams; either counts.
        const onTeams = data.teams?.some(team => team.roster && team.roster.length > 0);
        const onMatchups = (data.recentMatchups ?? []).some(matchup => {
          const loose = asLoose(matchup);
          const home = Array.isArray(loose.homeRoster) ? loose.homeRoster.length : 0;
          const away = Array.isArray(loose.awayRoster) ? loose.awayRoster.length : 0;
          const top = Array.isArray(loose.topPerformers) ? loose.topPerformers.length : 0;
          return home + away + top > 0;
        });
        if (!onTeams && !onMatchups) {
          missing.push("player_scores (rosters) — not available");
        }
        break;
      }
      case "standings":
        if (!data.standings || data.standings.length === 0) {
          missing.push("standings — not available");
        }
        break;
      case "draft_order":
        if (!data.draftOrder || data.draftOrder.length === 0) {
          missing.push("draft_order — not available");
        }
        break;
      case "available_players":
        if (!data.availablePlayers || data.availablePlayers.length === 0) {
          missing.push("available_players — not available");
        }
        break;
      case "trade_details":
        if (!data.trades || data.trades.length === 0) {
          missing.push("trade_details — no trades in the payload");
        }
        break;
      case "rivalry_history":
        if (!data.rivalries || data.rivalries.length === 0) {
          missing.push("rivalry_history — no imported rivalry records");
        }
        break;
      case "draft_results":
        if (!data.draftPicks || data.draftPicks.length === 0) {
          missing.push("draft_results (draftPicks) — not available");
        }
        break;
      case "team_rosters":
        if (!data.teams || data.teams.length === 0) {
          missing.push("team_rosters (teams) — not available");
        }
        break;
      case "player_projections":
        if (!data.draftPicks || !data.draftPicks.some(pick => pick.playerProjectedPoints !== null)) {
          missing.push("player_projections — not available");
        }
        break;
      case "league_settings":
        if (!data.scoringType && !data.totalTeams && !data.draftType) {
          missing.push("league_settings — not available");
        }
        break;
      case "injuries":
        if (!data.injuryReport || data.injuryReport.length === 0) {
          missing.push("injuryReport — not collected for this content type");
        }
        break;
      default:
        break;
    }
  }

  return missing;
}

/** Resolves any of (FACTS id, ESPN external id, Convex id, team name) to a FACTS team id. */
class TeamIndex {
  private byKey = new Map<string, string>();
  readonly teams: FactsTeam[] = [];

  constructor(data: LeagueDataContext) {
    const standingsByKey = new Map<string, { rank: number; streak?: string; pointsFor?: number }>();
    (data.standings ?? []).forEach(row => {
      const entry = {
        rank: row.rank,
        streak: row.streakType && row.streakLength ? `${row.streakType}${row.streakLength}` : undefined,
        pointsFor: num(row.pointsFor),
      };
      if (row.teamId) standingsByKey.set(row.teamId.toLowerCase(), entry);
      if (row.team) standingsByKey.set(row.team.toLowerCase(), entry);
    });

    (data.teams ?? []).forEach((team, index) => {
      const loose = asLoose(team);
      const external = str(team.externalId) ?? str(team.id) ?? String(index + 1);
      const id = `T${external}`;
      const standing =
        (team.externalId ? standingsByKey.get(String(team.externalId).toLowerCase()) : undefined) ??
        (team.id ? standingsByKey.get(String(team.id).toLowerCase()) : undefined) ??
        (team.name ? standingsByKey.get(team.name.toLowerCase()) : undefined);

      const factsTeam: FactsTeam = {
        id,
        teamId: str(team.id) ?? "",
        name: team.name,
        manager: str(team.manager) ?? str(loose.owner),
        record: formatRecord(team.record),
        pointsFor: num(team.pointsFor) ?? num(team.record?.pointsFor) ?? standing?.pointsFor,
        rank: standing?.rank ?? team.playoffSeed,
        division: str(loose.division),
      };
      this.teams.push(factsTeam);

      this.register(id, id);
      this.register(external, id);
      this.register(str(team.id), id);
      this.register(team.name, id);
      this.register(str(loose.abbreviation), id);
      // Team documents are per season, so a standings row from a past season carries a different
      // Convex id and possibly a different team name. The owner is the same person: register it.
      this.register(str(team.manager) ?? str(loose.owner), id);
      this.register(str(loose.owner), id);
    });
  }

  private register(key: string | undefined, id: string) {
    if (!key) return;
    const normalized = key.trim().toLowerCase();
    if (normalized.length === 0) return;
    if (!this.byKey.has(normalized)) this.byKey.set(normalized, id);
  }

  /** Returns the FACTS team id, or `"T?"` when the value cannot be resolved. */
  resolve(...candidates: Array<unknown>): string {
    for (const candidate of candidates) {
      const key = str(candidate);
      if (!key) continue;
      const hit = this.byKey.get(key.trim().toLowerCase());
      if (hit) return hit;
    }
    return "T?";
  }
}

function collectMatchupSources(data: LeagueDataContext): Loose[] {
  const playoff = asLoose((data as Loose).playoffBreakdown);
  const buckets: unknown[] = [
    playoff.championshipGame ? [playoff.championshipGame] : [],
    playoff.playoffMatchups,
    playoff.consolationMatchups,
    playoff.regularSeasonMatchups,
  ];
  const fromPlayoff = buckets.flatMap(bucket => (Array.isArray(bucket) ? bucket : []));
  if (fromPlayoff.length > 0) return fromPlayoff.map(asLoose);
  return (data.recentMatchups ?? []).map(asLoose);
}

function buildMatchupPlayers(matchup: Loose, matchupId: string, teams: TeamIndex, homeId: string, awayId: string): FactsPlayer[] {
  const performers = Array.isArray(matchup.topPerformers) ? matchup.topPerformers : [];
  const players: FactsPlayer[] = [];

  performers.forEach((raw, index) => {
    const p = asLoose(raw);
    const name = str(p.playerName) ?? str(p.fullName) ?? str(p.player);
    if (!name) return;

    // `fantasyTeamId` / `fantasyTeamName` are authoritative. `nflTeam` is separate. The legacy
    // `team` key is ambiguous and only used when nothing better exists.
    const fantasyTeamId = teams.resolve(p.fantasyTeamId, p.fantasyTeamName, p.teamName, p.teamId, p.team);
    const nflTeam = str(p.nflTeam) ?? str(p.proTeam) ?? str(p.proTeamAbbrev);

    const gain = num(p.pointImprovementIfStarted);
    const replaced = str(p.wouldHaveReplacedPlayer);

    players.push({
      id: `${matchupId}P${str(p.playerId) ?? index + 1}`,
      name,
      pos: str(p.position) ?? "FLEX",
      nflTeam,
      fantasyTeamId: fantasyTeamId === "T?" ? (index % 2 === 0 ? homeId : awayId) : fantasyTeamId,
      points: num(p.points) ?? 0,
      projected: num(p.projectedPoints) ?? num(p.projected),
      lineup: p.isStarter === false ? "bench" : "starter",
      benchImpact:
        p.benchImpact && replaced && gain !== undefined
          ? { wouldHaveReplaced: replaced, pointGain: gain }
          : undefined,
    });
  });

  return players;
}

function buildMatchups(data: LeagueDataContext, teams: TeamIndex): FactsMatchup[] {
  return collectMatchupSources(data).map((matchup, index) => {
    const id = `M${index + 1}`;
    // Generic query: ids in teamA/teamB, names in teamAName/teamBName.
    // Weekly-recap query: names in teamA/teamB.
    const homeId = teams.resolve(matchup.teamAName, matchup.teamA, matchup.homeTeamId);
    const awayId = teams.resolve(matchup.teamBName, matchup.teamB, matchup.awayTeamId);
    const scoreA = num(matchup.scoreA) ?? num(matchup.homeScore) ?? 0;
    const scoreB = num(matchup.scoreB) ?? num(matchup.awayScore) ?? 0;

    let winnerTeamId: string | undefined;
    if (scoreA > scoreB) winnerTeamId = homeId;
    else if (scoreB > scoreA) winnerTeamId = awayId;

    return {
      id,
      week: num(matchup.week) ?? num(matchup.matchupPeriod) ?? data.currentWeek,
      bracket: str(matchup.playoffTier) ?? (matchup.isPlayoffGame ? "playoff" : "regular"),
      home: {
        teamId: homeId,
        score: scoreA,
        projected: num(matchup.projectedScoreA),
        benchPoints: num(matchup.benchPointsA),
      },
      away: {
        teamId: awayId,
        score: scoreB,
        projected: num(matchup.projectedScoreB),
        benchPoints: num(matchup.benchPointsB),
      },
      winnerTeamId,
      margin: round1(Math.abs(scoreA - scoreB)),
      closeness: str(matchup.closeness)?.toLowerCase(),
      isUpset: matchup.isUpset === true ? true : undefined,
      players: buildMatchupPlayers(matchup, id, teams, homeId, awayId),
    };
  });
}

/**
 * The look-ahead slate. These rows come from the ESPN season schedule, where a future game is a
 * matchup row with zero scores and no winner, so nothing here carries a score: a `weekly_preview`
 * that prints one is describing a game that has not happened.
 */
function buildUpcoming(data: LeagueDataContext, teams: TeamIndex): FactsUpcoming[] {
  const rows = data.upcomingMatchups ?? [];

  return rows.map((raw, index) => {
    const game = asLoose(raw);
    const homeId = teams.resolve(game.teamAId, game.teamAName, game.teamA);
    const awayId = teams.resolve(game.teamBId, game.teamBName, game.teamB);
    const homeTeam = teams.teams.find(team => team.id === homeId);
    const awayTeam = teams.teams.find(team => team.id === awayId);

    const headToHead = asLoose(game.headToHead);
    const homeWins = num(headToHead.teamAWins);
    const awayWins = num(headToHead.teamBWins);

    return {
      id: `U${index + 1}`,
      week: num(game.week) ?? data.currentWeek + 1,
      home: {
        teamId: homeId,
        record: str(game.teamARecord) ?? homeTeam?.record,
        pointsFor: num(game.teamAPointsFor) ?? homeTeam?.pointsFor,
        projected: num(game.projectedScoreA),
      },
      away: {
        teamId: awayId,
        record: str(game.teamBRecord) ?? awayTeam?.record,
        pointsFor: num(game.teamBPointsFor) ?? awayTeam?.pointsFor,
        projected: num(game.projectedScoreB),
      },
      headToHead:
        homeWins !== undefined && awayWins !== undefined && homeWins + awayWins > 0
          ? { homeWins, awayWins }
          : undefined,
      isPlayoff: game.isPlayoff === true ? true : undefined,
    };
  });
}

export function buildFactsBlock(req: FactsRequest): FactsBlock {
  const data = req.leagueData;
  const teams = new TeamIndex(data);
  const looseData = data as Loose;

  const matchups = buildMatchups(data, teams);
  const upcoming = buildUpcoming(data, teams);

  const standings = (data.standings ?? []).map(row => ({
    rank: row.rank,
    teamId: teams.resolve(row.teamId, row.team, asLoose(row).teamName, asLoose(row).externalId, asLoose(row).owner),
    record: `${row.wins}-${row.losses}-${row.ties ?? 0}`,
    pointsFor: num(row.pointsFor) ?? 0,
    streak: row.streakType && row.streakLength ? `${row.streakType}${row.streakLength}` : undefined,
    seed: row.playoffSeed,
    division: str(asLoose(row).division),
  }));

  const transactions = (data.transactions ?? []).map((transaction, index) => ({
    id: `X${index + 1}`,
    teamId: teams.resolve(transaction.teamId, transaction.teamName),
    type: transaction.type,
    playerAdded: transaction.playerAdded?.playerName,
    playerDropped: transaction.playerDropped?.playerName,
    faab: num(transaction.faabBid),
    week: num(asLoose(transaction).week),
    timestamp: toTimestamp(transaction.date),
    when: toWhen(toTimestamp(transaction.date)),
  }));

  const trades = (data.trades ?? []).map((trade, index) => ({
    id: `TR${index + 1}`,
    week: num(asLoose(trade).week),
    timestamp: toTimestamp(trade.date),
    when: toWhen(toTimestamp(trade.date)),
    sides: [
      {
        teamId: teams.resolve(trade.teamA),
        gave: trade.playersFromA.map(player => player.playerName),
        received: trade.playersFromB.map(player => player.playerName),
      },
      {
        teamId: teams.resolve(trade.teamB),
        gave: trade.playersFromB.map(player => player.playerName),
        received: trade.playersFromA.map(player => player.playerName),
      },
    ],
  }));

  const adpPlaceholder = adpLooksLikePlaceholder(data.draftPicks);
  const draftPicks = (data.draftPicks ?? []).map(pick => {
    const adp = adpPlaceholder || pick.playerADP === null ? undefined : num(pick.playerADP);
    return {
      id: `D${pick.pickNumber}`,
      teamId: teams.resolve(pick.teamName, pick.teamAbbreviation),
      overall: pick.pickNumber,
      round: pick.roundNumber,
      pickInRound: pick.roundPickNumber,
      player: pick.playerName,
      pos: pick.playerPosition,
      adp,
      // Positive = drafted later than ADP (value). Negative = drafted earlier than ADP (reach).
      adpDelta: adp === undefined ? undefined : round1(pick.pickNumber - adp),
      projected: pick.playerProjectedPoints === null ? undefined : num(pick.playerProjectedPoints),
    };
  });

  const quotes: FactsBlock["quotes"] = [];
  (req.commentResponses ?? []).forEach(response => {
    const teamId = teams.resolve(response.teamId, response.teamName);
    response.quotes.forEach(text => {
      const trimmed = text.trim();
      if (trimmed.length === 0) return;
      quotes.push({
        id: `Q${quotes.length + 1}`,
        speaker: response.userName,
        teamId,
        questionTopic: response.questionTopic,
        text: trimmed,
      });
    });
  });

  const nonRespondents = (req.nonRespondents ?? []).map(entry => ({
    speaker: entry.userName,
    teamId: teams.resolve(entry.teamName),
    status: entry.status,
  }));

  const relationships = (req.relationships ?? []).map(entry => ({
    teamId: teams.resolve(entry.teamId, entry.teamName),
    manager: entry.managerName,
    score: entry.score,
    tier: entry.tier,
    recentEvents: entry.recentEvents ?? [],
  }));

  const priorClaims = (req.priorClaims ?? []).map((claim, index) => ({
    id: `C${index + 1}`,
    week: claim.week,
    claim: claim.claim,
    outcome: claim.outcome,
  }));

  const format = buildFormat(data);
  const waivers = buildWaivers(data, teams);

  const missing = computeMissingRequiredData(req.contentType, data);
  if (adpPlaceholder) {
    missing.push(
      "ADP — every pick carries the same placeholder value, so no ADP or value-vs-ADP is available; grade on projections and roster construction only"
    );
  }
  if (nonRespondents.length > 0) {
    const names = nonRespondents.map(entry => `${entry.speaker} (${entry.teamId})`).join(", ");
    missing.push(`quotes — ${names} did not respond to the comment request`);
  }
  if (priorClaims.length === 0) {
    missing.push("priorClaims — none. You have no prediction history in this league; do not claim one.");
  }
  // The playoff field size drives every "who's in" claim in a playoff picture piece — the writer
  // must be told the gap explicitly rather than defaulting to a common field size like six.
  if (req.contentType === "playoff_picture" && format.playoffTeamCount === undefined) {
    missing.push("playoff field size — not in the payload; do not assume a number of playoff teams");
  }
  if (req.contentType === "waiver_wire_report") {
    // Whether the league itself is FAAB is decided by `leagueFormat.waiverType` (the raw enum,
    // read directly rather than through `format.waiverType`'s prose label) — never by whether a
    // `waivers` ledger payload happened to be attached, so a FAAB league whose ledger request
    // simply didn't carry one yet still gets the accurate "empty ledger" note below, not a
    // self-contradicting "this league uses FAAB waivers ... no bid dollars" sentence.
    const formatIsFaab = ((data as Loose).leagueFormat as { waiverType?: string } | undefined)?.waiverType === "faab";
    if (format.waiverType === undefined) {
      missing.push("waiver type — not in the payload; do not assume FAAB or rolling waivers");
    } else if (!formatIsFaab) {
      missing.push(`FAAB ledger — this league uses ${format.waiverType}; there are no bid dollars to cite`);
    } else if (!waivers.latestRun) {
      missing.push("waiver claims — no waiver claims recorded this season");
    }
  }

  const season =
    num(looseData.season) ??
    num(looseData.seasonId) ??
    data.leagueHistory?.seasons?.[data.leagueHistory.seasons.length - 1]?.year ??
    new Date().getFullYear();

  return {
    schema: "ffsn.facts.v1",
    league: {
      name: data.leagueName,
      week: data.currentWeek,
      season,
      teamCount: data.teams?.length ?? 0,
      scoring: data.scoringType,
    },
    format,
    waivers,
    teams: teams.teams,
    matchups,
    upcoming,
    standings,
    transactions,
    trades,
    draftPicks: draftPicks.length > 0 ? draftPicks : undefined,
    quotes,
    nonRespondents,
    relationships,
    priorClaims,
    priorRecord: req.priorRecord,
    missing,
  };
}

export function serializeFacts(facts: FactsBlock): string {
  return `<FACTS>\n${JSON.stringify(facts, null, 2)}\n</FACTS>`;
}
