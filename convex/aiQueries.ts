import { draftTypeFromEspn } from "../src/lib/ai/draftType";
import { v } from "convex/values";
import { internalQuery, QueryCtx } from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import {
  calculateStrengthOfSchedule,
  calculateRecentForm,
  analyzeTransactionTrends,
  calculatePlayoffProbabilities,
  identifyMemorableMoments
} from "../src/lib/ai/data-aggregation-helpers";
// Type-only: never a value import from a convex/*.ts module here (see the repo-wide gotcha about
// `internal` recursion). `LeagueFormat` is a plain interface with no runtime footprint.
import type {
  LeagueFormat,
  LeagueFormatDivision,
  WaiverLedger,
  WaiverLedgerBudget,
  WaiverLedgerClaim,
  WaiverLedgerSeason,
} from "../src/lib/ai/prompt-builder";
// `convex/lib/espnSettings.ts` is a deliberately pure module (no `internal`/`api` imports of its
// own — see its file header), so importing it as a value here carries none of the recursive-`api`
// risk the repo gotcha warns about for other convex/*.ts modules.
import { parseEspnLeagueSettings, type ParsedLeagueSettings } from "./lib/espnSettings";
// `convex/lib/espnTransactions.ts` is likewise deliberately pure (no `internal`/`api` imports of
// its own — see its file header) — the canonical, tested classifier the sync path itself uses to
// write `transactions.outcome`. Reused here so the waiver ledger can never disagree with it.
import {
  classifyTransactionStatus,
  type TransactionOutcome as ImportedTransactionOutcome,
} from "./lib/espnTransactions";
// `convex/lib/standingsThroughWeek.ts` is likewise a deliberately pure module (see its file
// header) - season backfill's historical-mode standings computation (brief A deliverable 1).
import { computeStandingsThroughWeek } from "./lib/standingsThroughWeek";
// `convex/lib/playoffs.ts` is likewise deliberately pure (see its file header) - the bracket-truth
// source for the writers, never `leagueSeasons.champion` (which a rolled-over sync can corrupt).
import {
  buildPlayoffContext,
  deriveSeasonResults,
  highestFinishedMatchupPeriod,
  isByeMatchup,
  isCorruptedSeasonResult,
  playoffRoundName,
} from "./lib/playoffs";
import type { PlayoffContext } from "./lib/playoffTypes";
// `convex/lib/playerBoard.ts` is likewise deliberately pure (see its file header) - the
// league-relative player rankings the week-1 (and every other week's) preview cites instead of
// bare 0-0 records (owner directive, 2026-09-03).
import { buildPlayerBoard, sumStarterProjected, topKeyPlayers } from "./lib/playerBoard";
import {
  attachNewsAndInjuryWatch,
  buildDraftPool,
  buildDraftTendencies,
  leagueTypeFromDraftSettings,
  mergeIntelIntoPool,
  OUTLOOK_DEPTH,
  POOL_SIZE,
  type DraftTendency,
  type NewsSource,
  type PoolSource,
} from "./lib/mockDraftIntel";
import { getIntelForPlayersImpl, intelHasContent, type PlayerIntelEntry } from "./intel";
import { getSimplifiedDraftDataImpl } from "./draftRankingsHelpers";
import type { PlayerBoardMatchupInput, PlayerBoardTeamInput } from "./lib/playerBoard";
// Type-only: `convex/inGameInjuries.ts` (the query) is called through `internal.inGameInjuries.*`
// below, never imported as a value - see the repo-wide gotcha about `internal` recursion.
// `convex/lib/inGameInjuries.ts` itself is pure, so its `InGameInjury` type carries no such risk.
import type { InGameInjury } from "./lib/inGameInjuries";
// `convex/lib/almanacData.ts` is likewise deliberately pure (no `internal`/`api` imports of its
// own - see its file header) - the League Almanac gatherer (owner ask, 2026-09-06).
import { gatherAlmanacInput } from "./lib/almanacData";
// `src/lib/ai/almanac.ts` has no imports at all, so it carries none of the "never a value import
// from src/lib/ai in a non-Node Convex file" risk that applies to the heavier prompt-layer
// modules - see that file's own header.
import { buildAlmanac } from "../src/lib/ai/almanac";

/**
 * Enhanced query functions for AI content generation
 * These queries provide all the enriched data needed for accurate article generation
 */

/* -------------------------------------------------------------------------- *
 * Manager identity (spec section 2)
 *
 * `teams.owner` is an ESPN owner string (frequently an opaque GUID) and is never
 * a Convex user id. The manager's *display* name is resolved here: ESPN's
 * `ownerInfo` first, then the user who claimed the team for the league's current
 * season (`teamClaims.userId` is a Clerk id -> `users.by_clerk_id`), then
 * "Unknown". Every payload that carries a `manager` / `teamAOwner` / `teamBOwner`
 * uses this, so the prompt layer never prints a raw ESPN owner id.
 * -------------------------------------------------------------------------- */

const UNKNOWN_MANAGER = "Unknown";

/** ESPN-provided display name for a team's owner, or null when unusable. */
function espnManagerName(team: Doc<"teams">): string | null {
  const info = team.ownerInfo;
  if (!info) return null;
  const full = [info.firstName, info.lastName]
    .filter((part): part is string => Boolean(part && part.trim()))
    .join(" ")
    .trim();
  if (full) return full;
  const display = info.displayName?.trim();
  return display ? display : null;
}

/** The name of the user who claimed this team for `seasonId`, or null. */
async function claimedManagerName(
  ctx: QueryCtx,
  teamId: Id<"teams">,
  seasonId: number
): Promise<string | null> {
  const claim = await ctx.db
    .query("teamClaims")
    .withIndex("by_team_season", (q) =>
      q.eq("teamId", teamId).eq("seasonId", seasonId)
    )
    .filter((q) => q.eq(q.field("status"), "active"))
    .first();
  if (!claim) return null;
  const user = await ctx.db
    .query("users")
    .withIndex("by_clerk_id", (q) => q.eq("clerkId", claim.userId))
    .unique();
  const name = user?.name?.trim();
  return name ? name : null;
}

/** Convex team id -> manager display name for every team passed in. */
async function buildManagerNames(
  ctx: QueryCtx,
  teams: Array<Doc<"teams">>,
  seasonId: number
): Promise<Map<string, string>> {
  // ESPN owner strings arrive with stray whitespace ("Matthew  Colominas "); tidy them once here
  // so prose, FACTS and the verifier all see the same name.
  const tidy = (name: string) => name.replace(/\s+/g, " ").trim();
  const names = new Map<string, string>();
  for (const team of teams) {
    const fromEspn = espnManagerName(team);
    if (fromEspn) {
      names.set(team._id, tidy(fromEspn));
      continue;
    }
    const claimed = await claimedManagerName(ctx, team._id, seasonId);
    names.set(team._id, claimed ? tidy(claimed) : UNKNOWN_MANAGER);
  }
  return names;
}

/* -------------------------------------------------------------------------- *
 * League format (audit: leagues differ in divisions, playoff structure, roster shape, scoring and
 * waivers, and the writers had no way to know any of it).
 *
 * Two different shapes carry this data, both from `convex/lib/espnSettings.ts` (a settings
 * migration landing concurrently with this work):
 *  - `leagueSeasons.settings` is `v.any()` and holds the RAW ESPN `view=mSettings` blob for that
 *    season (nested `scheduleSettings` / `scoringSettings` / `rosterSettings` / ...) — it must be
 *    run through `parseEspnLeagueSettings` before any of its fields mean anything.
 *  - `leagues.settings` holds the flat, already-parsed subset `leagues.mirrorSeasonSettings`
 *    mirrors onto it after a sync (`MIRRORED_LEAGUE_SETTINGS_KEYS`) — read directly, and only ever
 *    the CURRENT season's settings, which is why the season row wins when it parses to anything.
 * Every field is optional on `ParsedLeagueSettings` besides `scoringType`, and a league the
 * settings migration has not reached yet (or a raw blob that fails to parse) simply yields none of
 * them — never a guess.
 * -------------------------------------------------------------------------- */

/** The last real week of the season: every real week any playoff matchup period spans. */
function computeChampionshipWeek(
  regularSeasonMatchupPeriods: number | undefined,
  playoffRounds: number | undefined,
  playoffMatchupPeriodLength: number | undefined,
  matchupPeriods: Record<string, number[]> | undefined
): number | undefined {
  if (matchupPeriods) {
    const allWeeks = Object.values(matchupPeriods).flat();
    if (allWeeks.length > 0) return Math.max(...allWeeks);
  }
  if (regularSeasonMatchupPeriods !== undefined && playoffRounds !== undefined) {
    return regularSeasonMatchupPeriods + playoffRounds * (playoffMatchupPeriodLength ?? 1);
  }
  return undefined;
}

/** "Weeks 15-18" (or "Week 16") — the real weeks the playoff bracket spans, plain English. */
function computePlayoffWeeksRange(
  regularSeasonMatchupPeriods: number | undefined,
  playoffRounds: number | undefined,
  playoffMatchupPeriodLength: number | undefined,
  matchupPeriods: Record<string, number[]> | undefined
): string | undefined {
  if (matchupPeriods && regularSeasonMatchupPeriods !== undefined) {
    const playoffWeeks = Object.entries(matchupPeriods)
      .filter(([period]) => Number(period) > regularSeasonMatchupPeriods)
      .flatMap(([, weeks]) => weeks);
    if (playoffWeeks.length > 0) {
      const min = Math.min(...playoffWeeks);
      const max = Math.max(...playoffWeeks);
      return min === max ? `Week ${min}` : `Weeks ${min}-${max}`;
    }
  }
  if (regularSeasonMatchupPeriods !== undefined && playoffRounds !== undefined) {
    const start = regularSeasonMatchupPeriods + 1;
    const end = regularSeasonMatchupPeriods + playoffRounds * (playoffMatchupPeriodLength ?? 1);
    return start === end ? `Week ${start}` : `Weeks ${start}-${end}`;
  }
  return undefined;
}

/**
 * Pure computation over already-fetched settings, so a caller that has already loaded the season
 * row (`getLeagueDataForAI` fetches `leagueSeasons` for other reasons) can build the format without
 * an extra database round trip. `buildLeagueFormat` below is the query-and-compute convenience for
 * everyone else.
 *
 * `seasonSettingsRaw` is `leagueSeasons.settings` — the raw ESPN blob (or `undefined`/malformed on
 * a league the sync hasn't reached) — and is parsed here; `leagueSettings` is `leagues.settings`,
 * already flat, read directly and only used for a key the season parse didn't produce.
 */
export function computeLeagueFormat(seasonSettingsRaw: unknown, leagueSettings: unknown): LeagueFormat {
  // A raw blob that fails to parse (missing/malformed `scheduleSettings` etc.) yields an object of
  // all-`undefined` fields save `scoringType` (which defaults to "standard") — never throws — so
  // this is safe to call unconditionally.
  const parsedSeason: Partial<ParsedLeagueSettings> = seasonSettingsRaw
    ? parseEspnLeagueSettings(seasonSettingsRaw)
    : {};
  // `leagues.settings` was never itself ESPN's raw blob (it always held the app's own settings
  // object), so it is read directly against the mirrored subset's flat key names, never parsed.
  const perLeague = (leagueSettings ?? {}) as unknown as Partial<ParsedLeagueSettings>;

  function pick<K extends keyof ParsedLeagueSettings>(key: K): ParsedLeagueSettings[K] | undefined {
    return parsedSeason[key] ?? perLeague[key];
  }

  const regularSeasonMatchupPeriods = pick("regularSeasonMatchupPeriods");
  const playoffTeamCount = pick("playoffTeamCount");
  const playoffMatchupPeriodLength = pick("playoffMatchupPeriodLength");
  const playoffRounds = pick("playoffRounds");
  const matchupPeriods = pick("matchupPeriods");
  // ESPN's division id is numeric; every other id this feature compares against (`teams.divisionId`
  // stringified in the standings/team payload below) is a string, so it is normalized here once.
  const divisions: LeagueFormatDivision[] | undefined = pick("divisions")?.map(division => ({
    id: String(division.id),
    name: division.name,
    size: division.size,
  }));

  return {
    scoringType: pick("scoringType"),
    receptionPoints: pick("receptionPoints"),
    regularSeasonMatchupPeriods,
    playoffTeamCount,
    playoffMatchupPeriodLength,
    playoffRounds,
    playoffSeedingRule: pick("playoffSeedingRule"),
    divisions,
    matchupPeriods,
    lineupSlots: pick("lineupSlots"),
    isSuperflex: pick("isSuperflex"),
    hasIdp: pick("hasIdp"),
    waiverType: pick("waiverType"),
    faabBudget: pick("faabBudget"),
    tradeDeadline: pick("tradeDeadline"),
    fantasyChampionshipWeek: computeChampionshipWeek(
      regularSeasonMatchupPeriods,
      playoffRounds,
      playoffMatchupPeriodLength,
      matchupPeriods
    ),
    playoffWeeksRange: computePlayoffWeeksRange(
      regularSeasonMatchupPeriods,
      playoffRounds,
      playoffMatchupPeriodLength,
      matchupPeriods
    ),
  };
}

/**
 * Query-and-compute convenience: fetches the article's season row and builds the format from it
 * plus `league.settings`. Prefer `computeLeagueFormat` directly when the season row is already in
 * hand (avoids a duplicate query).
 */
export async function buildLeagueFormat(
  ctx: QueryCtx,
  league: Doc<"leagues">,
  seasonId: number
): Promise<LeagueFormat> {
  const seasonRow = await ctx.db
    .query("leagueSeasons")
    .withIndex("by_league_season", q => q.eq("leagueId", league._id).eq("seasonId", seasonId))
    .first();

  return computeLeagueFormat(seasonRow?.settings, league.settings);
}

/**
 * Standings order (audit: `getLeagueDataForAI` used to sort league-wide by wins -> win% -> PF only,
 * which the article's `rank` field and every downstream "the 3-seed" claim followed — even though
 * ESPN's authoritative `record.playoffSeed` was synced right alongside it and, for a
 * DIVISION_WINNERS league, disagrees with a wins/PF ordering. `record.playoffSeed` wins whenever
 * both sides have one; the wins/win%/PF comparator is only the fallback for a team with no seed yet
 * (mid-draft, or a sync that predates ESPN publishing seeds).
 */
export function compareStandingsForSeeding(
  a: Pick<Doc<"teams">, "record">,
  b: Pick<Doc<"teams">, "record">
): number {
  const seedA = a.record.playoffSeed;
  const seedB = b.record.playoffSeed;
  if (seedA !== undefined && seedB !== undefined) return seedA - seedB;
  if (seedA !== undefined) return -1;
  if (seedB !== undefined) return 1;
  // Sort by wins first
  if (a.record.wins !== b.record.wins) {
    return (b.record.wins || 0) - (a.record.wins || 0);
  }
  // Then by win percentage
  const aTotalGames = (a.record.wins || 0) + (a.record.losses || 0) + (a.record.ties || 0);
  const bTotalGames = (b.record.wins || 0) + (b.record.losses || 0) + (b.record.ties || 0);
  const aWinPct = aTotalGames > 0 ? (a.record.wins || 0) / aTotalGames : 0;
  const bWinPct = bTotalGames > 0 ? (b.record.wins || 0) / bTotalGames : 0;
  if (aWinPct !== bWinPct) {
    return bWinPct - aWinPct;
  }
  // Then by points for (tiebreaker)
  return (b.record.pointsFor || 0) - (a.record.pointsFor || 0);
}

/** `teams.divisionId` (a number) -> the division's display name, from `leagueFormat.divisions`. */
function divisionNameLookup(leagueFormat: LeagueFormat): (divisionId: number | undefined) => string | undefined {
  const byId = new Map((leagueFormat.divisions ?? []).map(division => [division.id, division.name]));
  return (divisionId: number | undefined) => (divisionId === undefined ? undefined : byId.get(String(divisionId)));
}

/* -------------------------------------------------------------------------- *
 * Waiver / FAAB ledger (owner goal, 2026-09-02: the waiver wire report must take FAAB spend into
 * account — winning bids, losing bids, each team's remaining budget, season highlights, and Sam's
 * interview questions should all use these numbers).
 *
 * Outcome classification is delegated to `classifyTransactionStatus` (`convex/lib/espnTransactions.ts`
 * — the same pure, `internal`-free classifier `espnSync.ts` uses to write `transactions.outcome`), so
 * this can never disagree with what the sync path stored, and it needs no fallback of its own: it
 * reads only `status` + `isPending`, which have always been required fields, unlike the newer
 * `outcome`/`processDate` (on `transactions`) and `transactionCounter` (on `teams`) — all
 * `v.optional`, so an older row simply carries none of them.
 *
 * From the live ESPN log (verified against `tests/fixtures/espn-transactions-public.json`, player
 * 4362478 / scoring period 5: winner $41 EXECUTED, losing bids [35, 18, 10, 5] all
 * FAILED_INVALIDPLAYERSOURCE, and a $0 CANCELED bid correctly excluded):
 *  - A winning claim: `type === "WAIVER"`, outcome "executed".
 *  - A competing losing bid for the SAME player in the SAME scoring period: `type === "WAIVER"`,
 *    outcome "failed", and its ADD item's playerId matches the winner's. A "cancelled" bid (the
 *    manager withdrew; always $0) is never competition, and a failure on a different player is not
 *    competition for this claim either.
 *  - An immediate free-agent add carries `type` "FREEAGENT"/"ROSTER", not "WAIVER" — the `type`
 *    filter alone (matching `summarizeWaiverRun`'s own contract) excludes it as a pickup, not a
 *    waiver win, from both the ledger and the bid stats.
 * -------------------------------------------------------------------------- */

type TransactionOutcome = ImportedTransactionOutcome;

/**
 * Classifies every transaction row from `status` + `isPending` alone. Reuses
 * `classifyTransactionStatus`, the same classifier `convex/espnSync.ts` writes `outcome` with, so a
 * ledger built here can never disagree with what the sync path stored (and never needs to read the
 * stored `outcome` itself).
 */
function transactionOutcome(t: Doc<"transactions">): TransactionOutcome {
  return classifyTransactionStatus(t.status, t.isPending);
}

function waiverAddPlayerId(t: Doc<"transactions">): number | undefined {
  return t.items.find(item => item.type === "ADD")?.playerId;
}

function waiverDropPlayerId(t: Doc<"transactions">): number | undefined {
  return t.items.find(item => item.type === "DROP")?.playerId;
}

/** ESPN player id -> name/position/NFL team, one lookup per distinct id, via `playersEnhanced`. */
async function waiverPlayerLookup(
  ctx: QueryCtx,
  seasonId: number,
  playerIds: Iterable<number>
): Promise<Map<number, { name: string; pos: string; nflTeam?: string }>> {
  const out = new Map<number, { name: string; pos: string; nflTeam?: string }>();
  for (const playerId of new Set(playerIds)) {
    const player = await ctx.db
      .query("playersEnhanced")
      .withIndex("by_espn_id_season", q => q.eq("espnId", String(playerId)).eq("season", seasonId))
      .first();
    if (player) {
      out.set(playerId, { name: player.fullName, pos: player.defaultPosition, nflTeam: player.proTeamAbbrev });
    }
  }
  return out;
}

/**
 * The waiver/FAAB ledger for one league-season: the most recently processed waiver run (winning and
 * losing bids), every team's remaining budget, and season-level highlights. Bounded throughout: a
 * scoring-period-indexed lookback (capped) locates the latest run so this stays correct even when
 * called long after the season has moved on; a single capped `by_season` scan backs the season
 * highlights, with `teams.transactionCounter` preferred wherever it is present since ESPN's own
 * running totals are authoritative for the whole season, not just the scanned window.
 */
