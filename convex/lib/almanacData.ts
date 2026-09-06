/**
 * Gathers the plain rows `src/lib/ai/almanac.ts#buildAlmanac` computes from: every season's
 * teams and matchups, and (for the seasons that have one) the stored draft's first-round picks
 * joined against `playersEnhanced`/`playerStats` for that season's applied points.
 *
 * Deliberately has no `internal`/`api` imports of its own (the repo-wide gotcha documented in
 * `./leagueCalendar.ts` and `./espnSettings.ts`), so it is safe for `convex/aiQueries.ts` and
 * `convex/commentRequests.ts` to import as a value.
 */
import type { QueryCtx, MutationCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { parseEspnLeagueSettings } from "./espnSettings";
import type {
  AlmanacDraftPickInput,
  AlmanacInput,
  AlmanacMatchupInput,
  AlmanacPlayerInput,
  AlmanacSeasonInput,
  AlmanacStoredResult,
  AlmanacTeamInput,
} from "../../src/lib/ai/almanac";

type DbCtx = QueryCtx | MutationCtx;

/** ESPN's display name for a team's owner, or null when `ownerInfo` has nothing usable. */
function espnDisplayName(team: Doc<"teams">): string | null {
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

function tidy(name: string): string {
  return name.replace(/\s+/g, " ").trim();
}

/** Display name for this team's manager - ESPN's `ownerInfo` first, then the raw `owner` string. */
export function managerNameFor(team: Doc<"teams">): string {
  const espnName = espnDisplayName(team);
  if (espnName) return tidy(espnName);
  const owner = team.owner?.trim();
  return owner ? tidy(owner) : "Unknown";
}

/**
 * Stable manager identity across seasons: ESPN's member GUID (`ownerInfo.id`) when present,
 * else the normalised lowercase display name - team names (and even the stored `owner` string)
 * change across seasons in this league; the almanac needs one key per real person.
 */
export function managerKeyFor(team: Doc<"teams">): string {
  const id = team.ownerInfo?.id?.trim();
  if (id) return id;
  return managerNameFor(team).toLowerCase();
}

function toStoredResult(
  entry:
    | { teamId: string; teamName: string; record: { wins: number; losses: number; ties: number }; pointsFor?: number }
    | undefined
): AlmanacStoredResult | undefined {
  if (!entry) return undefined;
  return { teamId: entry.teamId, teamName: entry.teamName, record: entry.record, pointsFor: entry.pointsFor };
}

/**
 * Every row `buildAlmanac` needs for one league, across every synced season.
 *
 * Bounded reads: one query for `leagueSeasons` (by_league), then per season one query for
 * `teams` (by_season) and one for `matchups` (by_league_season, `.take(400)` - a full regular
 * season plus a multi-round bracket and consolation ladder for even an 18-week, 16-team league
 * comfortably fits inside 400 rows, and a real prod season has never come close), plus for a
 * season with a stored draft, two extra reads (`playersEnhanced` + `playerStats`) per
 * first-round pick. For prod's 7-season, ~10-14 team league that is roughly: 1 + 7 (teams) +
 * 7 (matchups) + 2 seasons x ~12 picks x 2 = ~63 queries reading well under 1,000 documents
 * total - see the calling agent's report for the measured count.
 */
export async function gatherAlmanacInput(
  ctx: DbCtx,
  leagueId: Id<"leagues">,
  currentSeason: number
): Promise<AlmanacInput> {
  const leagueSeasons = await ctx.db
    .query("leagueSeasons")
    .withIndex("by_league", (q) => q.eq("leagueId", leagueId))
    .collect();

  const seasons: AlmanacSeasonInput[] = [];
  const teams: AlmanacTeamInput[] = [];
  const matchups: AlmanacMatchupInput[] = [];
  const players: AlmanacPlayerInput[] = [];

  for (const leagueSeason of leagueSeasons) {
    const seasonId = leagueSeason.seasonId;
    if (!seasonId) continue;

    const seasonTeams = await ctx.db
      .query("teams")
      .withIndex("by_season", (q) => q.eq("leagueId", leagueId).eq("seasonId", seasonId))
      .collect();

    for (const t of seasonTeams) {
      teams.push({
        season: seasonId,
        externalId: t.externalId,
        name: t.name,
        managerKey: managerKeyFor(t),
        manager: managerNameFor(t),
        wins: t.record.wins,
        losses: t.record.losses,
        ties: t.record.ties,
        pointsFor: t.record.pointsFor ?? 0,
        pointsAgainst: t.record.pointsAgainst,
        playoffSeed: t.record.playoffSeed,
      });
    }

    const seasonMatchups = await ctx.db
      .query("matchups")
      .withIndex("by_league_season", (q) => q.eq("leagueId", leagueId).eq("seasonId", seasonId))
      .take(400);

    for (const m of seasonMatchups) {
      matchups.push({
        season: seasonId,
        week: m.matchupPeriod,
        homeTeamId: m.homeTeamId,
        awayTeamId: m.awayTeamId,
        homeScore: m.homeScore,
        awayScore: m.awayScore,
        winner: m.winner,
        playoffTier: m.playoffTier,
      });
    }

    const draft: AlmanacDraftPickInput[] | undefined = leagueSeason.draft?.map((pick) => ({
      overallPickNumber: pick.overallPickNumber,
      roundId: pick.roundId,
      roundPickNumber: pick.roundPickNumber,
      teamId: pick.teamId,
      playerId: pick.playerId,
      keeper: pick.keeper,
    }));

    if (draft) {
      const firstRound = draft.filter((p) => p.roundId === 1);
      for (const pick of firstRound) {
        const espnId = String(pick.playerId);
        const [enhanced, stat] = await Promise.all([
          ctx.db
            .query("playersEnhanced")
            .withIndex("by_espn_id_season", (q) => q.eq("espnId", espnId).eq("season", seasonId))
            .first(),
          ctx.db
            .query("playerStats")
            .withIndex("by_league_player", (q) => q.eq("leagueId", leagueId).eq("espnId", espnId).eq("season", seasonId))
            .first(),
        ]);
        players.push({
          season: seasonId,
          playerId: espnId,
          name: enhanced?.fullName ?? `Player ${espnId}`,
          pos: enhanced?.defaultPosition,
          seasonPoints: stat?.actualAppliedTotal,
        });
      }
    }

    const parsedSettings = parseEspnLeagueSettings(leagueSeason.settings);

    seasons.push({
      season: seasonId,
      champion: toStoredResult(leagueSeason.champion),
      runnerUp: toStoredResult(leagueSeason.runnerUp),
      regularSeasonChampion: toStoredResult(leagueSeason.regularSeasonChampion),
      playoffTeamCount: parsedSettings.playoffTeamCount,
      regularSeasonWeeks: parsedSettings.regularSeasonMatchupPeriods,
      draft,
    });
  }

  return {
    currentSeason,
    seasons,
    teams,
    matchups,
    players: players.length > 0 ? players : undefined,
  };
}
