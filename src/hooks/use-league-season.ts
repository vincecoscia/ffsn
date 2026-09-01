import { useMemo } from "react";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";

interface UseLeagueSeasonResult {
  currentSeason: number;
  availableSeasons: number[];
  isLoading: boolean;
}

/**
 * Returns the NFL season a given date falls in. The NFL season is named for
 * the year it kicks off in (e.g. games played in January 2027 are still part
 * of the 2026 season), so any month before July rolls back to the prior year.
 */
export function nflSeasonYear(date: Date): number {
  const year = date.getFullYear();
  const month = date.getMonth(); // 0-indexed: 0 = January, 7 = August
  // Matches convex/lib/season.ts: January through July belong to the previous season.
  return month < 7 ? year - 1 : year;
}

/**
 * Resolves the current and available seasons for a league.
 *
 * `currentSeason` prefers the most recent season present in `leagueSeasons`
 * (kept in sync by the ESPN sync job), falling back to the league's frozen
 * `espnData.seasonId`, and finally to the calendar-derived NFL season year.
 */
export function useLeagueSeason(
  leagueId: Id<"leagues"> | undefined
): UseLeagueSeasonResult {
  const league = useQuery(
    api.leagues.getById,
    leagueId ? { id: leagueId } : "skip"
  );

  const leagueSeasons = useQuery(
    api.leagues.getLeagueSeasons,
    leagueId ? { leagueId } : "skip"
  );

  return useMemo(() => {
    const isLoading =
      leagueId !== undefined &&
      (league === undefined || leagueSeasons === undefined);

    const availableSeasons = (leagueSeasons ?? [])
      .map((season) => season.seasonId)
      .sort((a, b) => b - a);

    const currentSeason =
      availableSeasons[0] ??
      league?.espnData?.seasonId ??
      nflSeasonYear(new Date());

    return { currentSeason, availableSeasons, isLoading };
  }, [league, leagueSeasons, leagueId]);
}