export async function buildWaiverLedger(
  ctx: QueryCtx,
  league: Doc<"leagues">,
  seasonId: number,
  opts: { throughScoringPeriod: number; useTeamCounters?: boolean }
): Promise<WaiverLedger> {
  const leagueFormat = await buildLeagueFormat(ctx, league, seasonId);
  const waiverType = leagueFormat.waiverType;
  const budget = leagueFormat.faabBudget;

  const teams = await ctx.db
    .query("teams")
    .withIndex("by_season", q => q.eq("leagueId", league._id).eq("seasonId", seasonId))
    .collect();
  const managerNames = await buildManagerNames(ctx, teams, seasonId);
  const teamByExternalId = new Map(teams.map(team => [Number(team.externalId), team]));

  const identityFor = (externalTeamId: number): { teamId: string; teamName: string; manager?: string } => {
    const team = teamByExternalId.get(externalTeamId);
    return {
      teamId: team?._id ?? String(externalTeamId),
      teamName: team?.name ?? `Team ${externalTeamId}`,
      manager: team ? managerNames.get(team._id) : undefined,
    };
  };

  /* ---- Latest processed run: bounded lookback by scoring period, newest first. ---- */
  const MAX_LOOKBACK_PERIODS = 25;
  let latestPeriod: number | undefined;
  let latestPeriodTransactions: Doc<"transactions">[] = [];
  for (
    let period = opts.throughScoringPeriod;
    period >= 1 && opts.throughScoringPeriod - period < MAX_LOOKBACK_PERIODS;
    period--
  ) {
    const periodTransactions = await ctx.db
      .query("transactions")
      .withIndex("by_scoring_period", q =>
        q.eq("leagueId", league._id).eq("seasonId", seasonId).eq("scoringPeriod", period)
      )
      .take(300);
    const hasWinner = periodTransactions.some(
      t => t.type === "WAIVER" && transactionOutcome(t) === "executed"
    );
    if (hasWinner) {
      latestPeriod = period;
      latestPeriodTransactions = periodTransactions;
      break;
    }
  }

  let latestRun: WaiverLedger["latestRun"];
  if (latestPeriod !== undefined) {
    const winners = latestPeriodTransactions.filter(
      t => t.type === "WAIVER" && transactionOutcome(t) === "executed"
    );
    const losers = latestPeriodTransactions.filter(
      t => t.type === "WAIVER" && transactionOutcome(t) === "failed"
    );

    const playerIds = new Set<number>();
    for (const t of [...winners, ...losers]) {
      const addId = waiverAddPlayerId(t);
      if (addId !== undefined) playerIds.add(addId);
      const dropId = waiverDropPlayerId(t);
      if (dropId !== undefined) playerIds.add(dropId);
    }
    const players = await waiverPlayerLookup(ctx, seasonId, playerIds);

    const claims: WaiverLedgerClaim[] = winners.map(winner => {
      const addPlayerId = waiverAddPlayerId(winner);
      const dropPlayerId = waiverDropPlayerId(winner);
      const player = addPlayerId !== undefined ? players.get(addPlayerId) : undefined;
      const dropped = dropPlayerId !== undefined ? players.get(dropPlayerId) : undefined;
      const identity = identityFor(winner.teamId);

      const competingBids = losers
        .filter(loser => waiverAddPlayerId(loser) === addPlayerId)
        .map(loser => ({ ...identityFor(loser.teamId), bid: loser.bidAmount }))
        .sort((a, b) => b.bid - a.bid);

      return {
        week: latestPeriod!,
        player: {
          id: addPlayerId !== undefined ? String(addPlayerId) : "unknown",
          name: player?.name ?? (addPlayerId !== undefined ? `Player ${addPlayerId}` : "Unknown player"),
          pos: player?.pos ?? "",
          nflTeam: player?.nflTeam,
        },
        teamId: identity.teamId,
        teamName: identity.teamName,
        manager: identity.manager,
        bid: winner.bidAmount,
        competingBids,
        dropped: dropped ? { name: dropped.name, pos: dropped.pos } : undefined,
      };
    });

    latestRun = {
      scoringPeriod: latestPeriod,
      processedAt: winners[0]?.processDate ?? winners[0]?.proposedDate,
      claims,
    };
  }

  /* ---- Season highlights + per-team budget fallback: one bounded scan. ---- */
  const seasonTransactions = await ctx.db
    .query("transactions")
    .withIndex("by_season", q => q.eq("leagueId", league._id).eq("seasonId", seasonId))
    .order("desc")
    .take(500);

  // Bounded by the week being written about, not just the season: a backfilled
  // week-5 article must not surface a week-12 bid as the season's biggest.
  const executedWaivers = seasonTransactions.filter(
    t =>
      t.type === "WAIVER" &&
      transactionOutcome(t) === "executed" &&
      t.scoringPeriod <= opts.throughScoringPeriod
  );

  const spentByTeam = new Map<number, number>();
  const countByTeam = new Map<number, number>();
  let biggestBid: WaiverLedgerSeason["biggestBid"];
  for (const t of executedWaivers) {
    spentByTeam.set(t.teamId, (spentByTeam.get(t.teamId) ?? 0) + t.bidAmount);
    countByTeam.set(t.teamId, (countByTeam.get(t.teamId) ?? 0) + 1);
    if (!biggestBid || t.bidAmount > biggestBid.bid) {
      const identity = identityFor(t.teamId);
      const addPlayerId = waiverAddPlayerId(t);
      biggestBid = {
        teamId: identity.teamId,
        teamName: identity.teamName,
        // Resolved to a real name below, once every candidate id is known.
        player: addPlayerId !== undefined ? String(addPlayerId) : "unknown",
        bid: t.bidAmount,
        week: t.scoringPeriod,
      };
    }
  }
  if (biggestBid) {
    const resolved = await waiverPlayerLookup(ctx, seasonId, [Number(biggestBid.player)]);
    biggestBid.player = resolved.get(Number(biggestBid.player))?.name ?? biggestBid.player;
  }

  // ESPN's own running totals (`transactionCounter`) are authoritative for the whole season and are
  // preferred whenever every team on the roster carries one; the bounded scan above is only the
  // fallback for a league the sync migration has not reached yet.
  // ESPN's counters are season-to-date totals as of the last sync. For a past week (a season
  // backfill, or a recap of a completed season) they are END-of-season numbers and would leak
  // "finished with nothing left of his budget" into a week-1 piece, so callers writing about a
  // past week turn them off and the through-week scan is used instead.
  const useTeamCounters = opts.useTeamCounters !== false;
  const teamsHaveCounters =
    useTeamCounters &&
    teams.length > 0 &&
    teams.every(team => team.transactionCounter?.acquisitionBudgetSpent !== undefined);

  const budgets: WaiverLedgerBudget[] = teams.map(team => {
    const externalId = Number(team.externalId);
    const counter = useTeamCounters ? team.transactionCounter : undefined;
    const spent = counter?.acquisitionBudgetSpent ?? spentByTeam.get(externalId) ?? 0;
    const acquisitions = counter?.acquisitions ?? countByTeam.get(externalId);
    return {
      teamId: team._id,
      teamName: team.name,
      manager: managerNames.get(team._id),
      budget,
      spent,
      remaining: budget !== undefined ? Math.max(0, budget - spent) : undefined,
      acquisitions,
    };
  });

  const totalSpent = teamsHaveCounters
    ? budgets.reduce((sum, entry) => sum + (entry.spent ?? 0), 0)
    : executedWaivers.reduce((sum, t) => sum + t.bidAmount, 0);
  const winCount = teamsHaveCounters
    ? budgets.reduce((sum, entry) => sum + (entry.acquisitions ?? 0), 0)
    : executedWaivers.length;
  const averageWinningBid = winCount > 0 ? Math.round((totalSpent / winCount) * 10) / 10 : undefined;

  const mostActive = budgets.reduce<WaiverLedgerSeason["mostActive"]>((best, entry) => {
    if (entry.acquisitions === undefined) return best;
    if (!best || entry.acquisitions > best.acquisitions) {
      return { teamId: entry.teamId, teamName: entry.teamName, acquisitions: entry.acquisitions };
    }
    return best;
  }, undefined);

  const lowestRemaining = budgets
    .filter((entry): entry is WaiverLedgerBudget & { remaining: number } => entry.remaining !== undefined)
    .sort((a, b) => a.remaining - b.remaining)
    .slice(0, 3)
    .map(entry => ({ teamId: entry.teamId, teamName: entry.teamName, remaining: entry.remaining }));

  return {
    latestRun,
    budgets,
    season: { biggestBid, mostActive, lowestRemaining, totalSpent: totalSpent || undefined, averageWinningBid },
    waiverType,
    budget,
  };
}

/** Cross-module entry point for `buildWaiverLedger` (never import it as a value — see the repo-wide
 * gotcha about `internal` recursion on convex/*.ts modules); call via
 * `ctx.runQuery(internal.aiQueries.getWaiverLedgerForAI, {...})`. */
export const getWaiverLedgerForAI = internalQuery({
  args: {
    leagueId: v.id("leagues"),
    seasonId: v.number(),
    throughScoringPeriod: v.number(),
    /** False when the article is about a past week (see buildWaiverLedger). */
    useTeamCounters: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const league = await ctx.db.get(args.leagueId);
    if (!league) throw new Error("League not found");
    return buildWaiverLedger(ctx, league, args.seasonId, {
      throughScoringPeriod: args.throughScoringPeriod,
      useTeamCounters: args.useTeamCounters,
    });
  },
});

