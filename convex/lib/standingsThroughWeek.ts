/**
 * Pure standings math for season backfill's "historical mode" (brief A,
 * `aiQueries.getLeagueDataForAI`'s `asOf` argument): the record a team
 * actually had after a given week, computed from played matchups, rather
 * than `teams.record` - which is always the END-OF-SEASON record, wrong for
 * any article written about an earlier week (a week-5 power ranking must not
 * read a team's final 11-6 mark).
 *
 * No Convex imports here on purpose - this module is pure and standalone so
 * it stays trivially unit-testable, matching the convention already set by
 * `convex/lib/leagueCalendar.ts` and `convex/lib/draftDate.ts`.
 */

/** The subset of a `teams` doc this module needs. */
export interface StandingsTeamInput {
  externalId: string;
  divisionId?: number;
}

/** The subset of a `matchups` doc this module needs. */
export interface StandingsMatchupInput {
  homeTeamId: string;
  awayTeamId: string;
  homeScore: number;
  awayScore: number;
  winner?: "home" | "away" | "tie";
  matchupPeriod: number;
  playoffTier?: string;
}

export interface StandingsThroughWeekOptions {
  /** "Played" means `matchupPeriod <= throughWeek`. May be 0 (before the first game). */
  throughWeek: number;
  /** The last REGULAR-season matchup period - `leagueFormat.regularSeasonMatchupPeriods`. */
  lastRegularSeasonWeek: number;
}

export interface StandingsThroughWeekRow {
  externalId: string;
  divisionId?: number;
  wins: number;
  losses: number;
  ties: number;
  pointsFor: number;
  pointsAgainst: number;
  /** 1-indexed, wins desc then pointsFor desc. Also `playoffSeed` below - the two never disagree. */
  rank: number;
  playoffSeed: number;
}

/**
 * A matchup counts toward the regular season when ESPN's own `playoffTier`
 * says so (`"NONE"`); a row that predates that field being synced falls back
 * to a week-number heuristic. Once `playoffTier` IS present and says
 * otherwise (a playoff/consolation game), the week-number heuristic never
 * overrides it - a playoff matchup inside the "regular season week range"
 * (an odd bracket, a mid-season consolation game) still must not count
 * toward a regular-season standings computation.
 */
function isRegularSeasonMatchup(matchup: StandingsMatchupInput, lastRegularSeasonWeek: number): boolean {
  if (matchup.playoffTier !== undefined) return matchup.playoffTier === "NONE";
  return matchup.matchupPeriod <= lastRegularSeasonWeek;
}

/** Home win / away win / tie, preferring the stored `winner` and falling back to the raw scores. */
function outcomeFor(matchup: StandingsMatchupInput): "home" | "away" | "tie" {
  if (matchup.winner) return matchup.winner;
  if (matchup.homeScore === matchup.awayScore) return "tie";
  return matchup.homeScore > matchup.awayScore ? "home" : "away";
}

/**
 * Every team's record built ONLY from played (`matchupPeriod <= throughWeek`)
 * regular-season matchups, ranked wins desc then pointsFor desc (ties keep
 * their relative input order, same as `Array.prototype.sort`'s stable sort).
 * `playoffSeed` mirrors `rank` - this is a through-week computation, not
 * ESPN's own (end-of-season-aware) seeding rule.
 *
 * Every team passed in gets a row, even one with zero played games (an
 * `asOf.week` of 0, or a team that joined mid-season) - wins/losses/ties and
 * points all read 0 rather than being omitted.
 */
export function computeStandingsThroughWeek(
  teams: StandingsTeamInput[],
  matchups: StandingsMatchupInput[],
  options: StandingsThroughWeekOptions
): StandingsThroughWeekRow[] {
  type Accumulator = {
    externalId: string;
    divisionId?: number;
    wins: number;
    losses: number;
    ties: number;
    pointsFor: number;
    pointsAgainst: number;
  };

  const byExternalId = new Map<string, Accumulator>();
  for (const team of teams) {
    byExternalId.set(team.externalId, {
      externalId: team.externalId,
      divisionId: team.divisionId,
      wins: 0,
      losses: 0,
      ties: 0,
      pointsFor: 0,
      pointsAgainst: 0,
    });
  }

  const played = matchups.filter(
    (matchup) =>
      matchup.matchupPeriod <= options.throughWeek &&
      isRegularSeasonMatchup(matchup, options.lastRegularSeasonWeek)
  );

  for (const matchup of played) {
    const home = byExternalId.get(matchup.homeTeamId);
    const away = byExternalId.get(matchup.awayTeamId);
    const outcome = outcomeFor(matchup);

    if (home) {
      home.pointsFor += matchup.homeScore;
      home.pointsAgainst += matchup.awayScore;
      if (outcome === "home") home.wins += 1;
      else if (outcome === "away") home.losses += 1;
      else home.ties += 1;
    }
    if (away) {
      away.pointsFor += matchup.awayScore;
      away.pointsAgainst += matchup.homeScore;
      if (outcome === "away") away.wins += 1;
      else if (outcome === "home") away.losses += 1;
      else away.ties += 1;
    }
  }

  const ranked = [...byExternalId.values()].sort((a, b) => {
    if (a.wins !== b.wins) return b.wins - a.wins;
    return b.pointsFor - a.pointsFor;
  });

  return ranked.map((row, index) => ({
    ...row,
    rank: index + 1,
    playoffSeed: index + 1,
  }));
}