// Get comprehensive league data for AI content generation
export const getLeagueDataForAI = internalQuery({
  args: {
    leagueId: v.id("leagues"),
    currentWeek: v.optional(v.number()),
    // Season backfill (convex/seasonBackfill.ts): write about a PAST week as
    // it actually stood, rather than the league's live current week. Absent
    // on every existing caller, so the live path below is untouched -
    // `historicalMode` is false and every branch takes the original path.
    asOf: v.optional(v.object({ seasonId: v.number(), week: v.number(), rosterWeek: v.optional(v.number()) })),
  },
  async handler(ctx, args) {
    const league = await ctx.db.get(args.leagueId);
    if (!league) throw new Error("League not found");

    const historicalMode = args.asOf !== undefined;
    const currentSeason = args.asOf?.seasonId ?? (league.espnData?.seasonId || new Date().getFullYear());
    // asOf.week may be 0 (before the first game of the season) - `|| 1` on
    // the live fallback chain would wrongly turn that into week 1, so the
    // historical value is read directly rather than folded into that chain.
    const currentWeek = historicalMode ? args.asOf!.week : (args.currentWeek || league.espnData?.currentScoringPeriod || 1);

    // Fetch all data in parallel
    const [
      teams,
      allMatchupsRaw,
      recentMatchupsRaw,
      trades,
      transactions,
      rivalries,
      managerActivity,
      playersEnhanced,
      leagueSeasons,
      allHistoricalTeams,
      draftTransactions,
    ] = await Promise.all([
      // Get all teams with roster
      ctx.db.query("teams")
        .withIndex("by_season", q => q.eq("leagueId", args.leagueId).eq("seasonId", currentSeason))
        .collect(),

      // Get all matchups
      ctx.db.query("matchups")
        .withIndex("by_league_season", q => q.eq("leagueId", args.leagueId).eq("seasonId", currentSeason))
        .collect(),

      // Get recent matchups (last 3 weeks, never a future week). Without the upper bound every
      // unplayed game of the season came back as "recent" in preseason and a writer read 0-0
      // scheduled games as prior meetings.
      ctx.db.query("matchups")
        .withIndex("by_league_season", q => q.eq("leagueId", args.leagueId).eq("seasonId", currentSeason))
        .filter(q =>
          q.and(
            q.gte(q.field("matchupPeriod"), Math.max(1, currentWeek - 3)),
            q.lte(q.field("matchupPeriod"), currentWeek)
          )
        )
        .collect(),

      // Get recent trades. In historical mode the whole season's rows are read (the table is
      // normally empty - see convex/seasonBackfill.ts's header) and bounded/filtered to the week
      // below, so a future trade can never leak into a backdated article.
      ctx.db.query("trades")
        .withIndex("by_season", q => q.eq("leagueId", args.leagueId).eq("seasonId", currentSeason))
        .order("desc")
        .take(historicalMode ? 500 : 20),

      // Get recent transactions. Historical mode reads a wider window (bounded) and filters/slices
      // to the same 50-row shape below, since the ordinary top-50-by-recency read would otherwise
      // include transactions from weeks after the one this article is about.
      ctx.db.query("transactions")
        .withIndex("by_season", q => q.eq("leagueId", args.leagueId).eq("seasonId", currentSeason))
        .order("desc")
        .take(historicalMode ? 400 : 50),

      // Get rivalries
      ctx.db.query("rivalries")
        .withIndex("by_league", q => q.eq("leagueId", args.leagueId))
        .collect(),

      // Get manager activity
      ctx.db.query("managerActivity")
        .withIndex("by_league_season", q => q.eq("leagueId", args.leagueId).eq("seasonId", currentSeason))
        .collect(),

      // Get player data for rosters
      ctx.db.query("playersEnhanced")
        .withIndex("by_espn_id_season")
        .take(1000), // Get a sample of players for now

      // Get league seasons for historical data
      ctx.db.query("leagueSeasons")
        .withIndex("by_league", q => q.eq("leagueId", args.leagueId))
        .order("desc")
        .take(10),

      // Get all historical teams for all-time records
      ctx.db.query("teams")
        .withIndex("by_league", q => q.eq("leagueId", args.leagueId))
        .collect(),

      // Get this season's DRAFT transactions for the player board's draftPick column - same
      // index+filter pattern draftRankingsHelpers.ts uses (there's no by-type index), bounded
      // rather than `.collect()` (a 10-team, 17-round draft is 170 rows; 400 covers a much larger
      // league without risking an unbounded read on a corrupted/duplicated draft log).
      ctx.db.query("transactions")
        .withIndex("by_season", q => q.eq("leagueId", args.leagueId).eq("seasonId", currentSeason))
        .filter(q => q.eq(q.field("type"), "DRAFT"))
        .take(400),
    ]);

    // A round-one bye (`isByeMatchup`) is a real `matchups` row but not a game - no opponent ever
    // takes the field. Stripped here, once, so every downstream calculation (strength of schedule,
    // standings, recent/upcoming matchups, rivalries) sees the same real-games-only list; without
    // this the week-15 preview literally described a bye as "a blank space where an opponent should
    // be" (see `convex/lib/playoffs.ts`'s header comment for the finding).
    const matchups = allMatchupsRaw.filter(m => !isByeMatchup(m));
    const recentMatchups = recentMatchupsRaw.filter(m => !isByeMatchup(m));

    // "Played" (spec: brief A deliverable 1) = matchupPeriod <= currentWeek. In live mode this is
    // every matchup (currentWeek is the live week, and future weeks are still 0-0 rows anyway); in
    // historical mode the full season is already in the table, so later weeks' REAL results must be
    // stripped from every calculation that isn't explicitly about the schedule itself.
    const playedMatchups = historicalMode ? matchups.filter(m => m.matchupPeriod <= currentWeek) : matchups;

    // The player board's draftPick column (spec: player board). One row per pick; a duplicate
    // playerId (a data anomaly) is resolved by `buildPlayerBoard` itself (first pick wins).
    const draftPicks = draftTransactions.flatMap(t =>
      t.items.map(item => ({ playerId: String(item.playerId), overallPickNumber: item.overallPickNumber }))
    );

    // Trades before the end of `currentWeek`, from nflSeasons.weekBoundaries when that row exists.
    // No boundary row (2025 has none in prod - see convex/seasonBackfill.ts's header) leaves trades
    // unfiltered, matching the live path exactly - a conservative no-op given the table is normally
    // empty regardless.
    let scopedTrades = trades;
    if (historicalMode) {
      const seasonBoundary = await ctx.db
        .query("nflSeasons")
        .withIndex("by_year", q => q.eq("year", currentSeason))
        .first();
      const weekEnd = seasonBoundary?.weekBoundaries.find(w => w.week === currentWeek)?.end;
      // Without a boundary row, scope by the trade's own scoring period (stamped by tradesSync);
      // a trade with neither is left out rather than leaked into an earlier week's article.
      scopedTrades = trades
        .filter(t =>
          weekEnd !== undefined ? t.tradeDate <= weekEnd : t.week !== undefined && t.week <= currentWeek
        )
        .slice(0, 20);
    }

    // Transactions through currentWeek, sliced back to the live path's normal 50-row shape.
    const scopedTransactions = historicalMode
      ? transactions.filter(t => t.scoringPeriod <= currentWeek).slice(0, 50)
      : transactions;
    // Infer league type (Redraft | Keeper | Dynasty)
    let inferredLeagueType: string = "Redraft";
    try {
      // Get current season's draft settings from leagueSeasons
      const currentLeagueSeason = leagueSeasons.find(ls => ls.seasonId === currentSeason);
      
      if (currentLeagueSeason?.draftSettings?.keeperCount) {
        const keeperCount = currentLeagueSeason.draftSettings.keeperCount;
        
        if (keeperCount === 0) {
          inferredLeagueType = "Redraft";
        } else if (keeperCount >= 8) {
          // High keeper count suggests Dynasty format
          inferredLeagueType = "Dynasty";
        } else {
          // Moderate keeper count (1-7) suggests Keeper format
          inferredLeagueType = "Keeper";
        }
      } else {
        // Fallback: Check if any recent seasons had keepers
        const hasKeepers = leagueSeasons
          .slice(0, 3) // Check last 3 seasons
          .some(ls => ls.draftSettings?.keeperCount && ls.draftSettings.keeperCount > 0);
        
        if (hasKeepers) {
          // If any recent season had keepers, assume it's at least a Keeper league
          const maxKeepers = Math.max(
            ...leagueSeasons
              .slice(0, 3)
              .map(ls => ls.draftSettings?.keeperCount || 0)
          );
          
          inferredLeagueType = maxKeepers >= 8 ? "Dynasty" : "Keeper";
        }
      }
    } catch (e) {
      // Default stays Redraft if inference fails
    }

    // League format (audit: divisions, playoff structure, roster shape, scoring, waivers). Reuses
    // the `leagueSeasons` row already fetched above rather than issuing a second query for it.
    const leagueFormat = computeLeagueFormat(
      leagueSeasons.find(ls => ls.seasonId === currentSeason)?.settings,
      league.settings
    );
    const divisionNameFor = divisionNameLookup(leagueFormat);

    // Standings (spec: brief A deliverable 1). In historical mode `teams.record` is the
    // END-OF-SEASON record - useless (worse, actively wrong) for an article about an earlier week -
    // so standings are computed fresh from played regular-season matchups only
    // (`computeStandingsThroughWeek`, convex/lib/standingsThroughWeek.ts). Live mode is untouched:
    // ESPN's own authoritative playoff seed, via `compareStandingsForSeeding`.
    const standingsThroughWeek = historicalMode
      ? computeStandingsThroughWeek(
          teams.map(team => ({ externalId: team.externalId, divisionId: team.divisionId })),
          matchups.map(m => ({
            homeTeamId: m.homeTeamId,
            awayTeamId: m.awayTeamId,
            homeScore: m.homeScore,
            awayScore: m.awayScore,
            winner: m.winner,
            matchupPeriod: m.matchupPeriod,
            playoffTier: m.playoffTier,
          })),
          { throughWeek: currentWeek, lastRegularSeasonWeek: leagueFormat.regularSeasonMatchupPeriods ?? 14 }
        )
      : undefined;
    const standingsByExternalId = new Map((standingsThroughWeek ?? []).map(row => [row.externalId, row]));

    // Live `throughWeek` is the last week with a finished game, NOT `currentWeek` (which in live
    // mode is `currentScoringPeriod` - ESPN's notion of "now", which can be a week ahead of the last
    // completed one, e.g. right after a bye-only week sets nothing final, or - the case that
    // matters for the player board - before week 1 has even kicked off, when ESPN already reports
    // `currentScoringPeriod: 1` though nobody has played a snap). Shared by the playoffs picture
    // below and the player board (spec: player board `throughWeek`/`basis`).
    const liveThroughWeek = historicalMode ? currentWeek : highestFinishedMatchupPeriod(matchups);

    // Playoff picture / bracket (owner ask, Sept 2026): a bracket at playoff time, an "if the
    // season ended today" bracket during the regular season, articles centred on who's still alive.
    // `buildPlayoffContext` recognises byes itself (`isByeMatchup`), so it needs the RAW matchups
    // (`allMatchupsRaw`) - every other calculation in this handler uses the bye-filtered `matchups`.
    const playoffs: PlayoffContext = buildPlayoffContext({
      teams: teams.map(team => ({
        externalId: team.externalId,
        name: team.name,
        record: {
          wins: team.record.wins,
          losses: team.record.losses,
          ties: team.record.ties,
          pointsFor: team.record.pointsFor,
          playoffSeed: team.record.playoffSeed,
        },
      })),
      matchups: allMatchupsRaw.map(m => ({
        matchupPeriod: m.matchupPeriod,
        homeTeamId: m.homeTeamId,
        awayTeamId: m.awayTeamId,
        homeScore: m.homeScore,
        awayScore: m.awayScore,
        winner: m.winner,
        playoffTier: m.playoffTier,
      })),
      format: {
        playoffTeamCount: leagueFormat.playoffTeamCount,
        regularSeasonMatchupPeriods: leagueFormat.regularSeasonMatchupPeriods,
        playoffMatchupPeriodLength: leagueFormat.playoffMatchupPeriodLength,
        playoffSeedingRule: leagueFormat.playoffSeedingRule,
      },
      throughWeek: liveThroughWeek,
      standings: historicalMode
        ? (standingsThroughWeek ?? []).map(row => ({
            externalId: row.externalId,
            wins: row.wins,
            losses: row.losses,
            ties: row.ties,
            pointsFor: row.pointsFor,
            rank: row.rank,
          }))
        : undefined,
    });

    const standings = historicalMode
      ? (standingsThroughWeek ?? []).map(row => ({
          teamId: row.externalId,
          team: teams.find(team => team.externalId === row.externalId)?.name ?? `Team ${row.externalId}`,
          rank: row.rank,
          wins: row.wins,
          losses: row.losses,
          ties: row.ties,
          pointsFor: row.pointsFor,
          pointsAgainst: row.pointsAgainst,
          playoffSeed: row.playoffSeed,
          division: divisionNameFor(row.divisionId),
          // Not cheaply derivable through-week (would need a second, division-scoped pass over
          // played matchups) - left undefined rather than showing the wrong (end-of-season) split.
          divisionRecord: undefined as { wins: number; losses: number; ties: number } | undefined,
        }))
      : teams
          .sort(compareStandingsForSeeding)
          .map((team, index) => ({
            teamId: team.externalId,
            team: team.name,
            rank: index + 1,
            wins: team.record.wins,
            losses: team.record.losses,
            ties: team.record.ties,
            pointsFor: team.record.pointsFor || 0,
            pointsAgainst: team.record.pointsAgainst || 0,
            playoffSeed: team.record.playoffSeed,
            division: divisionNameFor(team.divisionId),
            divisionRecord: team.record.divisionRecord,
          }));

    // One group per division (spec: format audit), only when the league actually has divisions.
    const divisionStandings =
      leagueFormat.divisions && leagueFormat.divisions.length > 0
        ? leagueFormat.divisions
            .map(division => ({
              division: division.name,
              teams: standings
                .filter(row => row.division === division.name)
                .map(row => ({
                  rank: row.rank,
                  teamId: row.teamId,
                  team: row.team,
                  record: `${row.wins}-${row.losses}-${row.ties}`,
                  pointsFor: row.pointsFor,
                })),
            }))
            .filter(group => group.teams.length > 0)
        : undefined;
    
    // Build previousSeasons data from leagueSeasons and historical teams
    const previousSeasons: Record<number, Array<{
      teamId: string;
      teamName: string;
      manager: string;
      record: { wins: number; losses: number; ties: number; pointsFor?: number; pointsAgainst?: number; };
      roster: Array<{
        playerId: string;
        playerName: string;
        position: string;
        team: string;
        nflTeam?: string;
        fantasyTeamId: string;
        fantasyTeamName: string;
        acquisitionType: string;
        fullName?: string;
      }>;
    }>> = {};
    
    // Group historical teams by season, strictly BEFORE currentSeason - not just "!==" - so a
    // 2026 team row (0-0, mid-draft) can never masquerade as a "previous season" while backfilling
    // 2025. A no-op for the live path: a team row for a season later than the league's own current
    // season is not a shape that occurs there.
    const pastSeasons = [...new Set(allHistoricalTeams
      .filter(team => team.seasonId < currentSeason)
      .map(team => team.seasonId))]
      .sort((a, b) => b - a); // Most recent first
    
    for (const seasonId of pastSeasons) {
      const seasonTeams = allHistoricalTeams.filter(team => team.seasonId === seasonId);
      previousSeasons[seasonId] = seasonTeams.map(team => ({
        teamId: team.externalId,
        teamName: team.name,
        manager: espnManagerName(team) || team.owner || UNKNOWN_MANAGER,
        record: {
          wins: team.record.wins,
          losses: team.record.losses,
          ties: team.record.ties,
          pointsFor: team.record.pointsFor,
          pointsAgainst: team.record.pointsAgainst,
        },
        roster: team.roster.map(player => ({
          playerId: player.playerId,
          playerName: player.playerName,
          position: player.position,
          team: player.team, // legacy: NFL team abbreviation
          nflTeam: player.team || undefined,
          fantasyTeamId: String(team.externalId),
          fantasyTeamName: team.name,
          acquisitionType: player.acquisitionType || "UNKNOWN",
          fullName: player.playerName,
        })),
      }));
    }
    
    // Calculate all-time records by externalId (handle string vs number matching)
    const allTimeRecords: Record<string, {
      wins: number;
      losses: number;
      ties: number;
      totalPointsFor: number;
      seasonsPlayed: number;
      championships: number;
      playoffAppearances: number;
    }> = {};
    
    // Initialize with current teams
    teams.forEach(team => {
      allTimeRecords[team.externalId] = {
        wins: 0,
        losses: 0,
        ties: 0,
        totalPointsFor: 0,
        seasonsPlayed: 0,
        championships: 0,
        playoffAppearances: 0,
      };
    });
    
    // Aggregate all historical data by externalId
    allHistoricalTeams.forEach(team => {
      // Handle both string and number external IDs for consistency
      const externalId = String(team.externalId);
      
      if (!allTimeRecords[externalId]) {
        allTimeRecords[externalId] = {
          wins: 0,
          losses: 0,
          ties: 0,
          totalPointsFor: 0,
          seasonsPlayed: 0,
          championships: 0,
          playoffAppearances: 0,
        };
      }
      
      // The CURRENT season's contribution is the computed through-week record in historical mode
      // (`team.record` is that season's END-OF-SEASON record - the whole point of this feature is
      // that later weeks' real results must not leak into an earlier week's article).
      const computedForThisSeason =
        historicalMode && team.seasonId === currentSeason
          ? standingsByExternalId.get(team.externalId)
          : undefined;

      const record = allTimeRecords[externalId];
      record.wins += computedForThisSeason?.wins ?? team.record.wins;
      record.losses += computedForThisSeason?.losses ?? team.record.losses;
      record.ties += computedForThisSeason?.ties ?? team.record.ties;
      record.totalPointsFor += computedForThisSeason?.pointsFor ?? (team.record.pointsFor || 0);
      record.seasonsPlayed += 1;
      
      // Check if this team made the playoffs, using that season's own playoff field size where a
      // recent-season row for it is in hand (the current league's field size is only a fallback —
      // a league that has changed its playoff count over time would otherwise misjudge every past
      // season by today's setting).
      const seasonStandings = allHistoricalTeams
        .filter(t => t.seasonId === team.seasonId)
        .sort((a, b) => {
          if (b.record.wins !== a.record.wins) return b.record.wins - a.record.wins;
          return (b.record.pointsFor || 0) - (a.record.pointsFor || 0);
        });

      const teamRank = seasonStandings.findIndex(t => t.externalId === team.externalId) + 1;
      const teamSeasonSettings = leagueSeasons.find(ls => ls.seasonId === team.seasonId)?.settings;
      const seasonPlayoffTeams =
        (teamSeasonSettings ? parseEspnLeagueSettings(teamSeasonSettings).playoffTeamCount : undefined) ??
        leagueFormat.playoffTeamCount ??
        6;

      // In historical mode the target season's stored standing is the final one,
      // which an early-week article cannot know yet - leave that season out.
      const unknowableYet = historicalMode && team.seasonId === currentSeason;
      if (!unknowableYet && teamRank <= seasonPlayoffTeams) {
        record.playoffAppearances += 1;
      }
    });
    
    // Count championships from leagueSeasons. In historical mode the CURRENT (backfill target)
    // season is really a completed season in the database - it already has a real `champion` row -
    // so an early-week article must not count it: that reveals who eventually wins.
    leagueSeasons.forEach(season => {
      if (historicalMode && season.seasonId >= currentSeason) return;
      if (season.champion) {
        const championId = String(season.champion.teamId);
        if (allTimeRecords[championId]) {
          allTimeRecords[championId].championships += 1;
        }
      }
    });

    // Build championship history from leagueSeasons. Same historical-mode guard as above; the live
    // path keeps its original (unfiltered-by-season) behaviour exactly, since a season only ever
    // lands here once it already has a champion/runnerUp/regularSeasonChampion recorded.
    const championshipHistory = leagueSeasons
      .filter(season =>
        (season.champion || season.runnerUp || season.regularSeasonChampion) &&
        (!historicalMode || season.seasonId < currentSeason)
      )
      .map(season => ({
        seasonId: season.seasonId,
        champion: season.champion,
        runnerUp: season.runnerUp,
        regularSeasonChampion: season.regularSeasonChampion,
        settings: {
          name: season.settings.name,
          size: season.settings.size,
          scoringType: season.settings.scoringType,
        },
      }));
    
    // Manager display names for every current-season team (see the helpers above).
    const managerNames = await buildManagerNames(ctx, teams, currentSeason);

    // Debug roster availability
    console.log("Team roster check:", {
      totalTeams: teams.length,
      teamsWithRosters: teams.filter(t => t.roster && t.roster.length > 0).length,
      firstTeamRosterSize: teams[0]?.roster?.length || 0
    });
    
    // Enhance team data with calculated metrics
    // Roster-at-week (historical mode only): a team's roster as it stood in its `rosterWeek`
    // matchup, not the stored `teams.roster` (always the END-OF-SEASON roster) - a week-5 power
    // ranking must not mention a player this team only acquired in week 11. Falls back to the
    // stored roster only when that matchup has no captured lineup (a bye, or a sync gap).
    const rosterWeek = Math.max(args.asOf?.rosterWeek ?? currentWeek, 1);
    // Loosely typed (matches the existing `rosterPlayer: any` convention just below): this can
    // return either a stored `teams.roster` entry or a matchup-roster-shaped one, and the
    // enrichment map right after this treats both the same way.
    const historicalRosterFor = (team: Doc<"teams">): any[] => {
      const matchup = matchups.find(
        m => m.matchupPeriod === rosterWeek && (m.homeTeamId === team.externalId || m.awayTeamId === team.externalId)
      );
      const side = matchup
        ? (matchup.homeTeamId === team.externalId ? matchup.homeRoster : matchup.awayRoster)
        : undefined;
      if (!side) return team.roster;
      return side.players.map(player => ({
        playerId: String(player.espnId),
        playerName: player.fullName,
        position: player.position,
        team: "",
        acquisitionType: "UNKNOWN",
        lineupSlotId: player.lineupSlotId,
        // Not part of `teams.roster`'s shape, but the `...rosterPlayer` spread below carries them
        // into the payload for the prompt layer - real per-week numbers, unlike a season total.
        points: player.points,
        projectedPoints: player.projectedPoints,
      }));
    };

    const enhancedTeams = teams.map(team => {
      // Transform matchups for calculations. Historical mode only ever sees PLAYED matchups here -
      // strength of schedule and recent form must never be computed off a later week's real result.
      const matchupData = playedMatchups.map(m => ({
        teamA: m.homeTeamId,
        teamB: m.awayTeamId,
        scoreA: m.homeScore,
        scoreB: m.awayScore,
        week: m.matchupPeriod,
        projectedScoreA: m.homeProjectedScore,
        projectedScoreB: m.awayProjectedScore,
        isUpset: false,
      }));
      
      // Calculate metrics
      const strengthOfSchedule = calculateStrengthOfSchedule(
        team.externalId,
        matchupData,
        standings
      );
      
      const recentForm = calculateRecentForm(
        team.externalId,
        matchupData,
        3
      );
      
      // Find playoff seed
      const standing = standings.find(s => s.teamId === team.externalId);
      const playoffSeed = standing?.playoffSeed || standing?.rank;
      
      // Enrich roster with player stats from playersEnhanced. Historical mode sources the roster
      // from this team's `rosterWeek` matchup instead of the stored (end-of-season) `team.roster` -
      // see `historicalRosterFor` above.
      const rosterSource = historicalMode ? historicalRosterFor(team) : team.roster;
      const enrichedRoster = rosterSource.map((rosterPlayer: any) => {
        // Find the enhanced player data
        const enhancedPlayer = playersEnhanced.find((p: any) => 
          p.espnId === rosterPlayer.playerId && p.season === currentSeason
        );
        
        // Get stats from playerStats if available
        const playerStats = enhancedPlayer ? {
          seasonStats: {
            appliedTotal: enhancedPlayer.actualStats?.["120"] || 0, // Total fantasy points
            projectedTotal: enhancedPlayer.projectedStats?.["120"] || 0,
            averagePoints: (enhancedPlayer.actualStats?.["102"] || 0) > 0 
              ? (enhancedPlayer.actualStats?.["120"] || 0) / (enhancedPlayer.actualStats?.["102"] || 1)
              : 0,
            gamesPlayed: enhancedPlayer.actualStats?.["102"] || 0,
          },
          recentPerformance: {
            avgPoints: 0, // Would need to calculate from recent games
            trend: "stable" as const,
          }
        } : null;
        
        const nflTeam = enhancedPlayer?.proTeamAbbrev || rosterPlayer.team || undefined;

        return {
          ...rosterPlayer,
          playerId: rosterPlayer.playerId, // This is the ESPN ID
          espnId: rosterPlayer.playerId, // Make it clear this is ESPN ID
          fullName: enhancedPlayer?.fullName || rosterPlayer.playerName,
          playerName: enhancedPlayer?.fullName || rosterPlayer.playerName,
          position: enhancedPlayer?.defaultPosition || rosterPlayer.position,
          // Legacy key, unchanged: the NFL team abbreviation. New code reads the
          // three explicit keys below (spec section 4.3) and never this one.
          team: nflTeam,
          nflTeam,
          fantasyTeamId: String(team.externalId),
          fantasyTeamName: team.name,
          injured: enhancedPlayer?.injured || false,
          injuryStatus: enhancedPlayer?.injuryStatus,
          stats: playerStats,
        };
      });
      
      return {
        id: team._id,
        name: team.name,
        // Legacy key, unchanged: the raw ESPN owner string. `manager` is the
        // display name the prompt layer prints.
        owner: team.owner,
        manager: managerNames.get(team._id) ?? UNKNOWN_MANAGER,
        logo: team.logo,
        abbreviation: team.abbreviation,
        // `team.record` is REPLACED by the computed through-week record in historical mode - the
        // stored one is always the end-of-season record (spec: brief A deliverable 1).
        record: historicalMode
          ? {
              wins: standingsByExternalId.get(team.externalId)?.wins ?? 0,
              losses: standingsByExternalId.get(team.externalId)?.losses ?? 0,
              ties: standingsByExternalId.get(team.externalId)?.ties ?? 0,
              pointsFor: standingsByExternalId.get(team.externalId)?.pointsFor ?? 0,
              pointsAgainst: standingsByExternalId.get(team.externalId)?.pointsAgainst ?? 0,
              playoffSeed: standingsByExternalId.get(team.externalId)?.playoffSeed,
            }
          : team.record,
        pointsFor: historicalMode
          ? standingsByExternalId.get(team.externalId)?.pointsFor ?? 0
          : team.record.pointsFor ?? 0,
        pointsAgainst: historicalMode
          ? standingsByExternalId.get(team.externalId)?.pointsAgainst ?? 0
          : team.record.pointsAgainst ?? 0,
        roster: enrichedRoster,
        playoffSeed,
        strengthOfSchedule,
        recentForm,
        benchPoints: 0, // Would calculate from roster data
        // Not cheaply derivable through-week (see the `standings` computation above) - never the
        // stale end-of-season split in historical mode.
        divisionRecord: historicalMode ? undefined : team.record.divisionRecord,
        divisionId: team.divisionId !== undefined ? String(team.divisionId) : undefined,
        division: divisionNameFor(team.divisionId),
        externalId: team.externalId, // Important for matching
      };
    });
    
    // Transform recent matchups with memorable moments
    // Only games that have actually been played are "recent"; a scheduled game with 0-0 and no
    // winner is the upcoming slate, which `upcomingMatchups` below carries separately.
    const playedRecentMatchups = recentMatchups.filter(
      matchup => matchup.winner !== undefined || matchup.homeScore > 0 || matchup.awayScore > 0
    );

    /**
     * In-game injuries (spec §16, owner ask 2026-09-05): a player hurt DURING his game scores
     * like a bad start in the box score, so a recap/preview must never call starting him
     * mismanagement, and `topPerformersFor` below must never crown a healthy bench player as
     * having "replaced" him. Covers every week this payload's recent matchups span; a preview
     * (no played game yet in the lookback window) still checks the most recently completed week,
     * since a preview can reference "he left banged up last week" without a played game of its own.
     */
    const inGameInjuryWeeks = playedRecentMatchups.length > 0
      ? [...new Set(playedRecentMatchups.map(m => m.matchupPeriod))]
      : [Math.max(1, currentWeek - 1)];
    const inGameInjuriesByWeek = new Map<number, InGameInjury[]>();
    for (const w of inGameInjuryWeeks) {
      const hits: InGameInjury[] = await ctx.runQuery(internal.inGameInjuries.getInGameInjuriesForWeek, {
        leagueId: args.leagueId,
        seasonId: currentSeason,
        week: w,
      });
      inGameInjuriesByWeek.set(w, hits);
    }
    const inGameInjuries: InGameInjury[] = [...inGameInjuriesByWeek.values()].flat();
    const injuredEspnIdsByWeek = new Map<number, Set<string>>();
    for (const [w, hits] of inGameInjuriesByWeek) {
      injuredEspnIdsByWeek.set(w, new Set(hits.map(h => h.espnId)));
    }

    /**
     * Per-matchup top performers for the generic path (power rankings, previews, awards, playoff
     * picture, season recap). The weekly-recap query has always built these; this path never did,
     * so `facts.matchups[].players` was empty for every generic article and the verifier had no
     * player ids to check a writer's featured players against - each one came back as an
     * "unknown player" block (found by the 2025 season backfill, but the gap is the same live).
     * Shape mirrors the recap query's `topPerformers` so `src/lib/ai/facts.ts#buildMatchupPlayers`
     * reads both identically. Starters are lineup slots other than bench (20) and IR (21).
     */
    type LineupPlayer = {
      lineupSlotId: number;
      espnId: number;
      fullName: string;
      position: string;
      points: number;
      projectedPoints?: number;
    };
    const BENCH_SLOT = 20;
    const IR_SLOT = 21;
    const topPerformersFor = (
      side: { players: LineupPlayer[] } | undefined,
      team: Doc<"teams"> | undefined,
      externalId: string,
      // In-game-injured starters' espnIds for this matchup's week (spec §16) - excluded from the
      // "worst starter at the position" comparison below, so a healthy bench player is never
      // credited with "replacing" a man who left the game hurt.
      injuredEspnIds: ReadonlySet<string> | undefined,
    ) => {
      const players = side?.players ?? [];
      const asPerformer = (p: LineupPlayer, isStarter: boolean) => ({
        playerId: String(p.espnId),
        playerName: p.fullName,
        position: p.position,
        points: p.points,
        projectedPoints: p.projectedPoints ?? 0,
        fantasyTeamId: externalId,
        fantasyTeamName: team?.name ?? externalId,
        isStarter,
        lineupSlotId: p.lineupSlotId,
        overPerformance: p.projectedPoints
          ? (((p.points - p.projectedPoints) / p.projectedPoints) * 100).toFixed(1)
          : 0,
      });
      const starters = players.filter(p => p.lineupSlotId !== BENCH_SLOT && p.lineupSlotId !== IR_SLOT);
      const bench = players.filter(p => p.lineupSlotId === BENCH_SLOT);
      const topStarters = [...starters]
        .sort((a, b) => b.points - a.points)
        .slice(0, 3)
        .map(p => asPerformer(p, true));
      const healthyStartersAt = (position: string) =>
        starters.filter(s => s.position === position && !injuredEspnIds?.has(String(s.espnId)));
      const impactfulBench = bench
        .filter(b => {
          if (b.points < 15) return false;
          const samePosition = healthyStartersAt(b.position);
          if (samePosition.length === 0) return false;
          const worst = [...samePosition].sort((a, c) => a.points - c.points)[0];
          return b.points - worst.points >= 10;
        })
        .sort((a, b) => b.points - a.points)
        .slice(0, 1)
        .map(b => {
          const worst = [...healthyStartersAt(b.position)].sort((a, c) => a.points - c.points)[0];
          return {
            ...asPerformer(b, false),
            benchImpact: true,
            wouldHaveReplacedPlayer: worst.fullName,
            pointImprovementIfStarted: (b.points - worst.points).toFixed(1),
          };
        });
      const benchPoints = bench.reduce((sum, p) => sum + p.points, 0);
      return { performers: [...topStarters, ...impactfulBench], benchPoints };
    };

    const enrichedMatchups = playedRecentMatchups.map(matchup => {
      const homeTeam = teams.find(t => t.externalId === matchup.homeTeamId);
      const awayTeam = teams.find(t => t.externalId === matchup.awayTeamId);
      const injuredEspnIds = injuredEspnIdsByWeek.get(matchup.matchupPeriod);
      const homeSide = topPerformersFor(matchup.homeRoster, homeTeam, matchup.homeTeamId, injuredEspnIds);
      const awaySide = topPerformersFor(matchup.awayRoster, awayTeam, matchup.awayTeamId, injuredEspnIds);
      
      const matchupData = {
        teamA: matchup.homeTeamId,
        teamB: matchup.awayTeamId,
        scoreA: matchup.homeScore,
        scoreB: matchup.awayScore,
        week: matchup.matchupPeriod,
        projectedScoreA: matchup.homeProjectedScore,
        projectedScoreB: matchup.awayProjectedScore,
        isUpset: matchup.homeProjectedScore && matchup.awayProjectedScore
          ? (matchup.homeProjectedScore > matchup.awayProjectedScore && matchup.awayScore > matchup.homeScore) ||
            (matchup.awayProjectedScore > matchup.homeProjectedScore && matchup.homeScore > matchup.awayScore)
          : false,
        benchPointsA: homeSide.benchPoints,
        benchPointsB: awaySide.benchPoints,
      };
      
      const memorableMoment = identifyMemorableMoments(matchupData);
      
      return {
        ...matchup,
        topPerformers: [...homeSide.performers, ...awaySide.performers],
        benchPointsA: homeSide.benchPoints,
        benchPointsB: awaySide.benchPoints,
        // Same shape getWeeklyRecapDataForAI produces: names, external ids and
        // manager display names, so the prompt layer never has to guess which
        // of teamA/teamB is a name and which is an id.
        teamA: homeTeam?.name || matchup.homeTeamId,
        teamB: awayTeam?.name || matchup.awayTeamId,
        teamAId: matchup.homeTeamId,
        teamBId: matchup.awayTeamId,
        teamAOwner: homeTeam ? managerNames.get(homeTeam._id) ?? UNKNOWN_MANAGER : UNKNOWN_MANAGER,
        teamBOwner: awayTeam ? managerNames.get(awayTeam._id) ?? UNKNOWN_MANAGER : UNKNOWN_MANAGER,
        scoreA: matchup.homeScore,
        scoreB: matchup.awayScore,
        projectedScoreA: matchup.homeProjectedScore,
        projectedScoreB: matchup.awayProjectedScore,
        // Kept for compatibility with existing readers.
        teamAName: homeTeam?.name || "Unknown",
        teamBName: awayTeam?.name || "Unknown",
        memorableMoment,
        isUpset: matchupData.isUpset,
      };
    });
    
    /* ---------------------------------------------------------------------- *
     * The upcoming slate (spec 4.3, `facts.upcoming`).
     *
     * ESPN ships the entire season schedule on the first sync, so a game that
     * has not kicked off is already a `matchups` row: `homeScore`/`awayScore`
     * are 0, `winner` is undefined (ESPN's "UNDECIDED" maps to nothing) and
     * the projected scores are usually absent until the week is live. Those
     * rows are the only look-ahead data in this payload - without them a
     * "week 8 preview" gets written as a recap of week 7.
     * ---------------------------------------------------------------------- */
    const hasBeenPlayed = (matchup: Doc<"matchups">) =>
      matchup.winner !== undefined || matchup.homeScore > 0 || matchup.awayScore > 0;

    // Preview the current week while none of its games have been played; once
    // the week is under way (or over), the look-ahead is the following week.
    // Historical mode already knows exactly which week is "played" (asOf.week), so the look-ahead
    // is always the very next one - `asOf.week + 1` (1 when week is 0, before the first game) -
    // rather than this live-only "has anything in the current week kicked off yet" inference, whose
    // ambiguity does not exist once every matchup's outcome is already on record.
    const currentWeekGames = matchups.filter(m => m.matchupPeriod === currentWeek);
    const previewWeek = historicalMode
      ? currentWeek + 1
      : currentWeekGames.length > 0 && currentWeekGames.every(game => !hasBeenPlayed(game))
        ? currentWeek
        : currentWeek + 1;

    const teamByExternalId = new Map(teams.map(team => [team.externalId, team]));

    // Through-week wins/losses/ties in historical mode - `team.record` is the end-of-season record.
    const formatTeamRecord = (team: Doc<"teams"> | undefined) => {
      if (!team) return undefined;
      const computed = historicalMode ? standingsByExternalId.get(team.externalId) : undefined;
      const wins = computed?.wins ?? team.record.wins ?? 0;
      const losses = computed?.losses ?? team.record.losses ?? 0;
      const ties = computed?.ties ?? team.record.ties ?? 0;
      return `${wins}-${losses}-${ties}`;
    };

    // Through-week pointsFor in historical mode, same reasoning as `formatTeamRecord` above.
    const pointsForOf = (team: Doc<"teams"> | undefined): number | undefined => {
      if (!team) return undefined;
      if (!historicalMode) return team.record.pointsFor;
      return standingsByExternalId.get(team.externalId)?.pointsFor;
    };

    /** Meetings already played this season, home/away agnostic. Ties count for neither side. */
    const headToHeadFor = (teamAId: string, teamBId: string) => {
      let teamAWins = 0;
      let teamBWins = 0;
      for (const game of matchups) {
        if (game.matchupPeriod >= previewWeek || !hasBeenPlayed(game)) continue;
        const isMeeting =
          (game.homeTeamId === teamAId && game.awayTeamId === teamBId) ||
          (game.homeTeamId === teamBId && game.awayTeamId === teamAId);
        if (!isMeeting) continue;
        if (game.winner === "tie" || game.homeScore === game.awayScore) continue;
        const homeWon = game.winner ? game.winner === "home" : game.homeScore > game.awayScore;
        const winnerId = homeWon ? game.homeTeamId : game.awayTeamId;
        if (winnerId === teamAId) teamAWins++;
        else teamBWins++;
      }
      return teamAWins + teamBWins > 0 ? { teamAWins, teamBWins } : undefined;
    };

    // When the preview week falls inside the playoffs, every entry gets the round it belongs to
    // (spec: articles centred on the playoffs) - the same arithmetic `buildPlayoffContext` uses for
    // `currentRound`, since a preview week and a "current round" are the same kind of lookup.
    const previewIsPlayoffWeek = previewWeek >= playoffs.playoffStartWeek && previewWeek <= playoffs.championshipWeek;
    const previewRoundName = previewIsPlayoffWeek
      ? playoffRoundName(
          Math.min(
            Math.max(
              0,
              Math.floor((previewWeek - playoffs.playoffStartWeek) / (leagueFormat.playoffMatchupPeriodLength ?? 1))
            ),
            playoffs.rounds - 1
          ),
          playoffs.rounds
        )
      : undefined;

    // The raw (unreshaped) matchup rows for the preview week - the only place in this handler
    // that still has each side's roster, so both the player board and each game's `keyPlayers`
    // are built from this same set before it gets reshaped into the display `upcomingMatchups`
    // below (which carries team names/records, not rosters).
    const previewWeekMatchups = matchups.filter(game => game.matchupPeriod === previewWeek);

    /* ---------------------------------------------------------------------- *
     * Player board (owner directive, 2026-09-03): league-relative player rankings ("WR1 vs
     * WR12") so a preview can talk about players and their standing without leaning on a 0-0
     * record. `basis` flips to "season_points" itself once `liveThroughWeek` says a week has
     * actually finished - see `buildPlayerBoard`'s header and `convex/lib/playerBoard.ts`.
     * `enhancedTeams` (built above) already carries the joined name/position/nflTeam/injury data
     * `team.roster` alone doesn't have; reused here rather than re-deriving it a second time.
     * ---------------------------------------------------------------------- */
    const playerBoardTeams: PlayerBoardTeamInput[] = enhancedTeams.map(team => ({
      externalId: team.externalId,
      name: team.name,
      roster: team.roster.map((player: any) => ({
        playerId: String(player.playerId),
        playerName: player.fullName || player.playerName,
        position: player.position,
        team: player.nflTeam,
        injuryStatus: player.injuryStatus,
        lineupSlotId: player.lineupSlotId,
      })),
    }));
    const playerBoardPlayedMatchups: PlayerBoardMatchupInput[] = matchups
      .filter(m => m.matchupPeriod <= liveThroughWeek)
      .map(m => ({
        matchupPeriod: m.matchupPeriod,
        homeTeamId: m.homeTeamId,
        awayTeamId: m.awayTeamId,
        homeRoster: m.homeRoster,
        awayRoster: m.awayRoster,
      }));
    const playerBoard = buildPlayerBoard({
      teams: playerBoardTeams,
      playedMatchups: playerBoardPlayedMatchups,
      upcomingMatchups: previewWeekMatchups.map(m => ({
        matchupPeriod: m.matchupPeriod,
        homeTeamId: m.homeTeamId,
        awayTeamId: m.awayTeamId,
        homeRoster: m.homeRoster,
        awayRoster: m.awayRoster,
      })),
      draftPicks,
      throughWeek: liveThroughWeek,
    });
    const positionRankByPlayerId = new Map(playerBoard.entries.map(e => [e.playerId, e.positionRank]));

    const upcomingMatchups = [...previewWeekMatchups]
      .sort((a, b) => (Number(a.homeTeamId) || 0) - (Number(b.homeTeamId) || 0))
      .map(game => {
        const homeTeam = teamByExternalId.get(game.homeTeamId);
        const awayTeam = teamByExternalId.get(game.awayTeamId);

        return {
          week: game.matchupPeriod,
          // Names in teamA/teamB and ESPN ids in teamAId/teamBId - the same shape
          // `recentMatchups` uses above, so FACTS resolves both the same way.
          teamA: homeTeam?.name || game.homeTeamId,
          teamB: awayTeam?.name || game.awayTeamId,
          teamAId: game.homeTeamId,
          teamBId: game.awayTeamId,
          teamAOwner: homeTeam ? managerNames.get(homeTeam._id) ?? UNKNOWN_MANAGER : UNKNOWN_MANAGER,
          teamBOwner: awayTeam ? managerNames.get(awayTeam._id) ?? UNKNOWN_MANAGER : UNKNOWN_MANAGER,
          teamARecord: formatTeamRecord(homeTeam),
          teamBRecord: formatTeamRecord(awayTeam),
          teamAPointsFor: pointsForOf(homeTeam),
          teamBPointsFor: pointsForOf(awayTeam),
          // ESPN's own team-level projection when it has published one; otherwise the sum of each
          // side's starters' own `projectedPoints` (spec: player board) - never left blank when
          // the lineup data to compute it is already on hand.
          projectedScoreA: game.homeProjectedScore ?? sumStarterProjected(game.homeRoster),
          projectedScoreB: game.awayProjectedScore ?? sumStarterProjected(game.awayRoster),
          isPlayoff: game.playoffTier && game.playoffTier !== "NONE" ? true : undefined,
          // Round name/tier (spec: playoffs round) - only meaningful inside the playoffs.
          round: previewRoundName,
          tier: game.playoffTier && game.playoffTier !== "NONE" ? game.playoffTier : undefined,
          headToHead: headToHeadFor(game.homeTeamId, game.awayTeamId),
          // Top 3 projected starters per side (spec: "notable players and their rankings") - ranks
          // come from the same player board the rest of the article cites.
          keyPlayers: [
            ...topKeyPlayers("A", game.homeRoster?.players ?? [], positionRankByPlayerId),
            ...topKeyPlayers("B", game.awayRoster?.players ?? [], positionRankByPlayerId),
          ],
        };
      });

    // Byes for the preview week (spec: "seed 1 rests") - excluded from `matchups` above (they're
    // not games), sourced from the raw rows so they can still be recognised and named.
    const upcomingByes = previewIsPlayoffWeek
      ? allMatchupsRaw
          .filter(m => m.matchupPeriod === previewWeek && isByeMatchup(m))
          .map(m => {
            const teamId = m.homeTeamId !== "" ? m.homeTeamId : m.awayTeamId;
            const team = teamByExternalId.get(teamId);
            const seed = playoffs.seeds.find(s => s.teamId === teamId)?.seed;
            return { week: previewWeek, bye: { teamId, name: team?.name ?? teamId, seed: seed ?? 0 } };
          })
      : [];

    // Analyze transaction trends
    const transactionTrends = analyzeTransactionTrends(
      scopedTransactions as any // Type mismatch - helper expects different format
    );
    
    // Calculate playoff probabilities. `calculatePlayoffProbabilities` clamps a negative
    // remaining-week count itself (the season can already be past its configured length), so this
    // call site only needs its best-known inputs, not its own clamping.
    const remainingWeeks = (leagueFormat.regularSeasonMatchupPeriods ?? 13) - currentWeek;
    const playoffProbabilities = calculatePlayoffProbabilities(
      standings,
      remainingWeeks,
      leagueFormat.playoffTeamCount
    );
    
    // Format trades with analysis
    // The prompt layer (LeagueDataContext.trades) reads team NAMES and `playersFromA/B` with a
    // `date` string; the table stores `teamA/teamB` objects and `playersFromTeamA/B`. Both shapes
    // are carried: the raw fields for readers that already use them, the context shape for FACTS.
    // (Before the trades table was populated this mismatch was invisible; the first derived trade
    // crashed every generic article on `playersFromA.map`.)
    const enrichedTrades = scopedTrades.map(trade => ({
      ...trade,
      teamA: trade.teamA.teamName,
      teamB: trade.teamB.teamName,
      teamAId: trade.teamA.teamId,
      teamBId: trade.teamB.teamId,
      teamAManager: trade.teamA.manager,
      teamBManager: trade.teamB.manager,
      playersFromA: trade.playersFromTeamA.map(p => ({ playerId: p.playerId, playerName: p.playerName, position: p.position })),
      playersFromB: trade.playersFromTeamB.map(p => ({ playerId: p.playerId, playerName: p.playerName, position: p.position })),
      date: new Date(trade.tradeDate).toISOString(),
      analysis: trade.analysis?.summary,
      daysAgo: Math.floor((Date.now() - trade.tradeDate) / (1000 * 60 * 60 * 24)),
    }));
    
    // Format rivalries with recent matchups. `playedMatchups` (live mode: identical to `matchups`;
    // historical mode: only matchupPeriod <= currentWeek) so a rivalry's "recent games" can never
    // include a later week's real result.
    const enrichedRivalries = rivalries.map(rivalry => {
      const recentGames = playedMatchups.filter(m =>
        (m.homeTeamId === rivalry.teamA.teamId && m.awayTeamId === rivalry.teamB.teamId) ||
        (m.homeTeamId === rivalry.teamB.teamId && m.awayTeamId === rivalry.teamA.teamId)
      ).slice(-3);
      
      return {
        ...rivalry,
        recentGames: recentGames.map(game => ({
          week: game.matchupPeriod,
          teamAScore: game.homeTeamId === rivalry.teamA.teamId ? game.homeScore : game.awayScore,
          teamBScore: game.homeTeamId === rivalry.teamB.teamId ? game.homeScore : game.awayScore,
          winner: game.homeScore > game.awayScore 
            ? (game.homeTeamId === rivalry.teamA.teamId ? "teamA" : "teamB")
            : (game.homeTeamId === rivalry.teamA.teamId ? "teamB" : "teamA"),
        })),
      };
    });
    
    // Fresh player intel (Sleeper / nflverse / FFC via convex/intel.ts) for every rostered player,
    // live mode only: a backfill describes a past week, and today's injury report is not part of
    // it. Only entries that say something survive, so the prompt does not print 160 blank lines.
    let playerIntel: PlayerIntelEntry[] = [];
    if (!historicalMode) {
      try {
        const rosteredIds = [...new Set(
          enhancedTeams.flatMap(team => (team.roster ?? []).map(player => String(player.espnId ?? player.playerId)))
        )].filter(id => id && id !== "undefined");
        const intel = await getIntelForPlayersImpl(ctx, { season: currentSeason, espnIds: rosteredIds, now: Date.now() });
        playerIntel = intel.filter(intelHasContent);
      } catch (error) {
        console.log("Player intel lookup failed, continuing without it:", error);
      }
    }

    return {
      league: {
        id: league._id,
        name: league.name,
        settings: league.settings,
        espnData: league.espnData,
      },
      currentWeek,
      currentSeason,
      leagueType: inferredLeagueType,
      teams: enhancedTeams,
      // Fresh injury / practice / depth-chart / news intel keyed by ESPN id (2026-09-05). Carried
      // through aiContent.ts's reshape; src/lib/ai/facts.ts turns it into the INTEL facts.
      playerIntel,
      standings,
      // Present only when the league has divisions (spec: format audit).
      divisionStandings,
      // League-format facts: scoring, roster shape, playoff structure, divisions, waivers. Read
      // through `facts.format` in the prompt layer; `playoffTeams` / `regularSeasonWeeks` below
      // stay for back-compat with prompt code that reads the flat fields.
      leagueFormat,
      recentMatchups: enrichedMatchups,
      // Every in-game injury covering this payload's recent-matchups weeks (spec §16). Carried
      // through `aiContent.ts`'s reshape so `src/lib/ai/facts.ts` can build the per-player
      // `leftGameInjured` FACTS entry and the HOUSE STYLE line.
      inGameInjuries,
      // Unplayed games for the look-ahead week (spec 4.3), plus any byes that week (spec: playoffs
      // round - "seed 1 rests"). Empty once the schedule runs out, which is what makes
      // weekly_preview refuse.
      upcomingMatchups: [...upcomingMatchups, ...upcomingByes],
      trades: enrichedTrades,
      transactions: scopedTransactions.slice(0, 20), // Most recent 20
      rivalries: enrichedRivalries,
      managerActivity,
      transactionTrends,
      playoffProbabilities,
      // The playoff picture / bracket (owner ask, Sept 2026 - see this handler's `playoffs` build
      // above). Carried through `aiContent.ts`'s reshape (orchestrator: add `playoffs:
      // enrichedData.playoffs` there) so the writers and `src/lib/ai/facts.ts` can read it.
      playoffs,
      // League-relative player rankings (owner directive, 2026-09-03 - see this handler's
      // `playerBoard` build above). Whitelisted through `aiContent.ts`'s reshape the same way.
      playerBoard,

      // NEW: Historical data for season welcome packages
      previousSeasons,
      leagueHistory: {
        seasons: championshipHistory,
        allTimeRecords,
      },

      metadata: {
        dataFreshness: Date.now(),
        totalTeams: teams.length,
        playoffTeams: leagueFormat.playoffTeamCount ?? 6,
        regularSeasonWeeks: leagueFormat.regularSeasonMatchupPeriods,
        scoringType: league.settings.scoringType,
        historicalSeasons: Object.keys(previousSeasons).length,
        totalHistoricalTeams: allHistoricalTeams.length,
      },
    };
  },
});;

// Get specific matchup data for detailed analysis
export const getMatchupDataForAI = internalQuery({
  args: {
    leagueId: v.id("leagues"),
    week: v.number(),
    teamAId: v.string(),
    teamBId: v.string(),
  },
  async handler(ctx, args) {
    const league = await ctx.db.get(args.leagueId);
    if (!league) throw new Error("League not found");
    
    const currentSeason = league.espnData?.seasonId || new Date().getFullYear();
    
    // Get the specific matchup
    const matchup = await ctx.db
      .query("matchups")
      .withIndex("by_unique_matchup", q => 
        q.eq("leagueId", args.leagueId)
         .eq("seasonId", currentSeason)
         .eq("matchupPeriod", args.week)
         .eq("homeTeamId", args.teamAId)
         .eq("awayTeamId", args.teamBId)
      )
      .first();
    
    if (!matchup) {
      // Try reversed
      const reversedMatchup = await ctx.db
        .query("matchups")
        .withIndex("by_unique_matchup", q => 
          q.eq("leagueId", args.leagueId)
           .eq("seasonId", currentSeason)
           .eq("matchupPeriod", args.week)
           .eq("homeTeamId", args.teamBId)
           .eq("awayTeamId", args.teamAId)
        )
        .first();
      
      if (!reversedMatchup) throw new Error("Matchup not found");
      
      // Return with teams in requested order
      return {
        ...reversedMatchup,
        homeTeamId: args.teamAId,
        awayTeamId: args.teamBId,
        homeScore: reversedMatchup.awayScore,
        awayScore: reversedMatchup.homeScore,
        homeProjectedScore: reversedMatchup.awayProjectedScore,
        awayProjectedScore: reversedMatchup.homeProjectedScore,
      };
    }
    
    return matchup;
  },
});

// Get player performance data for a specific week
export const getWeeklyPlayerDataForAI = internalQuery({
  args: {
    leagueId: v.id("leagues"),
    week: v.number(),
  },
  async handler(ctx, args) {
    const league = await ctx.db.get(args.leagueId);
    if (!league) throw new Error("League not found");
    
    const currentSeason = league.espnData?.seasonId || new Date().getFullYear();
    
    // Get all teams for the week
    const teams = await ctx.db
      .query("teams")
      .withIndex("by_season", q => q.eq("leagueId", args.leagueId).eq("seasonId", currentSeason))
      .collect();
    
    // Collect all players with their weekly performance
    const allPlayers: Array<{
      playerName: string;
      position: string;
      /** Legacy: the NFL team abbreviation. */
      team: string;
      nflTeam?: string;
      fantasyTeamId: string;
      fantasyTeamName: string;
      /** Legacy alias of `fantasyTeamName`. */
      fantasyTeam: string;
      points: number;
      projected: number;
      started: boolean;
    }> = [];
    
    teams.forEach(team => {
      team.roster.forEach(player => {
        if (player.playerStats?.appliedTotal !== undefined) {
          allPlayers.push({
            playerName: player.playerName,
            position: player.position,
            team: player.team,
            nflTeam: player.team || undefined,
            fantasyTeamId: String(team.externalId),
            fantasyTeamName: team.name,
            fantasyTeam: team.name,
            points: player.playerStats.appliedTotal,
            projected: player.playerStats.projectedTotal || 0,
            started: player.lineupSlotId !== undefined && player.lineupSlotId < 20,
          });
        }
      });
    });
    
    // Sort by points and get top performers
    const topPerformers = allPlayers
      .filter(p => p.started)
      .sort((a, b) => b.points - a.points)
      .slice(0, 20);
    
    // Get biggest busts (underperformed projections)
    const biggestBusts = allPlayers
      .filter(p => p.started && p.projected > 10)
      .map(p => ({ ...p, differential: p.points - p.projected }))
      .sort((a, b) => a.differential - b.differential)
      .slice(0, 10);
    
    // Get best bench performances
    const bestBenchPerformances = allPlayers
      .filter(p => !p.started)
      .sort((a, b) => b.points - a.points)
      .slice(0, 10);
    
    return {
      week: args.week,
      topPerformers,
      biggestBusts,
      bestBenchPerformances,
      totalPlayers: allPlayers.length,
    };
  },
});

// Get mock draft data for AI content generation
export const getMockDraftDataForAI = internalQuery({
  args: {
    leagueId: v.id("leagues"),
    seasonId: v.optional(v.number()),
  },
  async handler(ctx, args) {
    console.log("=== getMockDraftDataForAI START (OPTIMIZED V2) ===");
    const startTime = Date.now();
    
    try {
      const league = await ctx.db.get(args.leagueId);
      if (!league) throw new Error("League not found");
      
      const targetSeason = args.seasonId || league.espnData?.seasonId || new Date().getFullYear();
      console.log("Target season:", targetSeason);
    
      // Get league season data for draft information
      const leagueSeason = await ctx.db
        .query("leagueSeasons")
        .withIndex("by_league_season", q => q.eq("leagueId", args.leagueId).eq("seasonId", targetSeason))
        .first();
      
      if (!leagueSeason) {
        console.log("No league season found, returning minimal mock data");
        return createMinimalMockDraftData(league.name, targetSeason, league.settings);
      }
      
      // Get teams (limit to avoid timeout)
      const teams = await ctx.db
        .query("teams")
        .withIndex("by_season", q => q.eq("leagueId", args.leagueId).eq("seasonId", targetSeason))
        .take(12); // Limit to 12 teams max
      
      console.log(`Found ${teams.length} teams for season ${targetSeason}`);

      // Manager display names, never the raw ESPN owner string (spec section 2).
      const managerNames = await buildManagerNames(ctx, teams, targetSeason);
      
      // The draft pool (owner ask, 2026-09-05): the top ${POOL_SIZE} players by ESPN ADP for the
      // season, read through the ADP index - this used to take an arbitrary 200 rows of the
      // 1,100-player table and keep the 50 best of those, so most of the first round could be
      // missing. Each player carries ADP, positional ADP rank, projection, injury status and
      // ESPN's season outlook (full text for the top ${OUTLOOK_DEPTH}).
      let poolSources: PoolSource[] = [];
      try {
        const ranked = await ctx.db
          .query("playersEnhanced")
          .withIndex("by_season_adp", q => q.eq("season", targetSeason).gt("ownership.averageDraftPosition", 0))
          .order("asc")
          .filter(q => q.eq(q.field("active"), true))
          .take(POOL_SIZE + 40);
        poolSources = ranked.map(player => {
          const projectedStats = Array.isArray(player.stats)
            ? player.stats.find((stat: any) =>
                stat.externalId === String(targetSeason) && stat.statSourceId === 1 && stat.appliedTotal > 0
              )
            : null;
          return {
            espnId: player.espnId,
            fullName: player.fullName,
            defaultPosition: player.defaultPosition,
            proTeamAbbrev: player.proTeamAbbrev,
            adp: player.ownership?.averageDraftPosition ?? 0,
            injured: player.injured,
            injuryStatus: player.injuryStatus,
            seasonOutlook: player.seasonOutlook,
            projected: projectedStats
              ? { total: projectedStats.appliedTotal || 0, average: projectedStats.appliedAverage || 0 }
              : null,
          };
        });
        console.log("Draft pool candidates:", poolSources.length);
      } catch (error) {
        console.log("Player query failed, continuing with an empty pool:", error);
      }
      const basePool = buildDraftPool(poolSources);

      // The week's ESPN headlines for pool players, plus a 30-day window for injury context.
      // `espnNews.categories.athletes[].id` is the same ESPN athlete id as `playersEnhanced.espnId`.
      let newsSources: NewsSource[] = [];
      try {
        const recentNews = await ctx.db.query("espnNews").withIndex("by_published").order("desc").take(600);
        newsSources = recentNews
          .filter(item => item.categories?.athletes?.length)
          .map(item => ({
            headline: item.headline,
            published: item.published,
            athleteIds: item.categories.athletes.map(a => String(a.id)),
          }));
      } catch (error) {
        console.log("News query failed, continuing without headlines:", error);
      }
      const attached = attachNewsAndInjuryWatch(basePool, newsSources, Date.now());

      // Fresh feeds (Sleeper / nflverse / FFC) for the pool: a Questionable that ESPN still lists
      // ACTIVE, the FFC ADP as a second market, trending adds. Merged into the pool lines and the
      // injury watch; the raw entries ride along as `playerIntel` for FACTS.
      let playerIntel: PlayerIntelEntry[] = [];
      try {
        const intel = await getIntelForPlayersImpl(ctx, {
          season: targetSeason,
          espnIds: attached.pool.map(player => player.playerId),
          now: Date.now(),
        });
        playerIntel = intel.filter(intelHasContent);
      } catch (error) {
        console.log("Player intel lookup failed, continuing without it:", error);
      }
      const { pool: draftablePlayers, injuryWatch } = mergeIntelIntoPool(attached.pool, attached.injuryWatch, playerIntel);

      // Last year's draft, per manager: the receipts behind a hot take ("reached 41 spots for
      // Kamara", "went RB-RB-RB", "waited until round 9 for a quarterback").
      let draftTendencies: DraftTendency[] = [];
      let previousSeason: number | undefined;
      try {
        const prior = await getSimplifiedDraftDataImpl(ctx, { leagueId: args.leagueId, seasonId: targetSeason - 1 });
        if (prior.draftPicks.length > 0) {
          previousSeason = targetSeason - 1;
          const priorTeamIdByName = new Map(prior.draftOrder.map(entry => [entry.teamName, entry.teamId]));
          // The draft order only lists teams in the order; fall back to last season's team rows.
          const priorTeams = await ctx.db
            .query("teams")
            .withIndex("by_season", q => q.eq("leagueId", args.leagueId).eq("seasonId", targetSeason - 1))
            .collect();
          const lastSeason = new Map<string, { record: string; rank: number }>();
          const rankedPrior = [...priorTeams].sort(
            (a, b) => (b.record.wins ?? 0) - (a.record.wins ?? 0) || (b.record.pointsFor ?? 0) - (a.record.pointsFor ?? 0)
          );
          rankedPrior.forEach((t, index) => {
            priorTeamIdByName.set(t.name, t.externalId);
            lastSeason.set(t.externalId, {
              record: `${t.record.wins ?? 0}-${t.record.losses ?? 0}${t.record.ties ? `-${t.record.ties}` : ""}`,
              rank: index + 1,
            });
          });
          const pickOrder: number[] = leagueSeason.draftSettings?.pickOrder ?? [];
          draftTendencies = buildDraftTendencies({
            picks: prior.draftPicks,
            priorTeamIdByName,
            currentTeams: teams.map(team => ({
              externalId: team.externalId,
              name: team.name,
              manager: managerNames.get(team._id) ?? UNKNOWN_MANAGER,
              draftSlot: pickOrder.length ? pickOrder.findIndex(id => String(id) === team.externalId) + 1 || undefined : undefined,
            })),
            lastSeason,
          });
        }
      } catch (error) {
        console.log("Prior draft lookup failed, continuing without tendencies:", error);
      }

      // Extract draft order (simplified)
      let draftOrder: Array<{ position: number; teamId: string; teamName: string; manager: string }> = [];
      if (leagueSeason.draftSettings?.pickOrder && teams.length > 0) {
        // pickOrder contains numbers, but externalId is stored as string
        draftOrder = leagueSeason.draftSettings.pickOrder.slice(0, teams.length).map((teamIdNum: number, index: number) => {
          const teamIdStr = String(teamIdNum);
          const team = teams.find(t => t.externalId === teamIdStr);
          return {
            position: index + 1,
            teamId: teamIdStr,
            teamName: team?.name || `Team ${index + 1}`,
            manager: (team ? managerNames.get(team._id) : undefined) ?? UNKNOWN_MANAGER,
          };
        });
      } else if (teams.length > 0) {
        // If no draft order is set, create one based on available teams
        draftOrder = teams.map((team, index) => ({
          position: index + 1,
          teamId: team.externalId,
          teamName: team.name,
          manager: managerNames.get(team._id) ?? UNKNOWN_MANAGER,
        }));
      }
      
      // Reuses the season row already fetched above (spec: format audit) rather than a second query.
      const leagueFormat = computeLeagueFormat(leagueSeason.settings, league.settings);
      const draftTypeRead = draftTypeFromEspn(leagueSeason.draftSettings?.type, leagueSeason.draftInfo?.draftType);

      const result: any = {
        leagueName: league.name,
        seasonId: targetSeason,
        draftOrder,
        // ESPN's own draft type (src/lib/ai/draftType.ts): SNAKE / AUCTION / OFFLINE, else a flagged default.
        draftType: draftTypeRead.draftType,
        draftTypeAssumed: draftTypeRead.assumed || undefined,
        leagueType: leagueTypeFromDraftSettings(leagueSeason.draftSettings),
        scoringType: league.settings.scoringType,
        rosterSize: league.settings.rosterSize,
        leagueFormat,
        playoffTeams: leagueFormat.playoffTeamCount,
        regularSeasonWeeks: leagueFormat.regularSeasonMatchupPeriods,
        totalTeams: teams.length,
        teams: teams.map(team => ({
          id: team._id,
          externalId: team.externalId,
          name: team.name,
          owner: team.owner, // legacy: raw ESPN owner string
          manager: managerNames.get(team._id) ?? UNKNOWN_MANAGER,
          draftPosition: draftOrder.findIndex(d => d.teamId === team.externalId) + 1,
        })),
        availablePlayers: draftablePlayers,
        playerCount: draftablePlayers.length,
        draftTendencies,
        injuryWatch,
        previousSeason,
        playerIntel,
        metadata: {
          dataFreshness: Date.now(),
          draftablePlayersCount: draftablePlayers.length,
        },
      };
      
      const executionTime = Date.now() - startTime;
      console.log("=== getMockDraftDataForAI SUCCESS ===");
      console.log("Execution time:", executionTime + "ms");
      console.log("Players returned:", result.availablePlayers.length);
      
      return result;
      
    } catch (error) {
      const executionTime = Date.now() - startTime;
      console.error("=== getMockDraftDataForAI ERROR ===");
      console.error("Execution time before error:", executionTime + "ms");
      console.error("Error:", error);
      
      // Return minimal fallback data
      return createMinimalMockDraftData("Mock League", new Date().getFullYear(), {
        scoringType: "PPR",
        rosterSize: 16,
      });
    }
  },
});

// Helper function to create minimal mock draft data
function createMinimalMockDraftData(
  leagueName: string, 
  seasonId: number, 
  settings: any
) {
  return {
    leagueName,
    seasonId,
    draftOrder: [],
    draftType: "Snake",
    leagueType: "Redraft",
    scoringType: settings?.scoringType || "PPR",
    rosterSize: settings?.rosterSize || 16,
    totalTeams: 10,
    teams: [],
    availablePlayers: [
      {
        playerId: "sample1",
        playerName: "CeeDee Lamb",
        position: "WR",
        proTeam: "DAL",
        ownership: {
          averageDraftPosition: 3.5,
          auctionValueAverage: 55,
        },
      },
      {
        playerId: "sample2",
        playerName: "Christian McCaffrey",
        position: "RB",
        proTeam: "SF",
        ownership: {
          averageDraftPosition: 1.2,
          auctionValueAverage: 65,
        },
      },
    ],
    playerCount: 2,
    metadata: {
      dataFreshness: Date.now(),
      draftablePlayersCount: 2,
    },
  };
};

/** The `leagueSeasons.champion`/`runnerUp`/`regularSeasonChampion` shape (schema.ts). */
type StoredSeasonResult = {
  teamId: string;
  teamName: string;
  owner: string;
  record: { wins: number; losses: number; ties: number };
  pointsFor?: number;
};

/**
 * A bracket-derived `BracketTeam` (record `"10-4-0"`) into the stored `leagueSeasons` shape
 * (record `{wins, losses, ties}`) - the two disagree only in how the record is encoded, so this is
 * a pure reshape. `owner` isn't on `BracketTeam` at all (it's an ESPN team-doc field), so callers
 * resolve it themselves and pass it in.
 */
function bracketTeamToStoredChampion(
  bracketTeam: { teamId: string; name: string; record: string; pointsFor: number },
  owner: string
): StoredSeasonResult {
  const [wins, losses, ties] = bracketTeam.record.split("-").map(Number);
  return {
    teamId: bracketTeam.teamId,
    teamName: bracketTeam.name,
    owner,
    record: { wins: wins || 0, losses: losses || 0, ties: ties || 0 },
    pointsFor: bracketTeam.pointsFor,
  };
}

// Get season welcome data for AI content generation
export const getSeasonWelcomeDataForAI = internalQuery({
  args: {
    leagueId: v.id("leagues"),
  },
  async handler(ctx, args) {
    console.log("=== getSeasonWelcomeDataForAI START ===");
    const startTime = Date.now();
    
    try {
      const league = await ctx.db.get(args.leagueId);
      if (!league) throw new Error("League not found");
      
      const currentSeason = league.espnData?.seasonId || new Date().getFullYear();
      
      // Get all league seasons for historical data
      const leagueSeasons = await ctx.db
        .query("leagueSeasons")
        .withIndex("by_league", q => q.eq("leagueId", args.leagueId))
        .order("desc")
        .collect();
      
      console.log(`Found ${leagueSeasons.length} seasons for league`);
      
      // Get current season teams
      const currentTeams = await ctx.db
        .query("teams")
        .withIndex("by_season", q => q.eq("leagueId", args.leagueId).eq("seasonId", currentSeason))
        .collect();
      
      // Build previous seasons data with teams and rosters
      const previousSeasons: Record<number, Array<{
        teamId: string;
        teamName: string;
        manager: string;
        record: { wins: number; losses: number; ties: number; pointsFor?: number; pointsAgainst?: number; };
        roster: Array<{
          playerId: string;
          playerName: string;
          position: string;
          team: string;
          nflTeam?: string;
          fantasyTeamId: string;
          fantasyTeamName: string;
          acquisitionType: string;
          fullName?: string;
        }>;
      }>> = {};
      
      // Fetch teams and rosters for each previous season
      for (const season of leagueSeasons) {
        if (season.seasonId !== currentSeason && season.seasonId) {
          console.log(`Fetching data for season ${season.seasonId}`);
          
          const seasonTeams = await ctx.db
            .query("teams")
            .withIndex("by_season", q => q.eq("leagueId", args.leagueId).eq("seasonId", season.seasonId))
            .collect();
          
          console.log(`Found ${seasonTeams.length} teams for season ${season.seasonId}`);
          
          previousSeasons[season.seasonId] = seasonTeams.map(team => ({
            teamId: team.externalId,
            teamName: team.name,
            manager: espnManagerName(team) || team.owner || UNKNOWN_MANAGER,
            record: {
              wins: team.record.wins,
              losses: team.record.losses,
              ties: team.record.ties,
              pointsFor: team.record.pointsFor,
              pointsAgainst: team.record.pointsAgainst,
            },
            roster: team.roster?.map((player: any) => ({
              playerId: player.playerId,
              playerName: player.playerName,
              position: player.position,
              team: player.team, // legacy: NFL team abbreviation
              nflTeam: player.team || undefined,
              fantasyTeamId: String(team.externalId),
              fantasyTeamName: team.name,
              acquisitionType: player.acquisitionType || "DRAFT",
              fullName: player.playerName,
            })) || [],
          }));
        }
      }
      
      // Build championship history
      const championshipHistory = leagueSeasons
        .filter(season => season.champion)
        .map(season => ({
          year: season.seasonId,
          champion: season.champion,
          runnerUp: season.runnerUp,
          regularSeasonChampion: season.regularSeasonChampion,
        }));
      
      // Calculate all-time records
      const allTimeRecords: Record<string, any> = {};
      
      // Find most championships
      const championshipCounts: Record<string, number> = {};
      championshipHistory.forEach(season => {
        if (season.champion?.owner) {
          championshipCounts[season.champion.owner] = (championshipCounts[season.champion.owner] || 0) + 1;
        }
      });
      
      const mostChampionships = Object.entries(championshipCounts)
        .sort(([,a], [,b]) => b - a)
        .slice(0, 1);
      
      if (mostChampionships.length > 0) {
        allTimeRecords.mostChampionships = {
          manager: mostChampionships[0][0],
          count: mostChampionships[0][1],
        };
      }
      
      // Get basic league data  
      const basicLeagueData: any = await ctx.runQuery(internal.aiQueries.getLeagueDataForAI, {
        leagueId: args.leagueId,
      });
      
      // Collect memorable moments across recent seasons
      const memorableMoments: Array<any> = [];

      // Bracket-derived corrections to `championshipHistory`, keyed by seasonId - populated inside
      // the loop below ("0)"), applied to `championshipHistory` and the championship-count
      // leaderboard once the loop finishes.
      const bracketCorrections = new Map<
        number,
        { champion?: StoredSeasonResult; runnerUp?: StoredSeasonResult; regularSeasonChampion?: StoredSeasonResult }
      >();

      // We'll analyze the last 3 historical seasons for performance & moments
      const seasonsToAnalyze = leagueSeasons
        .filter(s => s.seasonId !== currentSeason)
        .sort((a, b) => b.seasonId - a.seasonId)
        .slice(0, 3);

      for (const season of seasonsToAnalyze) {
        const seasonId = season.seasonId;
        try {
          // Teams and standings for this season
          const seasonTeams = await ctx.db
            .query("teams")
            .withIndex("by_season", q => q.eq("leagueId", args.leagueId).eq("seasonId", seasonId))
            .collect();

          const seasonStandings = [...seasonTeams]
            .sort((a, b) => {
              if ((b.record?.wins || 0) !== (a.record?.wins || 0)) return (b.record?.wins || 0) - (a.record?.wins || 0);
              return (b.record?.pointsFor || 0) - (a.record?.pointsFor || 0);
            })
            .map((t, idx) => ({
              externalId: t.externalId,
              name: t.name,
              owner: t.owner,
              rank: idx + 1,
              playoffSeed: t.record?.playoffSeed,
            }));

          const playoffTeamsCount = season.settings?.playoffTeamCount || league.settings?.playoffTeamCount || 6;

          // 0) Bracket-derived correction for a corrupted stored champion (spec: prod's 2025 season
          // stored champion "joey's Scary Team", a 0-0 team with owner "Unknown", evidently a
          // rolled-over sync artifact - see convex/lib/playoffs.ts's header comment). Only overrides
          // when the stored value is unmistakably wrong (`isCorruptedSeasonResult`); a real, decided
          // champion is left alone. Cheap on purpose: only for these 3 recently-analyzed seasons,
          // reading the same WINNERS_BRACKET rows the memorable-moments detection below also needs.
          if (isCorruptedSeasonResult(season.champion)) {
            try {
              const winnersBracketGames = await ctx.db
                .query("matchups")
                .withIndex("by_league_season", q => q.eq("leagueId", args.leagueId).eq("seasonId", seasonId))
                .filter(q => q.eq(q.field("playoffTier"), "WINNERS_BRACKET"))
                .collect();
              if (winnersBracketGames.length > 0) {
                const seasonFormat = parseEspnLeagueSettings(season.settings);
                const derived = deriveSeasonResults({
                  teams: seasonTeams.map(t => ({
                    externalId: t.externalId,
                    name: t.name,
                    record: {
                      wins: t.record.wins,
                      losses: t.record.losses,
                      ties: t.record.ties,
                      pointsFor: t.record.pointsFor,
                      playoffSeed: t.record.playoffSeed,
                    },
                  })),
                  matchups: winnersBracketGames.map(g => ({
                    matchupPeriod: g.matchupPeriod,
                    homeTeamId: g.homeTeamId,
                    awayTeamId: g.awayTeamId,
                    homeScore: g.homeScore,
                    awayScore: g.awayScore,
                    winner: g.winner,
                    playoffTier: g.playoffTier,
                  })),
                  format: {
                    playoffTeamCount: seasonFormat.playoffTeamCount ?? league.settings?.playoffTeamCount,
                    regularSeasonMatchupPeriods:
                      seasonFormat.regularSeasonMatchupPeriods ?? league.settings?.regularSeasonMatchupPeriods,
                    playoffMatchupPeriodLength: seasonFormat.playoffMatchupPeriodLength,
                    playoffSeedingRule: seasonFormat.playoffSeedingRule,
                  },
                  throughWeek: Math.max(...winnersBracketGames.map(g => g.matchupPeriod)),
                });
                const ownerFor = (teamId: string) => {
                  const t = seasonTeams.find(st => st.externalId === teamId);
                  return t ? espnManagerName(t) || t.owner || UNKNOWN_MANAGER : UNKNOWN_MANAGER;
                };
                if (derived.champion) {
                  bracketCorrections.set(seasonId, {
                    champion: bracketTeamToStoredChampion(derived.champion, ownerFor(derived.champion.teamId)),
                    runnerUp: derived.runnerUp
                      ? bracketTeamToStoredChampion(derived.runnerUp, ownerFor(derived.runnerUp.teamId))
                      : undefined,
                    regularSeasonChampion: derived.regularSeasonChampion
                      ? bracketTeamToStoredChampion(derived.regularSeasonChampion, ownerFor(derived.regularSeasonChampion.teamId))
                      : undefined,
                  });
                }
              }
            } catch (e) {
              // Best-effort correction only - never block the season-welcome payload over it.
            }
          }

          // 1) Championship game moments (and detect unlikely champions by seed)
          try {
            // Prefer explicit CHAMPIONSHIP flag if present
            const explicitChampionshipGames = await ctx.db
              .query("matchups")
              .withIndex("by_league_season", q => q.eq("leagueId", args.leagueId).eq("seasonId", seasonId))
              .filter(q => q.eq(q.field("playoffTier"), "CHAMPIONSHIP"))
              .collect();

            let championshipGames = explicitChampionshipGames;

            if (!championshipGames || championshipGames.length === 0) {
              // Fallback: last Winners Bracket game(s) of the season
              const playoffGames = await ctx.db
                .query("matchups")
                .withIndex("by_league_season", q => q.eq("leagueId", args.leagueId).eq("seasonId", seasonId))
                .filter(q => q.eq(q.field("playoffTier"), "WINNERS_BRACKET"))
                .collect();

              if (playoffGames && playoffGames.length > 0) {
                const maxPeriod = Math.max(...playoffGames.map(g => g.matchupPeriod));
                championshipGames = playoffGames.filter(g => g.matchupPeriod === maxPeriod);
              }
            }

            if (championshipGames && championshipGames.length > 0) {
              // Usually one game; handle multiple just in case
              for (const game of championshipGames) {
                const margin = Math.abs(game.homeScore - game.awayScore);
                const total = (game.homeScore || 0) + (game.awayScore || 0);
                const closenessPct = total > 0 ? (margin / total) : 1;
                const winnerIsHome = (game.winner === 'home') || (game.homeScore > game.awayScore);
                const winnerTeamId = winnerIsHome ? game.homeTeamId : game.awayTeamId;
                const loserTeamId = winnerIsHome ? game.awayTeamId : game.homeTeamId;

                const winnerTeam = seasonTeams.find(t => t.externalId === winnerTeamId);
                const loserTeam = seasonTeams.find(t => t.externalId === loserTeamId);

                memorableMoments.push({
                  type: 'championship',
                  seasonId,
                  description: closenessPct <= 0.05
                    ? `Championship thriller: ${winnerTeam?.name || winnerTeamId} edged ${loserTeam?.name || loserTeamId} by ${margin.toFixed(1)} points`
                    : `Champion crowned: ${winnerTeam?.name || winnerTeamId} defeated ${loserTeam?.name || loserTeamId} by ${margin.toFixed(1)} points`,
                  details: {
                    winner: winnerTeam?.name || winnerTeamId,
                    winnerOwner: winnerTeam?.owner,
                    loser: loserTeam?.name || loserTeamId,
                    loserOwner: loserTeam?.owner,
                    score: `${game.homeScore.toFixed(1)}-${game.awayScore.toFixed(1)}`,
                    margin,
                  },
                });

                // Unlikely champion: low playoff seed won it all
                const winnerStanding = seasonStandings.find(s => s.externalId === winnerTeamId);
                const seed = winnerStanding?.playoffSeed ?? winnerStanding?.rank;
                if (seed && (seed > Math.ceil(playoffTeamsCount / 2) || seed >= 5)) {
                  memorableMoments.push({
                    type: 'unlikely_champion',
                    seasonId,
                    description: `Unlikely champion: ${winnerTeam?.name || winnerTeamId} won from seed #${seed}`,
                    details: {
                      team: winnerTeam?.name || winnerTeamId,
                      owner: winnerTeam?.owner,
                      seed,
                      playoffTeams: playoffTeamsCount,
                    }
                  });
                }
              }
            }
          } catch (e) {
            // Ignore championship computation errors per season
          }

          // 2) Close, playoff-implication matchups in final regular season week
          try {
            // Determine last regular-season week dynamically if possible (max matchupPeriod among non-playoff games)
            const allSeasonMatchups = await ctx.db
              .query("matchups")
              .withIndex("by_league_season", q => q.eq("leagueId", args.leagueId).eq("seasonId", seasonId))
              .collect();
            const regularSeasonGames = allSeasonMatchups.filter(m => !m.playoffTier);
            const inferredLastRegularWeek = regularSeasonGames.length > 0
              ? Math.max(...regularSeasonGames.map(g => g.matchupPeriod))
              : undefined;
            const configuredLastWeek = season.settings?.regularSeasonMatchupPeriods || league.settings?.regularSeasonMatchupPeriods || 13;
            const lastRegularWeek = inferredLastRegularWeek || configuredLastWeek;

            const finalWeekGames = regularSeasonGames.filter(g => g.matchupPeriod === lastRegularWeek);
            if (finalWeekGames && finalWeekGames.length > 0) {
              const cutoff = playoffTeamsCount;
              const bubbleTeamIds = new Set<string>();
              seasonStandings.forEach(s => {
                if (s.rank === cutoff || s.rank === cutoff + 1 || s.rank === cutoff - 1) {
                  bubbleTeamIds.add(s.externalId);
                }
              });
              for (const g of finalWeekGames) {
                const isBubbleGame = bubbleTeamIds.has(g.homeTeamId) || bubbleTeamIds.has(g.awayTeamId);
                const margin = Math.abs(g.homeScore - g.awayScore);
                const total = (g.homeScore || 0) + (g.awayScore || 0);
                const isNailBiter = total > 0 && (margin / total) <= 0.05 || margin <= 5;
                if (isBubbleGame && isNailBiter) {
                  const home = seasonStandings.find(s => s.externalId === g.homeTeamId);
                  const away = seasonStandings.find(s => s.externalId === g.awayTeamId);
                  memorableMoments.push({
                    type: 'playoff_clincher',
                    seasonId,
                    description: `Playoff-clinching nail-biter in Week ${lastRegularWeek}: ${g.homeScore > g.awayScore ? (home?.name || g.homeTeamId) : (away?.name || g.awayTeamId)} won by ${margin.toFixed(1)} points`,
                    details: {
                      week: lastRegularWeek,
                      homeTeam: home?.name || g.homeTeamId,
                      awayTeam: away?.name || g.awayTeamId,
                      score: `${g.homeScore.toFixed(1)}-${g.awayScore.toFixed(1)}`,
                      margin,
                    }
                  });
                }
              }
            }
          } catch (e) {
            // Ignore per-season errors
          }

          // 2b) Major playoff upsets (non-championship) in Winners Bracket
          try {
            const winnersBracket = await ctx.db
              .query("matchups")
              .withIndex("by_league_season", q => q.eq("leagueId", args.leagueId).eq("seasonId", seasonId))
              .filter(q => q.eq(q.field("playoffTier"), "WINNERS_BRACKET"))
              .collect();
            if (winnersBracket && winnersBracket.length > 0) {
              const maxPeriod = Math.max(...winnersBracket.map(g => g.matchupPeriod));
              const earlierRounds = winnersBracket.filter(g => g.matchupPeriod < maxPeriod);
              for (const g of earlierRounds) {
                if (g.homeProjectedScore && g.awayProjectedScore) {
                  const projectedWinnerIsHome = g.homeProjectedScore >= g.awayProjectedScore;
                  const actualWinnerIsHome = (g.winner === 'home') || (g.homeScore > g.awayScore);
                  const projDiff = Math.abs(g.homeProjectedScore - g.awayProjectedScore);
                  if (projDiff >= 10 && projectedWinnerIsHome !== actualWinnerIsHome) {
                    const home = seasonStandings.find(s => s.externalId === g.homeTeamId);
                    const away = seasonStandings.find(s => s.externalId === g.awayTeamId);
                    const margin = Math.abs(g.homeScore - g.awayScore);
                    memorableMoments.push({
                      type: 'playoff_upset',
                      seasonId,
                      description: `Playoff upset: ${(actualWinnerIsHome ? (home?.name || g.homeTeamId) : (away?.name || g.awayTeamId))} flipped projections by ${projDiff.toFixed(1)} pts and won by ${margin.toFixed(1)}`,
                      details: {
                        week: g.matchupPeriod,
                        homeTeam: home?.name || g.homeTeamId,
                        awayTeam: away?.name || g.awayTeamId,
                        score: `${g.homeScore.toFixed(1)}-${g.awayScore.toFixed(1)}`,
                        projectedHome: g.homeProjectedScore,
                        projectedAway: g.awayProjectedScore,
                        margin,
                      }
                    });
                  }
                }
              }
            }
          } catch (e) {
            // ignore
          }

          // Helper to get season-level actual vs projected totals for a player
          const getSeasonPlayerInfo = async (espnId: string): Promise<{ actual?: number; projected?: number; name?: string; position?: string; } | undefined> => {
            // Prefer league-specific stats if available
            const leagueSpecific = await ctx.db
              .query("playerStats")
              .withIndex("by_league_player", q => q.eq("leagueId", args.leagueId).eq("espnId", espnId).eq("season", seasonId))
              .first();
            const statsSource = leagueSpecific?.stats;
            const readFrom = async (): Promise<any | undefined> => {
              if (Array.isArray(statsSource)) return statsSource;
              const enhanced = await ctx.db
                .query("playersEnhanced")
                .withIndex("by_espn_id_season", q => q.eq("espnId", espnId).eq("season", seasonId))
                .first();
              return enhanced?.stats;
            };
            const enhancedForMeta = await ctx.db
              .query("playersEnhanced")
              .withIndex("by_espn_id_season", q => q.eq("espnId", espnId).eq("season", seasonId))
              .first();
            const stats = await readFrom();
            if (!stats || !Array.isArray(stats)) return { name: enhancedForMeta?.fullName, position: enhancedForMeta?.defaultPosition };
            const seasonActual = stats.find((s: any) => s.statSourceId === 0 && s.scoringPeriodId === 0);
            const seasonProj = stats.find((s: any) => s.statSourceId === 1 && s.scoringPeriodId === 0);
            return {
              actual: seasonActual?.appliedTotal,
              projected: seasonProj?.appliedTotal,
              name: enhancedForMeta?.fullName,
              position: enhancedForMeta?.defaultPosition,
            };
          };

          // 3) Blockbuster trades (many players or high impact)
          try {
            const trades = await ctx.db
              .query("trades")
              .withIndex("by_season", q => q.eq("leagueId", args.leagueId).eq("seasonId", seasonId))
              .order("desc")
              .take(50);
            const rankedTrades: Array<{ trade: any; impactScore: number; totalPlayers: number; summary: string; }> = [];
            for (const tr of trades) {
              const totalPlayers = (tr.playersFromTeamA?.length || 0) + (tr.playersFromTeamB?.length || 0);
              let impactScore = 0;
              const names: string[] = [];
              const all = [...(tr.playersFromTeamA || []), ...(tr.playersFromTeamB || [])];
              for (const p of all) {
                names.push(p.playerName);
                const totals = await getSeasonPlayerInfo(p.playerId);
                if (totals?.actual) impactScore += totals.actual;
              }
              const summary = `${tr.teamA?.teamName} ↔ ${tr.teamB?.teamName}: ${names.slice(0, 6).join(', ')}${names.length > 6 ? ', …' : ''}`;
              rankedTrades.push({ trade: tr, impactScore, totalPlayers, summary });
            }
            rankedTrades
              .sort((a, b) => (b.totalPlayers - a.totalPlayers) || (b.impactScore - a.impactScore))
              .slice(0, 3)
              .forEach(rt => {
                memorableMoments.push({
                  type: 'blockbuster_trade',
                  seasonId,
                  description: `Blockbuster trade: ${rt.summary}`,
                  details: {
                    totalPlayers: rt.totalPlayers,
                    impactScore: Number(rt.impactScore.toFixed(1)),
                    tradeDate: rt.trade.tradeDate,
                  }
                });
              });
          } catch (e) {
            // ignore
          }

          // 4) Great in-season waiver pickups (adds from FA with strong actual >> projected)
          try {
            const txns = await ctx.db
              .query("transactions")
              .withIndex("by_season", q => q.eq("leagueId", args.leagueId).eq("seasonId", seasonId))
              .order("desc")
              .take(200);
            const bestPickups: Array<{ playerId: string; playerName: string; teamId: string; teamName: string; diff: number; actual: number; projected: number; }> = [];
            for (const t of txns) {
              if (!t.items || !Array.isArray(t.items)) continue;
              const addItem = t.items.find((it: any) => it.type === 'ADD' && it.fromTeamId === 0 && it.toTeamId !== 0);
              if (!addItem) continue;
              const playerId = addItem.playerId?.toString();
              if (!playerId) continue;
              const totals = await getSeasonPlayerInfo(playerId);
              if (!totals?.actual || !totals?.projected) continue;
              const diff = totals.actual - totals.projected;
              // Only consider meaningful overperformance with solid total
              if (diff >= 60 && totals.actual >= 150) {
                const acquiringTeam = seasonTeams.find(tm => tm.externalId === addItem.toTeamId.toString());
                bestPickups.push({
                  playerId,
                  playerName: totals.name || `Player ${playerId}`,
                  teamId: addItem.toTeamId.toString(),
                  teamName: acquiringTeam?.name || `Team ${addItem.toTeamId}`,
                  diff,
                  actual: totals.actual,
                  projected: totals.projected,
                });
              }
            }
            bestPickups
              .sort((a, b) => (b.diff - a.diff))
              .slice(0, 5)
              .forEach(pu => {
                memorableMoments.push({
                  type: 'waiver_pickup',
                  seasonId,
                  description: `Waiver gem: ${pu.playerName} added by ${pu.teamName} beat projections by ${pu.diff.toFixed(1)} pts (${pu.actual.toFixed(1)} vs ${pu.projected.toFixed(1)})`,
                  details: {
                    team: pu.teamName,
                    actual: Number(pu.actual.toFixed(1)),
                    projected: Number(pu.projected.toFixed(1)),
                  }
                });
              });
          } catch (e) {
            // ignore
          }

        } catch (e) {
          // Continue with other seasons
        }
      }

      // Apply the bracket corrections collected in the loop's "0)" step - `leagueSeasons.champion`
      // can be a stale sync artifact; the bracket cannot (spec: prod's 2025 corruption).
      if (bracketCorrections.size > 0) {
        for (let i = 0; i < championshipHistory.length; i++) {
          const correction = bracketCorrections.get(championshipHistory[i].year);
          if (!correction) continue;
          championshipHistory[i] = {
            ...championshipHistory[i],
            champion: correction.champion ?? championshipHistory[i].champion,
            runnerUp: correction.runnerUp ?? championshipHistory[i].runnerUp,
            regularSeasonChampion: correction.regularSeasonChampion ?? championshipHistory[i].regularSeasonChampion,
          };
        }
        // Recompute the championship-count leaderboard off the corrected history.
        const correctedCounts: Record<string, number> = {};
        championshipHistory.forEach(season => {
          if (season.champion?.owner) {
            correctedCounts[season.champion.owner] = (correctedCounts[season.champion.owner] || 0) + 1;
          }
        });
        const correctedMost = Object.entries(correctedCounts).sort(([, a], [, b]) => b - a).slice(0, 1);
        if (correctedMost.length > 0) {
          allTimeRecords.mostChampionships = { manager: correctedMost[0][0], count: correctedMost[0][1] };
        }
      }

      // The League Almanac (owner ask, 2026-09-06): the deterministic, all-seasons history block
      // this piece is actually written from - see src/lib/ai/almanac.ts's header for why the
      // memorable-moments/championshipHistory data above (kept for now, unused by the almanac
      // path) was not enough. Never allowed to fail the whole payload: a gatherer or builder
      // error degrades to an empty almanac, exactly like a league with no completed seasons.
      let almanac;
      try {
        const almanacInput = await gatherAlmanacInput(ctx, args.leagueId, currentSeason);
        almanac = buildAlmanac(almanacInput);
      } catch (e) {
        console.error("Failed to build the League Almanac for season_welcome", e);
      }

      // Season kickoff facts (owner ask, 2026-09-06): where THIS season's draft and kickoff
      // stand, for the writer and for Sam's preseason interviews (src/lib/ai/conversation-service.ts).
      const currentLeagueSeason = leagueSeasons.find((s) => s.seasonId === currentSeason);
      const draftInfo = currentLeagueSeason?.draftInfo as
        | { drafted?: boolean; inProgress?: boolean; draftDate?: number }
        | undefined;
      const week1Games = await ctx.db
        .query("nflSchedules")
        .withIndex("by_week", (q) => q.eq("season", currentSeason).eq("week", 1))
        .collect();
      const weekOneKickoffAt = week1Games.length > 0 ? Math.min(...week1Games.map((g) => g.gameTime)) : undefined;
      const seasonKickoff = {
        draftDone: draftInfo?.drafted === true,
        draftDate: typeof draftInfo?.draftDate === "number" ? draftInfo.draftDate : undefined,
        weekOneKickoffAt,
      };

      const result: any = {
        // Basic league info
        leagueName: league.name,
        currentWeek: basicLeagueData.currentWeek,
        currentSeason,
        // League Almanac + kickoff facts (owner ask, 2026-09-06). `almanac` mirrors
        // `LeagueDataContext.almanac` in src/lib/ai/prompt-builder.ts; `seasonKickoff` is new and
        // additive - the prompt layer picks it up on its own schedule.
        almanac,
        seasonKickoff,
        teams: currentTeams.map(team => ({
          id: team._id,
          externalId: team.externalId,
          name: team.name,
          manager: team.owner,
          record: team.record,
          pointsFor: team.record.pointsFor || 0,
          pointsAgainst: team.record.pointsAgainst || 0,
          roster: team.roster?.map((player: any) => ({
            playerId: player.playerId,
            playerName: player.playerName,
            position: player.position,
            team: player.team,
            fullName: player.playerName,
            acquisitionType: player.acquisitionType || "DRAFT",
          })) || [],
        })),
        
        // Historical data - CRITICAL for season welcome
        previousSeasons,
        
        // League history
        leagueHistory: {
          foundedYear: Math.min(...leagueSeasons.map(s => s.seasonId).filter(Boolean)),
          totalSeasons: leagueSeasons.length,
          seasons: championshipHistory,
          allTimeRecords,
        },
        
        // Additional context from basic query
        standings: basicLeagueData.standings,
        rivalries: basicLeagueData.rivalries,
        managerActivity: basicLeagueData.managerActivity,
        
        // Required fields for content generation
        recentMatchups: [], // Not needed for season welcome
        trades: [], // Not needed for season welcome
        transactions: [], // Not needed for season welcome
        
        // Settings
        scoringType: league.settings?.scoringType || "PPR",
        rosterSize: league.settings?.rosterSize || 16,
        
        metadata: {
          dataFreshness: Date.now(),
          previousSeasonsCount: Object.keys(previousSeasons).length,
          totalSeasons: leagueSeasons.length,
        },
        // New: compiled memorable moments for season welcome prompts
        memorableMoments,
      };
      
      const executionTime = Date.now() - startTime;
      console.log("=== getSeasonWelcomeDataForAI SUCCESS ===");
      console.log("Execution time:", executionTime + "ms");
      console.log("Previous seasons fetched:", Object.keys(previousSeasons).length);
      console.log("Championship history entries:", championshipHistory.length);
      
      return result;
      
    } catch (error) {
      const executionTime = Date.now() - startTime;
      console.error("=== getSeasonWelcomeDataForAI ERROR ===");
      console.error("Execution time before error:", executionTime + "ms");
      console.error("Error:", error);
      throw error;
    }
  },
});

/* -------------------------------------------------------------------------- *
 * League Almanac (owner ask, 2026-09-06) - read-only introspection.
 *
 * Mirrors `LeagueAlmanac` (src/lib/ai/almanac.ts) field-for-field so the CLI can inspect exactly
 * what the kickoff piece was written from. Not dev-guarded: the owner runs this against prod
 * directly, e.g. `npx convex run --prod aiQueries:getLeagueAlmanac '{"leagueId":"..."}'`.
 * -------------------------------------------------------------------------- */

const almanacTeamRefValidator = v.object({
  teamId: v.string(),
  team: v.string(),
  managerKey: v.string(),
  manager: v.string(),
  record: v.optional(v.string()),
  pointsFor: v.optional(v.number()),
  seed: v.optional(v.number()),
});

const almanacSeasonLineValidator = v.object({
  season: v.number(),
  team: v.string(),
  record: v.string(),
  pointsFor: v.number(),
  finish: v.number(),
  madePlayoffs: v.boolean(),
  champion: v.boolean(),
  runnerUp: v.boolean(),
});

const almanacGameValidator = v.object({
  season: v.number(),
  week: v.number(),
  playoffTier: v.optional(v.string()),
  winner: v.object({ team: v.string(), manager: v.string(), score: v.number() }),
  loser: v.object({ team: v.string(), manager: v.string(), score: v.number() }),
  margin: v.number(),
});

const almanacScoreEntryValidator = v.object({
  season: v.number(),
  week: v.number(),
  team: v.string(),
  manager: v.string(),
  score: v.number(),
});

const almanacDraftReceiptPickValidator = v.object({
  pick: v.number(),
  round: v.number(),
  teamId: v.string(),
  team: v.string(),
  manager: v.string(),
  player: v.string(),
  pos: v.optional(v.string()),
  seasonPoints: v.optional(v.number()),
  firstRoundRank: v.optional(v.number()),
  teamFinish: v.optional(
    v.object({ record: v.string(), madePlayoffs: v.boolean(), champion: v.boolean() })
  ),
});

const almanacCurseEntryValidator = v.object({
  manager: v.string(),
  currentTeamId: v.optional(v.string()),
  seasons: v.number(),
  playoffAppearances: v.number(),
  runnerUps: v.number(),
});

const almanacSeasonLineWithManagerValidator = almanacSeasonLineValidator.extend({
  manager: v.string(),
});

const almanacValidator = v.object({
  schema: v.literal("ffsn.almanac.v1"),
  currentSeason: v.number(),
  foundedSeason: v.optional(v.number()),
  seasonsCovered: v.array(v.number()),
  seasons: v.array(
    v.object({
      season: v.number(),
      teamCount: v.number(),
      champion: v.optional(almanacTeamRefValidator),
      runnerUp: v.optional(almanacTeamRefValidator),
      regularSeasonChampion: v.optional(almanacTeamRefValidator),
      lastPlace: v.optional(almanacTeamRefValidator),
      topScorer: v.optional(almanacTeamRefValidator),
      final: v.optional(
        v.object({
          winner: almanacTeamRefValidator,
          loser: almanacTeamRefValidator,
          winnerScore: v.number(),
          loserScore: v.number(),
          margin: v.number(),
          week: v.number(),
        })
      ),
      unlikelyChampion: v.optional(v.object({ reason: v.string() })),
    })
  ),
  managers: v.array(
    v.object({
      key: v.string(),
      manager: v.string(),
      currentTeamId: v.optional(v.string()),
      currentTeam: v.optional(v.string()),
      seasons: v.number(),
      firstSeason: v.number(),
      lastSeason: v.number(),
      wins: v.number(),
      losses: v.number(),
      ties: v.number(),
      record: v.string(),
      winPct: v.number(),
      pointsFor: v.number(),
      pointsAgainst: v.optional(v.number()),
      pointsPerGame: v.number(),
      titles: v.array(v.number()),
      runnerUps: v.array(v.number()),
      regularSeasonTitles: v.array(v.number()),
      playoffAppearances: v.number(),
      playoffStreak: v.number(),
      lastPlaceFinishes: v.array(v.number()),
      bestSeason: v.optional(almanacSeasonLineValidator),
      worstSeason: v.optional(almanacSeasonLineValidator),
      yearsSinceTitle: v.optional(v.number()),
      teamNames: v.array(v.string()),
      lines: v.array(almanacSeasonLineValidator),
    })
  ),
  curseBoard: v.object({
    mostPointsNoTitle: v.optional(
      v.object({
        manager: v.string(),
        currentTeamId: v.optional(v.string()),
        pointsFor: v.number(),
        seasons: v.number(),
        playoffAppearances: v.number(),
      })
    ),
    longestDrought: v.optional(
      v.object({
        manager: v.string(),
        currentTeamId: v.optional(v.string()),
        yearsSinceTitle: v.number(),
        lastTitle: v.number(),
      })
    ),
    neverWon: v.array(almanacCurseEntryValidator),
    alwaysTheBridesmaid: v.optional(
      v.object({ manager: v.string(), currentTeamId: v.optional(v.string()), runnerUps: v.number() })
    ),
    neverMadePlayoffs: v.array(
      v.object({ manager: v.string(), currentTeamId: v.optional(v.string()), seasons: v.number() })
    ),
    mostLastPlaces: v.optional(
      v.object({
        manager: v.string(),
        currentTeamId: v.optional(v.string()),
        count: v.number(),
        seasons: v.array(v.number()),
      })
    ),
  }),
  records: v.object({
    biggestBlowout: v.optional(almanacGameValidator),
    closestGame: v.optional(almanacGameValidator),
    highestScore: v.optional(almanacScoreEntryValidator),
    lowestScore: v.optional(almanacScoreEntryValidator),
    bestRegularSeason: v.optional(almanacSeasonLineWithManagerValidator),
    worstRegularSeason: v.optional(almanacSeasonLineWithManagerValidator),
    mostPointsInASeason: v.optional(almanacSeasonLineWithManagerValidator),
    mostTitles: v.optional(v.object({ manager: v.string(), count: v.number(), seasons: v.array(v.number()) })),
    backToBack: v.array(v.object({ manager: v.string(), seasons: v.array(v.number()) })),
  }),
  rivalries: v.array(
    v.object({
      a: v.object({ managerKey: v.string(), manager: v.string(), currentTeamId: v.optional(v.string()) }),
      b: v.object({ managerKey: v.string(), manager: v.string(), currentTeamId: v.optional(v.string()) }),
      games: v.number(),
      aWins: v.number(),
      bWins: v.number(),
      ties: v.number(),
      lastMeeting: v.optional(
        v.object({ season: v.number(), week: v.number(), winnerManager: v.string(), margin: v.number() })
      ),
      currentStreak: v.optional(v.object({ manager: v.string(), wins: v.number() })),
    })
  ),
  drafts: v.array(
    v.object({
      season: v.number(),
      firstRound: v.array(almanacDraftReceiptPickValidator),
      titlePick: v.optional(almanacDraftReceiptPickValidator),
      best: v.optional(almanacDraftReceiptPickValidator),
      worst: v.optional(almanacDraftReceiptPickValidator),
    })
  ),
  notes: v.array(v.string()),
});

export const getLeagueAlmanac = internalQuery({
  args: {
    leagueId: v.id("leagues"),
    seasonId: v.optional(v.number()),
  },
  returns: almanacValidator,
  handler: async (ctx, args) => {
    const league = await ctx.db.get(args.leagueId);
    if (!league) throw new Error("League not found");
    const currentSeason = args.seasonId ?? league.espnData?.seasonId ?? new Date().getFullYear();
    const input = await gatherAlmanacInput(ctx, args.leagueId, currentSeason);
    return buildAlmanac(input);
  },
});

// Get waiver wire data for AI content generation
export const getWaiverWireDataForAI = internalQuery({
  args: {
    leagueId: v.id("leagues"),
  },
  async handler(ctx, args) {
    console.log("=== getWaiverWireDataForAI START ===");
    const startTime = Date.now();
    
    try {
      const league = await ctx.db.get(args.leagueId);
      if (!league) throw new Error("League not found");
      
      const currentSeason = league.espnData?.seasonId || new Date().getFullYear();
      const currentWeek = league.espnData?.currentScoringPeriod || 1;

      // The FAAB/waiver ledger (owner goal: winning bids, losing bids, remaining budgets, season
      // highlights). Built independently of the rest of this query's data.
      const waiverLedger = await buildWaiverLedger(ctx, league, currentSeason, {
        throughScoringPeriod: currentWeek,
      });

      // Get basic league data
      const basicLeagueData: any = await ctx.runQuery(internal.aiQueries.getLeagueDataForAI, {
        leagueId: args.leagueId,
      });

      // Get all rostered players to determine available players
      const allRosteredPlayerIds = new Set<string>();
      basicLeagueData.teams.forEach((team: any) => {
        if (team.roster) {
          team.roster.forEach((player: any) => {
            allRosteredPlayerIds.add(player.playerId);
          });
        }
      });

      // Get recent transactions to identify trending players
      const recentTransactions = await ctx.db
        .query("transactions")
        .withIndex("by_season", q => q.eq("leagueId", args.leagueId).eq("seasonId", currentSeason))
        .order("desc")
        .take(100);

      // Real names/positions for every ADD or DROP item across these transactions — resolved once
      // here instead of the "Player 12345" / "Unknown" placeholders this query used to print.
      const transactionPlayerIds = new Set<number>();
      recentTransactions.forEach(transaction => {
        transaction.items?.forEach(item => {
          if (item.type === "ADD" || item.type === "DROP") transactionPlayerIds.add(item.playerId);
        });
      });
      const transactionPlayers = await waiverPlayerLookup(ctx, currentSeason, transactionPlayerIds);

      // Track transaction trends
      const transactionCounts: Record<string, number> = {};
      const recentAdds: Array<{
        playerId: string;
        playerName: string;
        position: string;
        date: string;
        teamName: string;
        bid?: number;
        outcome: TransactionOutcome;
      }> = [];

      recentTransactions.forEach(transaction => {
        // Process transactions based on the new schema with items array
        if (transaction.items && transaction.items.length > 0) {
          for (const item of transaction.items) {
            if (item.type === "ADD" && item.toTeamId !== 0) {
              const playerId = item.playerId.toString();
              transactionCounts[playerId] = (transactionCounts[playerId] || 0) + 1;

              // Get team info from teams data
              const team = basicLeagueData.teams.find((t: any) => t.externalId === item.toTeamId.toString());
              const resolved = transactionPlayers.get(item.playerId);

              recentAdds.push({
                playerId: playerId,
                playerName: resolved?.name ?? `Player ${playerId}`,
                position: resolved?.pos ?? "Unknown",
                date: new Date(transaction.proposedDate).toISOString(),
                teamName: team?.name || `Team ${item.toTeamId}`,
                bid: transaction.bidAmount > 0 ? transaction.bidAmount : undefined,
                outcome: transactionOutcome(transaction),
              });
            }
          }
        }
      });
      
      // Get enhanced player data for available players
      const allPlayersEnhanced = await ctx.db
        .query("playersEnhanced")
        .withIndex("by_season", q => q.eq("season", currentSeason))
        .filter(q => q.gte(q.field("ownership.percentOwned"), 0))
        .take(500); // Get more players to find available ones
      
      // Filter to get available players
      const availablePlayers = allPlayersEnhanced
        .filter(player => {
          // Player is available if not rostered in this league AND ownership < 60%
          const isRostered = allRosteredPlayerIds.has(player.espnId);
          const ownership = player.ownership?.percentOwned || 0;
          return !isRostered && ownership < 60;
        })
        .map(player => ({
          playerId: player.espnId,
          playerName: player.fullName,
          position: player.defaultPositionId,
          proTeam: player.proTeamAbbrev,
          // Waiver targets are free agents: NFL team only, no fantasy team.
          nflTeam: player.proTeamAbbrev || undefined,
          ownership: {
            percentOwned: player.ownership?.percentOwned || 0,
            percentChange: player.ownership?.percentChange || 0,
            percentStarted: player.ownership?.percentStarted || 0,
            averageDraftPosition: player.ownership?.averageDraftPosition,
          },
          injured: player.injured || false,
          injuryStatus: player.injuryStatus,
          seasonOutlook: player.seasonOutlook,
          recentStats: player.stats?.appliedStats ? {
            avgPoints: player.stats.appliedAverage || 0,
            trend: (player.ownership?.percentChange || 0) > 0 ? "rising" : "stable",
          } : undefined,
          projectedStats: player.stats?.appliedStats ? {
            projectedTotal: player.stats.appliedTotal || 0,
            projectedAverage: player.stats.appliedAverage || 0,
          } : undefined,
          transactionCount: transactionCounts[player.espnId] || 0,
        }))
        .sort((a, b) => {
          // Sort by trending (ownership change + transaction count)
          const trendA = (a.ownership.percentChange || 0) + (a.transactionCount * 2);
          const trendB = (b.ownership.percentChange || 0) + (b.transactionCount * 2);
          return trendB - trendA;
        });
      
      const result: any = {
        // Basic league info
        leagueName: league.name,
        currentWeek,
        currentSeason,
        teams: basicLeagueData.teams,
        
        // Waiver wire specific data
        availablePlayers: availablePlayers.slice(0, 100), // Top 100 available players
        
        // Recent transaction activity
        recentAdds: recentAdds.slice(0, 20),
        transactionTrends: basicLeagueData.transactionTrends,
        
        // Team needs analysis data
        standings: basicLeagueData.standings,
        injuryReport: basicLeagueData.teams.flatMap((team: any) => 
          team.roster?.filter((p: any) => p.injuryStatus && p.injuryStatus !== "ACTIVE")
            .map((p: any) => ({
              playerId: p.playerId,
              playerName: p.playerName,
              // Legacy key, unchanged: here it has always been the fantasy team
              // name. Read `nflTeam` / `fantasyTeamName` instead.
              team: team.name,
              nflTeam: p.nflTeam,
              fantasyTeamId: String(team.externalId),
              fantasyTeamName: team.name,
              position: p.position,
              status: p.injuryStatus || "QUESTIONABLE",
              fantasyTeam: team.name,
            })) || []
        ).slice(0, 20),
        
        // Required fields for content generation
        recentMatchups: basicLeagueData.recentMatchups.slice(0, 5),
        trades: [],
        transactions: recentTransactions.slice(0, 20).map(t => {
          // Extract player add/drop info from items array
          const addItem = t.items?.find((item: any) => item.type === "ADD");
          const dropItem = t.items?.find((item: any) => item.type === "DROP");
          const team = basicLeagueData.teams.find((team: any) => team.externalId === t.teamId);
          const addedPlayer = addItem ? transactionPlayers.get(addItem.playerId) : undefined;
          const droppedPlayer = dropItem ? transactionPlayers.get(dropItem.playerId) : undefined;

          return {
            teamId: t.teamId,
            teamName: team?.name || `Team ${t.teamId}`,
            type: t.type,
            playerAdded: addItem ? {
              playerId: addItem.playerId.toString(),
              playerName: addedPlayer?.name ?? `Player ${addItem.playerId}`,
              position: addedPlayer?.pos ?? "Unknown",
              team: addedPlayer?.nflTeam ?? "Unknown"
            } : undefined,
            playerDropped: dropItem ? {
              playerId: dropItem.playerId.toString(),
              playerName: droppedPlayer?.name ?? `Player ${dropItem.playerId}`,
              position: droppedPlayer?.pos ?? "Unknown",
              team: droppedPlayer?.nflTeam ?? "Unknown"
            } : undefined,
            date: new Date(t.proposedDate).toISOString(),
            faabBid: t.bidAmount > 0 ? t.bidAmount : undefined,
          };
        }),
        rivalries: [],
        managerActivity: basicLeagueData.managerActivity,

        // The FAAB/waiver ledger (owner goal: waiver wire reports must take FAAB spend into
        // account) — winning bids, losing bids, remaining budgets, season highlights.
        waivers: waiverLedger,

        // Settings
        scoringType: league.settings?.scoringType || "PPR",
        rosterSize: league.settings?.rosterSize || 16,
        // League-format facts (spec: format audit) — waiver type/FAAB and roster shape reach the
        // waiver_wire_report prompt through this, carried through from `getLeagueDataForAI`.
        leagueFormat: basicLeagueData.leagueFormat,
        playoffTeams: basicLeagueData.leagueFormat?.playoffTeamCount ?? basicLeagueData.metadata?.playoffTeams,
        regularSeasonWeeks: basicLeagueData.leagueFormat?.regularSeasonMatchupPeriods,

        metadata: {
          dataFreshness: Date.now(),
          availablePlayersCount: availablePlayers.length,
          trendingPlayersCount: availablePlayers.filter(p => p.ownership.percentChange > 5).length,
        },
      };

      const executionTime = Date.now() - startTime;
      console.log("=== getWaiverWireDataForAI SUCCESS ===");
      console.log("Execution time:", executionTime + "ms");
      console.log("Available players found:", availablePlayers.length);
      console.log("Recent transactions:", recentTransactions.length);
      
      return result;
      
    } catch (error) {
      const executionTime = Date.now() - startTime;
      console.error("=== getWaiverWireDataForAI ERROR ===");
      console.error("Execution time before error:", executionTime + "ms");
      console.error("Error:", error);
      throw error;
    }
  },
});

// Get trade analysis data for AI content generation
export const getTradeAnalysisDataForAI = internalQuery({
  args: {
    leagueId: v.id("leagues"),
    tradeId: v.optional(v.id("trades")),
  },
  async handler(ctx, args) {
    console.log("=== getTradeAnalysisDataForAI START ===");
    const startTime = Date.now();
    
    try {
      const league = await ctx.db.get(args.leagueId);
      if (!league) throw new Error("League not found");
      
      const currentSeason = league.espnData?.seasonId || new Date().getFullYear();
      const currentWeek = league.espnData?.currentScoringPeriod || 1;
      
      // Get basic league data
      const basicLeagueData: any = await ctx.runQuery(internal.aiQueries.getLeagueDataForAI, {
        leagueId: args.leagueId,
      });
      
      // Get specific trade or latest trade
      let targetTrade;
      if (args.tradeId) {
        targetTrade = await ctx.db.get(args.tradeId);
      } else {
        // Get the most recent trade
        const recentTrades = await ctx.db
          .query("trades")
          .withIndex("by_season", q => q.eq("leagueId", args.leagueId).eq("seasonId", currentSeason))
          .order("desc")
          .take(1);
        targetTrade = recentTrades[0];
      }
      
      if (!targetTrade) {
        throw new Error("No trades found for analysis");
      }
      
      // Get detailed team data for both teams in the trade
      const teamAData = basicLeagueData.teams.find((t: any) => 
        t.externalId === targetTrade.teamA.teamId || t.name === targetTrade.teamA.teamName
      );
      const teamBData = basicLeagueData.teams.find((t: any) => 
        t.externalId === targetTrade.teamB.teamId || t.name === targetTrade.teamB.teamName
      );
      
      // Get enhanced player data for traded players
      const allTradedPlayerIds = [
        ...targetTrade.playersFromTeamA.map((p: any) => p.playerId),
        ...targetTrade.playersFromTeamB.map((p: any) => p.playerId),
      ];
      
      const tradedPlayersEnhanced = await ctx.db
        .query("playersEnhanced")
        .withIndex("by_season", q => q.eq("season", currentSeason))
        .filter(q => q.or(...allTradedPlayerIds.map(id => q.eq(q.field("espnId"), id))))
        .collect();
      
      // Map enhanced data to traded players
      const enhancedPlayersFromA = targetTrade.playersFromTeamA.map((player: any) => {
        const enhanced = tradedPlayersEnhanced.find(p => p.espnId === player.playerId);
        return {
          ...player,
          // Explicit ids (spec section 4.3). Fantasy ownership is stated
          // post-trade: what team A gave up now sits on team B.
          nflTeam: enhanced?.proTeamAbbrev || player.team || undefined,
          fantasyTeamId: String(teamBData?.externalId ?? targetTrade.teamB.teamId),
          fantasyTeamName: teamBData?.name ?? targetTrade.teamB.teamName,
          seasonStats: enhanced?.stats ? {
            totalPoints: enhanced.stats.appliedTotal || 0,
            averagePoints: enhanced.stats.appliedAverage || 0,
            gamesPlayed: enhanced.stats.appliedStats ? Object.keys(enhanced.stats.appliedStats).length : 0,
          } : undefined,
          seasonOutlook: enhanced?.seasonOutlook,
          injuryStatus: enhanced?.injuryStatus,
          ownership: enhanced?.ownership,
          recentTrend: enhanced?.ownership?.percentChange ? 
            (enhanced.ownership.percentChange > 0 ? "rising" : "falling") : "stable",
        };
      });
      
      const enhancedPlayersFromB = targetTrade.playersFromTeamB.map((player: any) => {
        const enhanced = tradedPlayersEnhanced.find(p => p.espnId === player.playerId);
        return {
          ...player,
          // Explicit ids (spec section 4.3). Fantasy ownership is stated
          // post-trade: what team B gave up now sits on team A.
          nflTeam: enhanced?.proTeamAbbrev || player.team || undefined,
          fantasyTeamId: String(teamAData?.externalId ?? targetTrade.teamA.teamId),
          fantasyTeamName: teamAData?.name ?? targetTrade.teamA.teamName,
          seasonStats: enhanced?.stats ? {
            totalPoints: enhanced.stats.appliedTotal || 0,
            averagePoints: enhanced.stats.appliedAverage || 0,
            gamesPlayed: enhanced.stats.appliedStats ? Object.keys(enhanced.stats.appliedStats).length : 0,
          } : undefined,
          seasonOutlook: enhanced?.seasonOutlook,
          injuryStatus: enhanced?.injuryStatus,
          ownership: enhanced?.ownership,
          recentTrend: enhanced?.ownership?.percentChange ? 
            (enhanced.ownership.percentChange > 0 ? "rising" : "falling") : "stable",
        };
      });
      
      // Calculate position depth for both teams
      const calculatePositionDepth = (roster: any[]) => {
        const depth: Record<string, number> = {};
        roster?.forEach(player => {
          const pos = player.position.replace(/[0-9]/g, '');
          depth[pos] = (depth[pos] || 0) + 1;
        });
        return depth;
      };
      
      const teamADepthBefore = calculatePositionDepth(teamAData?.roster || []);
      const teamBDepthBefore = calculatePositionDepth(teamBData?.roster || []);
      
      // Calculate depth after trade
      const teamADepthAfter = { ...teamADepthBefore };
      const teamBDepthAfter = { ...teamBDepthBefore };
      
      enhancedPlayersFromA.forEach(player => {
        const pos = player.position.replace(/[0-9]/g, '');
        teamADepthAfter[pos] = Math.max(0, (teamADepthAfter[pos] || 0) - 1);
        teamBDepthAfter[pos] = (teamBDepthAfter[pos] || 0) + 1;
      });
      
      enhancedPlayersFromB.forEach(player => {
        const pos = player.position.replace(/[0-9]/g, '');
        teamBDepthAfter[pos] = Math.max(0, (teamBDepthAfter[pos] || 0) - 1);
        teamADepthAfter[pos] = (teamADepthAfter[pos] || 0) + 1;
      });
      
      // Get recent performance for both teams
      const teamARecentMatchups = basicLeagueData.recentMatchups.filter((m: any) => 
        m.teamAName === targetTrade.teamA.teamName || m.teamBName === targetTrade.teamA.teamName
      ).slice(0, 3);
      
      const teamBRecentMatchups = basicLeagueData.recentMatchups.filter((m: any) => 
        m.teamAName === targetTrade.teamB.teamName || m.teamBName === targetTrade.teamB.teamName
      ).slice(0, 3);
      
      const result: any = {
        // Basic league info
        leagueName: league.name,
        currentWeek,
        currentSeason,
        teams: basicLeagueData.teams,
        
        // Trade specific data
        trades: [{
          ...targetTrade,
          teamAData: {
            team: teamAData,
            depthBefore: teamADepthBefore,
            depthAfter: teamADepthAfter,
            recentMatchups: teamARecentMatchups,
            playoffPosition: basicLeagueData.standings.find((s: any) => s.teamId === targetTrade.teamA.teamId)?.playoffSeed,
          },
          teamBData: {
            team: teamBData,
            depthBefore: teamBDepthBefore,
            depthAfter: teamBDepthAfter,
            recentMatchups: teamBRecentMatchups,
            playoffPosition: basicLeagueData.standings.find((s: any) => s.teamId === targetTrade.teamB.teamId)?.playoffSeed,
          },
          enhancedPlayersFromA,
          enhancedPlayersFromB,
        }],
        
        // Context data
        standings: basicLeagueData.standings,
        playoffProbabilities: basicLeagueData.playoffProbabilities,
        
        // Required fields for content generation
        recentMatchups: basicLeagueData.recentMatchups.slice(0, 10),
        transactions: basicLeagueData.transactions.slice(0, 10),
        rivalries: basicLeagueData.rivalries,
        managerActivity: basicLeagueData.managerActivity,
        
        // Settings
        scoringType: league.settings?.scoringType || "PPR",
        rosterSize: league.settings?.rosterSize || 16,
        playoffTeams: basicLeagueData.leagueFormat?.playoffTeamCount ?? league.settings?.playoffTeamCount ?? 6,
        regularSeasonWeeks: basicLeagueData.leagueFormat?.regularSeasonMatchupPeriods,
        // League-format facts (spec: format audit) — the trade deadline reaches the
        // trade_analysis/trade_block prompts through this.
        leagueFormat: basicLeagueData.leagueFormat,

        metadata: {
          dataFreshness: Date.now(),
          tradeDate: targetTrade.tradeDate,
          daysAgo: Math.floor((Date.now() - targetTrade.tradeDate) / (1000 * 60 * 60 * 24)),
        },
      };
      
      const executionTime = Date.now() - startTime;
      console.log("=== getTradeAnalysisDataForAI SUCCESS ===");
      console.log("Execution time:", executionTime + "ms");
      console.log("Trade analyzed:", targetTrade._id);
      
      return result;
      
    } catch (error) {
      const executionTime = Date.now() - startTime;
      console.error("=== getTradeAnalysisDataForAI ERROR ===");
      console.error("Execution time before error:", executionTime + "ms");
      console.error("Error:", error);
      throw error;
    }
  },
});

// Get data for a specific week's recap - with roster data
export const getWeeklyRecapDataForAI = internalQuery({
  args: {
    leagueId: v.id("leagues"),
    seasonId: v.number(),
    week: v.number(),
  },
  handler: async (ctx, args): Promise<{
    leagueName: string;
    currentWeek: number;
    currentSeason: number;
    teams: any;
    recentMatchups: any[];
    standingsAtWeek: any[];
    rivalries: any;
    playoffProbabilities: any;
    trades: any[];
    transactions: any[];
    managerActivity: any;
    standings: any[];
    scoringType: string;
    rosterSize: number;
    // League-format facts (spec: format audit) — carried through so standings mentions in the
    // weekly-recap prompt can name a division.
    leagueFormat?: LeagueFormat;
    playoffTeams?: number;
    regularSeasonWeeks?: number;
    // The FAAB/waiver ledger (owner goal: recaps can cite the week's waiver drama — keep it light).
    waivers?: WaiverLedger;
    // Round-one byes this week, and the playoff picture/bracket through this week (spec: playoffs
    // round - the championship recap names the champion straight from the bracket).
    byes: Array<{ teamId: string; teamName: string; seed: number }>;
    playoffs: PlayoffContext;
    metadata: {
      dataFreshness: number;
      week: number;
      seasonId: number;
    };
  }> => {
    console.log("=== getWeeklyRecapDataForAI START ===");
    const startTime = Date.now();

    try {
      const league = await ctx.db.get(args.leagueId);
      if (!league) throw new Error("League not found");

      const waiverLedger = await buildWaiverLedger(ctx, league, args.seasonId, {
        throughScoringPeriod: args.week,
      });

      // Get basic league data
      const basicLeagueData = await ctx.runQuery(internal.aiQueries.getLeagueDataForAI, {
        leagueId: args.leagueId,
        currentWeek: args.week,
      });
      
      // Get matchups for the specific week with full roster data. A round-one bye
      // (`isByeMatchup`) is a real row but not a game - split out separately (`weekByes`) rather
      // than left in `weekMatchups`, where it used to get "enriched" as a game with a missing
      // opponent (see convex/lib/playoffs.ts's header comment for the finding this fixes).
      const weekMatchupsRaw = await ctx.db
        .query("matchups")
        .withIndex("by_league_season", q =>
          q.eq("leagueId", args.leagueId).eq("seasonId", args.seasonId)
        )
        .filter(q => q.eq(q.field("matchupPeriod"), args.week))
        .collect();
      const weekMatchups = weekMatchupsRaw.filter(m => !isByeMatchup(m));
      const weekByeRows = weekMatchupsRaw.filter(isByeMatchup);

      // Get teams for this season
      const teams = await ctx.db
        .query("teams")
        .withIndex("by_season", q =>
          q.eq("leagueId", args.leagueId).eq("seasonId", args.seasonId)
        )
        .collect();

      // Create a map of teamId to team data
      const teamMap = new Map(teams.map(team => [team.externalId, team]));

      // All of this season's matchups (byes included - `buildPlayoffContext` recognises them
      // itself) through this week, for both the bracket below and `standingsAtWeek` further down -
      // one fetch instead of two, since `buildPlayoffContext` only reads rows `<= throughWeek`
      // anyway.
      const seasonMatchupsThroughWeek = await ctx.db
        .query("matchups")
        .withIndex("by_league_season", q => q.eq("leagueId", args.leagueId).eq("seasonId", args.seasonId))
        .filter(q => q.lte(q.field("matchupPeriod"), args.week))
        .collect();

      // Playoff picture / bracket for this exact week (spec: playoffs round - the championship
      // recap must be able to name the champion straight from the bracket, never from
      // `leagueSeasons.champion`, which a rolled-over sync can corrupt).
      const playoffs: PlayoffContext = buildPlayoffContext({
        teams: teams.map(team => ({
          externalId: team.externalId,
          name: team.name,
          record: {
            wins: team.record.wins,
            losses: team.record.losses,
            ties: team.record.ties,
            pointsFor: team.record.pointsFor,
            playoffSeed: team.record.playoffSeed,
          },
        })),
        matchups: seasonMatchupsThroughWeek.map(m => ({
          matchupPeriod: m.matchupPeriod,
          homeTeamId: m.homeTeamId,
          awayTeamId: m.awayTeamId,
          homeScore: m.homeScore,
          awayScore: m.awayScore,
          winner: m.winner,
          playoffTier: m.playoffTier,
        })),
        format: {
          playoffTeamCount: basicLeagueData.leagueFormat?.playoffTeamCount,
          regularSeasonMatchupPeriods: basicLeagueData.leagueFormat?.regularSeasonMatchupPeriods,
          playoffMatchupPeriodLength: basicLeagueData.leagueFormat?.playoffMatchupPeriodLength,
          playoffSeedingRule: basicLeagueData.leagueFormat?.playoffSeedingRule,
        },
        throughWeek: args.week,
      });

      // Byes for this week, resolved to a name/seed (spec: `byes` next to `playoffBreakdown`).
      const byes = weekByeRows.map(m => {
        const teamId = m.homeTeamId !== "" ? m.homeTeamId : m.awayTeamId;
        const team = teamMap.get(teamId);
        const seed = playoffs.seeds.find(s => s.teamId === teamId)?.seed;
        return { teamId, teamName: team?.name ?? teamId, seed: seed ?? 0 };
      });

      // Manager display names and NFL teams come from the enriched league payload
      // (which already resolved ownerInfo / teamClaims and playersEnhanced), so
      // this query invents nothing of its own.
      const managerByExternalId = new Map<string, string>();
      const nflTeamByPlayerId = new Map<string, string>();
      for (const enrichedTeam of (basicLeagueData.teams ?? []) as any[]) {
        if (enrichedTeam?.externalId) {
          managerByExternalId.set(
            String(enrichedTeam.externalId),
            enrichedTeam.manager || UNKNOWN_MANAGER
          );
        }
        for (const rosterPlayer of (enrichedTeam?.roster ?? []) as any[]) {
          if (rosterPlayer?.playerId && rosterPlayer.nflTeam) {
            nflTeamByPlayerId.set(String(rosterPlayer.playerId), rosterPlayer.nflTeam);
          }
        }
      }
      const managerFor = (externalId: string | undefined) =>
        (externalId ? managerByExternalId.get(String(externalId)) : undefined) ?? UNKNOWN_MANAGER;

      // In-game injuries for this exact week (spec §16, owner ask 2026-09-05): excluded from the
      // "worst starter at the position" comparison below, same rule `getLeagueDataForAI`'s
      // `topPerformersFor` applies to the generic path.
      const inGameInjuries: InGameInjury[] = await ctx.runQuery(internal.inGameInjuries.getInGameInjuriesForWeek, {
        leagueId: args.leagueId,
        seasonId: args.seasonId,
        week: args.week,
      });
      const inGameInjuredEspnIds = new Set(inGameInjuries.map(h => h.espnId));

      // Categorize matchups by playoff tier
      const playoffMatchups = weekMatchups.filter(m => m.playoffTier === "WINNERS_BRACKET");
      const consolationMatchups = weekMatchups.filter(m => 
        m.playoffTier === "WINNERS_CONSOLATION_LADDER" || 
        m.playoffTier === "LOSERS_CONSOLATION_LADDER"
      );
      const regularSeasonMatchups = weekMatchups.filter(m => 
        !m.playoffTier || m.playoffTier === "NONE"
      );
      
      // Determine if this is a championship week (only one WINNERS_BRACKET game)
      const isChampionshipWeek = playoffMatchups.length === 1;
      
      console.log(`Week ${args.week} analysis: ${playoffMatchups.length} playoff games, ${consolationMatchups.length} consolation games, ${regularSeasonMatchups.length} regular season games`);
      if (isChampionshipWeek) {
        console.log("Championship game detected!");
      }
      
      // Helper function to enrich a matchup
      const enrichMatchup = (matchup: any, isPlayoffGame = false, isChampionshipGame = false) => {
        const homeTeam = teamMap.get(matchup.homeTeamId);
        const awayTeam = teamMap.get(matchup.awayTeamId);
        
        // Calculate memorable moments for this matchup
        const homeRoster = matchup.homeRoster?.players || [];
        const awayRoster = matchup.awayRoster?.players || [];
        
        // Separate starters from bench players
        // Every player carries its NFL team and its fantasy team as separate,
        // explicit keys (spec section 4.3). `team` keeps its legacy meaning in
        // this payload - the fantasy team name - and is no longer read on its own.
        const withTeamContext = (p: any, team: typeof homeTeam, fallbackId: string) => ({
          ...p,
          team: team?.name || fallbackId,
          nflTeam: nflTeamByPlayerId.get(String(p.espnId)),
          fantasyTeamId: String(team?.externalId ?? fallbackId),
          fantasyTeamName: team?.name || fallbackId,
        });

        const allPlayers = [
          ...homeRoster.map((p: any) => withTeamContext(p, homeTeam, matchup.homeTeamId)),
          ...awayRoster.map((p: any) => withTeamContext(p, awayTeam, matchup.awayTeamId))
        ];
        
        // Categorize players by lineup status
        const starters = allPlayers.filter(p => p.lineupSlotId !== 20 && p.lineupSlotId !== 21); // Not bench or IR
        const benchPlayers = allPlayers.filter(p => p.lineupSlotId === 20); // Bench only
        
        // Find top performing starters (prioritized)
        const topStarters = starters
          .sort((a, b) => b.points - a.points)
          .slice(0, isChampionshipGame ? 8 : 4)
          .map(player => ({
            playerName: player.fullName,
            position: player.position,
            points: player.points,
            projectedPoints: player.projectedPoints || 0,
            team: player.team,
            nflTeam: player.nflTeam,
            fantasyTeamId: player.fantasyTeamId,
            fantasyTeamName: player.fantasyTeamName,
            isStarter: true,
            lineupSlotId: player.lineupSlotId,
            overPerformance: player.projectedPoints ? 
              ((player.points - player.projectedPoints) / player.projectedPoints * 100).toFixed(1) : 0
          }));
        
        // Find bench players who would have made a meaningful difference
        const impactfulBenchPlayers = benchPlayers
          .filter(benchPlayer => {
            // Only consider bench players with decent scores
            if (benchPlayer.points < 15) return false;
            
            // Find the worst starter at the same position ON THE SAME TEAM. `starters` holds both
            // sides of the matchup; comparing across them named the opponent's starter as the man
            // "left on the bench" behind, which put players on the wrong team in recaps. A starter
            // who left THIS game injured (spec §16) is excluded too - a low score from him is
            // never a lineup decision, so he can never be "replaced" by a bench player either.
            const samePositionStarters = starters.filter(
              s => s.position === benchPlayer.position &&
                s.fantasyTeamId === benchPlayer.fantasyTeamId &&
                !inGameInjuredEspnIds.has(String(s.espnId))
            );
            if (samePositionStarters.length === 0) return false;
            
            // Find the lowest scoring starter at this position
            const worstStarter = samePositionStarters.sort((a, b) => a.points - b.points)[0];
            
            // Only include if bench player significantly outperformed the worst starter
            const pointDifference = benchPlayer.points - worstStarter.points;
            return pointDifference >= 10; // At least 10 point improvement
          })
          .sort((a, b) => b.points - a.points)
          .slice(0, 2) // Max 2 impactful bench players
          .map(player => {
            // Calculate the actual impact - against the SAME team's starters (see the filter above).
            const samePositionStarters = starters.filter(
              s => s.position === player.position &&
                s.fantasyTeamId === player.fantasyTeamId &&
                !inGameInjuredEspnIds.has(String(s.espnId))
            );
            const worstStarter = samePositionStarters.sort((a, b) => a.points - b.points)[0];
            const pointDifference = player.points - worstStarter.points;
            
            return {
              playerName: player.fullName,
              position: player.position,
              points: player.points,
              projectedPoints: player.projectedPoints || 0,
              team: player.team,
              nflTeam: player.nflTeam,
              fantasyTeamId: player.fantasyTeamId,
              fantasyTeamName: player.fantasyTeamName,
              isStarter: false,
              lineupSlotId: player.lineupSlotId,
              overPerformance: player.projectedPoints ? 
                ((player.points - player.projectedPoints) / player.projectedPoints * 100).toFixed(1) : 0,
              benchImpact: true,
              wouldHaveReplacedPlayer: worstStarter.fullName,
              pointImprovementIfStarted: pointDifference.toFixed(1)
            };
          });
        
        // Combine top performers (starters first, then impactful bench players)
        const topPerformers = [...topStarters, ...impactfulBenchPlayers];
        
        // Calculate bench points
        const homeBenchPoints = homeRoster
          .filter((p: any) => p.lineupSlotId === 20) // Bench slot ID
          .reduce((sum: number, p: any) => sum + p.points, 0);
        
        const awayBenchPoints = awayRoster
          .filter((p: any) => p.lineupSlotId === 20)
          .reduce((sum: number, p: any) => sum + p.points, 0);
        
        // Determine closeness and upset
        const marginOfVictory = Math.abs(matchup.homeScore - matchup.awayScore);
        const totalPoints = matchup.homeScore + matchup.awayScore;
        const closeGameThreshold = totalPoints * 0.05; // 5% of total points
        
        let closeness = 'BLOWOUT';
        if (marginOfVictory <= closeGameThreshold) closeness = 'NAIL-BITER';
        else if (marginOfVictory <= closeGameThreshold * 2) closeness = 'CLOSE';
        
        const isUpset = matchup.homeProjectedScore && matchup.awayProjectedScore && (
          (matchup.winner === 'home' && matchup.awayProjectedScore > matchup.homeProjectedScore + 10) ||
          (matchup.winner === 'away' && matchup.homeProjectedScore > matchup.awayProjectedScore + 10)
        );
        
        // Create memorable moment - enhanced for playoff/championship games
        let memorableMoment = '';
        if (isChampionshipGame) {
          if (isUpset) {
            memorableMoment = `CHAMPIONSHIP UPSET! ${matchup.winner === 'home' ? homeTeam?.name : awayTeam?.name} crowned champion against all odds!`;
          } else if (closeness === 'NAIL-BITER') {
            memorableMoment = `CHAMPIONSHIP THRILLER! Title decided by just ${marginOfVictory.toFixed(1)} points!`;
          } else {
            memorableMoment = `${matchup.winner === 'home' ? homeTeam?.name : awayTeam?.name} claims the championship!`;
          }
        } else if (isPlayoffGame) {
          if (isUpset) {
            memorableMoment = `PLAYOFF UPSET! ${matchup.winner === 'home' ? homeTeam?.name : awayTeam?.name} advances with a stunning victory!`;
          } else if (closeness === 'NAIL-BITER') {
            memorableMoment = `PLAYOFF THRILLER! ${matchup.winner === 'home' ? homeTeam?.name : awayTeam?.name} survives by ${marginOfVictory.toFixed(1)} points!`;
          } else {
            memorableMoment = `${matchup.winner === 'home' ? homeTeam?.name : awayTeam?.name} advances in the playoffs!`;
          }
        } else {
          if (isUpset) {
            memorableMoment = `Major upset! ${matchup.winner === 'home' ? homeTeam?.name : awayTeam?.name} defied the odds`;
          } else if (closeness === 'NAIL-BITER') {
            memorableMoment = `Down to the wire! Decided by just ${marginOfVictory.toFixed(1)} points`;
          } else if (Number(topPerformers[0]?.overPerformance) > 50) {
            memorableMoment = `${topPerformers[0].playerName} exploded for ${topPerformers[0].points.toFixed(1)} points!`;
          }
        }
        
        return {
          ...matchup,
          teamA: homeTeam?.name || matchup.homeTeamId,
          teamB: awayTeam?.name || matchup.awayTeamId,
          teamAId: matchup.homeTeamId,
          teamBId: matchup.awayTeamId,
          teamAName: homeTeam?.name || matchup.homeTeamId,
          teamBName: awayTeam?.name || matchup.awayTeamId,
          teamAOwner: managerFor(homeTeam?.externalId),
          teamBOwner: managerFor(awayTeam?.externalId),
          scoreA: matchup.homeScore,
          scoreB: matchup.awayScore,
          projectedScoreA: matchup.homeProjectedScore,
          projectedScoreB: matchup.awayProjectedScore,
          topPerformers,
          benchPointsA: homeBenchPoints,
          benchPointsB: awayBenchPoints,
          closeness,
          isUpset,
          memorableMoment,
          isPlayoffGame,
          isChampionshipGame,
          playoffTier: matchup.playoffTier,
          homeRoster: homeRoster.map((p: any) => ({
            ...p,
            teamName: homeTeam?.name || matchup.homeTeamId,
            nflTeam: nflTeamByPlayerId.get(String(p.espnId)),
            fantasyTeamId: String(homeTeam?.externalId ?? matchup.homeTeamId),
            fantasyTeamName: homeTeam?.name || matchup.homeTeamId,
            isStarter: p.lineupSlotId !== 20 && p.lineupSlotId !== 21,
            isBench: p.lineupSlotId === 20,
            isIR: p.lineupSlotId === 21,
          })),
          awayRoster: awayRoster.map((p: any) => ({
            ...p,
            teamName: awayTeam?.name || matchup.awayTeamId,
            nflTeam: nflTeamByPlayerId.get(String(p.espnId)),
            fantasyTeamId: String(awayTeam?.externalId ?? matchup.awayTeamId),
            fantasyTeamName: awayTeam?.name || matchup.awayTeamId,
            isStarter: p.lineupSlotId !== 20 && p.lineupSlotId !== 21,
            isBench: p.lineupSlotId === 20,
            isIR: p.lineupSlotId === 21,
          })),
        };
      };
      
      // Enrich matchups with priority order: Championship > Playoff > Consolation > Regular
      const enrichedPlayoffMatchups = playoffMatchups.map(m => 
        enrichMatchup(m, true, isChampionshipWeek)
      );
      const enrichedConsolationMatchups = consolationMatchups.map(m => 
        enrichMatchup(m, false, false)
      );
      const enrichedRegularMatchups = regularSeasonMatchups.map(m => 
        enrichMatchup(m, false, false)
      );
      
      // Combine all matchups with playoff games first
      const enrichedMatchups = [
        ...enrichedPlayoffMatchups,
        ...enrichedConsolationMatchups,
        ...enrichedRegularMatchups
      ];
      
      // Matchups up to this week for standings calculation - already fetched above as
      // `seasonMatchupsThroughWeek` for the playoff bracket.
      const allMatchupsToWeek = seasonMatchupsThroughWeek;

      // Get standings at this point in the season
      const standingsAtWeek = teams
        .map(team => {
          // Calculate record up to this week
          const teamMatchups = allMatchupsToWeek.filter(m => 
            (m.homeTeamId === team.externalId || m.awayTeamId === team.externalId) &&
            m.winner
          );
          
          let wins = 0, losses = 0, ties = 0;
          teamMatchups.forEach(m => {
            if (m.winner === 'tie') {
              ties++;
            } else if (
              (m.winner === 'home' && m.homeTeamId === team.externalId) ||
              (m.winner === 'away' && m.awayTeamId === team.externalId)
            ) {
              wins++;
            } else {
              losses++;
            }
          });
          
          return {
            teamId: team._id,
            teamName: team.name,
            externalId: team.externalId,
            owner: team.owner, // legacy: raw ESPN owner string
            manager: managerFor(team.externalId),
            wins,
            losses,
            ties,
            winPercentage: (wins + ties * 0.5) / Math.max(1, wins + losses + ties),
          };
        })
        .sort((a, b) => b.winPercentage - a.winPercentage);
      
      const result = {
        // Basic league info
        leagueName: league.name,
        currentWeek: args.week,
        currentSeason: args.seasonId,
        teams: basicLeagueData.teams,
        
        // Week-specific data with playoff prioritization
        recentMatchups: enrichedMatchups,
        // Every in-game injury for this exact week (spec §16) - see this handler's
        // `inGameInjuries` build above.
        inGameInjuries,
        standingsAtWeek,
        
        // NEW: Playoff-specific categorization for AI prioritization
        playoffBreakdown: {
          isPlayoffWeek: playoffMatchups.length > 0 || consolationMatchups.length > 0,
          isChampionshipWeek,
          playoffMatchups: enrichedPlayoffMatchups,
          consolationMatchups: enrichedConsolationMatchups,
          regularSeasonMatchups: enrichedRegularMatchups,
          playoffGameCount: playoffMatchups.length,
          consolationGameCount: consolationMatchups.length,
          regularGameCount: regularSeasonMatchups.length,
          championshipGame: isChampionshipWeek && enrichedPlayoffMatchups.length > 0
            ? enrichedPlayoffMatchups[0]
            : null,
        },
        // Round-one byes this week (spec: playoffs round) - not games, so never in
        // `playoffBreakdown` above; named so a preview/recap can say "seed 1 rests".
        byes,
        // The playoff picture / bracket through this exact week (spec: playoffs round - names the
        // champion straight from the bracket for the championship recap).
        playoffs,

        // Context from basic data
        rivalries: basicLeagueData.rivalries,
        playoffProbabilities: basicLeagueData.playoffProbabilities,
        
        // Required fields for content generation
        trades: [], // Not needed for weekly recap
        transactions: basicLeagueData.transactions.slice(0, 10), // Recent transactions
        managerActivity: basicLeagueData.managerActivity,
        standings: standingsAtWeek,

        // The FAAB/waiver ledger (owner goal): recaps can cite the week's waiver drama by id, kept
        // light per the prompt-layer guidance in `buildWeeklyRecapData`.
        waivers: waiverLedger,

        // Settings
        scoringType: league.settings?.scoringType || "PPR",
        rosterSize: league.settings?.rosterSize || 16,
        // League-format facts (spec: format audit), carried through so a standings mention in the
        // recap can name a division.
        leagueFormat: basicLeagueData.leagueFormat,
        playoffTeams: basicLeagueData.leagueFormat?.playoffTeamCount,
        regularSeasonWeeks: basicLeagueData.leagueFormat?.regularSeasonMatchupPeriods,

        metadata: {
          dataFreshness: Date.now(),
          week: args.week,
          seasonId: args.seasonId,
          isPlayoffWeek: playoffMatchups.length > 0 || consolationMatchups.length > 0,
          isChampionshipWeek,
          totalMatchups: weekMatchups.length,
          playoffMatchups: playoffMatchups.length,
          consolationMatchups: consolationMatchups.length,
          regularSeasonMatchups: regularSeasonMatchups.length,
        },
      };
      
      const executionTime = Date.now() - startTime;
      console.log("=== getWeeklyRecapDataForAI SUCCESS ===");
      console.log("Execution time:", executionTime + "ms");
      console.log("Week:", args.week);
      console.log("Total matchups found:", enrichedMatchups.length);
      console.log("Playoff games (WINNERS_BRACKET):", playoffMatchups.length);
      console.log("Consolation games:", consolationMatchups.length);
      console.log("Regular season games:", regularSeasonMatchups.length);
      console.log("Is Championship Week:", isChampionshipWeek);
      
      return result;
      
    } catch (error) {
      const executionTime = Date.now() - startTime;
      console.error("=== getWeeklyRecapDataForAI ERROR ===");
      console.error("Execution time before error:", executionTime + "ms");
      console.error("Error:", error);
      throw error;
    }
  },
});