"use client";

import { useMemo } from "react";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { Id } from "../../../convex/_generated/dataModel";
import { useLeagueSeason } from "@/hooks/use-league-season";
import { useDraftStatus } from "@/hooks/use-draft-status";
import { personaName, type TickerItem } from "@/components/broadcast";

export type LeaguePhase =
  | "loading"
  | "predraft"
  | "preseason"
  | "week-upcoming"
  | "week-live"
  | "week-final"
  | "offseason";

export interface LeagueTickerResult {
  phase: LeaguePhase;
  /** Red plate text on the ticker. */
  label: string;
  items: TickerItem[];
  season: number;
  /** Current matchup week once the season is under way. */
  week?: number;
  /** Draft date (ms) while the league has not drafted yet, when ESPN provides it. */
  draftDate?: number;
}

interface LeagueSettingsLike {
  playoffWeeks?: number;
  regularSeasonMatchupPeriods?: number;
}

interface TeamLike {
  externalId: string;
  name: string;
  owner: string;
  record: {
    wins: number;
    losses: number;
    ties: number;
    pointsFor?: number;
    playoffSeed?: number;
  };
}

const score = (n: number) => n.toFixed(1);

const recordOf = (t: TeamLike) =>
  `${t.record.wins}-${t.record.losses}${t.record.ties > 0 ? `-${t.record.ties}` : ""}`;

function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}

/**
 * Final ranking for a finished season: the recorded champion and runner-up
 * first (ESPN only sets them once the bracket is decided), then everyone else
 * by playoff seed when available, otherwise by record and points.
 */
function rankFinal(
  teams: TeamLike[],
  championId?: string,
  runnerUpId?: string
): TeamLike[] {
  const rest = teams
    .filter((t) => t.externalId !== championId && t.externalId !== runnerUpId)
    .sort((a, b) => {
      const seedA = a.record.playoffSeed ?? Number.MAX_SAFE_INTEGER;
      const seedB = b.record.playoffSeed ?? Number.MAX_SAFE_INTEGER;
      if (seedA !== seedB) return seedA - seedB;
      if (a.record.wins !== b.record.wins) return b.record.wins - a.record.wins;
      return (b.record.pointsFor ?? 0) - (a.record.pointsFor ?? 0);
    });
  const champion = teams.find((t) => t.externalId === championId);
  const runnerUp = teams.find((t) => t.externalId === runnerUpId);
  return [champion, runnerUp, ...rest].filter((t): t is TeamLike => !!t);
}

/**
 * Builds the league header ticker from what the league is doing right now:
 * the draft order before the draft, this week's matchups (live scores or
 * projections) plus last week's finals during the season, the week's finals
 * between weeks, and the final standings once the season is decided.
 * Reads only queries the league pages already subscribe to.
 */
export function useLeagueTicker(
  leagueId: Id<"leagues">,
  settings: LeagueSettingsLike | undefined
): LeagueTickerResult {
  const { currentSeason } = useLeagueSeason(leagueId);
  const { isDraftComplete, draftData, isLoading: draftLoading } = useDraftStatus(leagueId, currentSeason);

  const leagueSeason = useQuery(api.leagues.getLeagueSeasonByYear, { leagueId, seasonId: currentSeason });
  const teams = useQuery(api.teams.getByLeagueAndSeason, { leagueId, seasonId: currentSeason });
  const matchupData = useQuery(
    api.matchups.getCurrentWeekMatchups,
    isDraftComplete ? { leagueId, seasonId: currentSeason } : "skip"
  );

  const currentWeek = matchupData?.currentWeek;
  const weekHasUndecided = !!matchupData && matchupData.matchups.some((m) => !m.winner);
  const previousWeek = useQuery(
    api.matchups.getByLeagueAndPeriod,
    isDraftComplete && currentWeek && currentWeek > 1 && weekHasUndecided
      ? { leagueId, seasonId: currentSeason, matchupPeriod: currentWeek - 1 }
      : "skip"
  );

  const latestStory = useQuery(api.aiContent.getByLeague, {
    leagueId,
    paginationOpts: { numItems: 1, cursor: null },
  });

  // The last 8 Wire posts replace the single "Latest story" item when there are any; a league
  // with nothing on the Wire yet (or no pass) falls back to that story item instead.
  const wirePosts = useQuery(api.wire.getRecentForTicker, { leagueId, limit: 8 });

  return useMemo<LeagueTickerResult>(() => {
    const base = { season: currentSeason };
    const wireItems: TickerItem[] = (wirePosts ?? []).map((post) => ({
      // A manager post carries `authorName` instead of `persona` (see `wire.getRecentForTicker`).
      k: post.persona ? personaName(post.persona).split(" ")[0] : (post.authorName?.split(" ")[0] ?? "Manager"),
      v: post.text.length > 90 ? `${post.text.slice(0, 89)}…` : post.text,
    }));
    const storyItem: TickerItem[] =
      wireItems.length > 0
        ? wireItems
        : latestStory && latestStory.page.length > 0
          ? [{ k: "Latest story", v: latestStory.page[0].title }]
          : [];

    if (draftLoading || teams === undefined) {
      return { ...base, phase: "loading", label: "League feed", items: [] };
    }

    const teamById = new Map<string, TeamLike>(teams.map((t) => [String(t.externalId), t]));
    const nameOf = (id: string | number) => teamById.get(String(id))?.name ?? `Team ${id}`;

    // --- Before the draft: the draft order ---
    if (!isDraftComplete) {
      const pickOrder: Array<number | string> | undefined = draftData?.draftSettings?.pickOrder;
      const draftDate: number | undefined = draftData?.draftSettings?.availableDate ?? draftData?.draftSettings?.date;
      const items: TickerItem[] = [];
      if (draftDate) {
        items.push({
          k: "Draft",
          v: new Date(draftDate).toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
          }),
        });
      }
      if (pickOrder && pickOrder.length > 0) {
        pickOrder.forEach((id, i) => {
          const team = teamById.get(String(id));
          items.push({ k: `Pick ${i + 1}`, v: team ? `${team.name} · ${team.owner}` : nameOf(id) });
        });
        return { ...base, phase: "predraft", label: "Draft order", items: [...items, ...storyItem], draftDate };
      }
      items.push({ k: "Draft order", v: "Not set yet" });
      teams.forEach((t) => items.push({ k: "Team", v: `${t.name} · ${t.owner}` }));
      return { ...base, phase: "predraft", label: "Preseason", items: [...items, ...storyItem], draftDate };
    }

    if (matchupData === undefined) {
      return { ...base, phase: "loading", label: "League feed", items: [] };
    }

    const ms = matchupData.matchups;
    const week = matchupData.currentWeek;

    // --- Drafted, but no schedule synced yet ---
    if (ms.length === 0) {
      const items: TickerItem[] = [{ k: "Season", v: `${currentSeason} · Draft complete` }];
      teams.forEach((t) => items.push({ k: "Team", v: `${t.name} · ${t.owner}` }));
      return { ...base, phase: "preseason", label: "Preseason", items: [...items, ...storyItem] };
    }

    const allFinal = ms.every((m) => !!m.winner);
    const totalWeeks = (settings?.regularSeasonMatchupPeriods ?? 14) + (settings?.playoffWeeks ?? 0);
    const seasonOver = allFinal && (!!leagueSeason?.champion || week >= totalWeeks);

    const finalItem = (m: (typeof ms)[number], k: string): TickerItem => {
      const homeWon = m.winner === "home";
      const tie = m.winner === "tie";
      const [w, l, ws, ls] = homeWon
        ? [nameOf(m.homeTeamId), nameOf(m.awayTeamId), m.homeScore, m.awayScore]
        : [nameOf(m.awayTeamId), nameOf(m.homeTeamId), m.awayScore, m.homeScore];
      return tie
        ? { k, v: `${nameOf(m.homeTeamId)} tied ${nameOf(m.awayTeamId)}`, n: `${score(m.homeScore)}–${score(m.awayScore)}` }
        : { k, v: `${w} def. ${l}`, n: `${score(ws)}–${score(ls)}` };
    };

    // --- Season decided: final standings, champion first ---
    if (seasonOver) {
      const ranked = rankFinal(teams, leagueSeason?.champion?.teamId, leagueSeason?.runnerUp?.teamId);
      const items = ranked.map<TickerItem>((t, i) => ({
        k: i === 0 ? "Champion" : ordinal(i + 1),
        v: t.name,
        n: recordOf(t),
      }));
      return { ...base, phase: "offseason", label: `${currentSeason} final`, items: [...items, ...storyItem], week };
    }

    // --- Between weeks: this week's finals ---
    if (allFinal) {
      const closest = [...ms].sort(
        (a, b) => Math.abs(a.homeScore - a.awayScore) - Math.abs(b.homeScore - b.awayScore)
      )[0];
      const items = ms.map((m) => finalItem(m, m === closest ? "Game of the week" : "Final"));
      return { ...base, phase: "week-final", label: `Week ${week} final`, items: [...items, ...storyItem], week };
    }

    // --- In progress or upcoming ---
    const anyScore = ms.some((m) => m.homeScore > 0 || m.awayScore > 0);
    const items: TickerItem[] = ms.map((m) => {
      if (anyScore) {
        return {
          k: "Live",
          v: `${nameOf(m.homeTeamId)} – ${nameOf(m.awayTeamId)}`,
          n: `${score(m.homeScore)}–${score(m.awayScore)}`,
        };
      }
      const hasProj = m.homeProjectedScore !== undefined && m.awayProjectedScore !== undefined;
      return {
        k: "Matchup",
        v: `${nameOf(m.homeTeamId)} vs ${nameOf(m.awayTeamId)}`,
        n: hasProj ? `proj ${score(m.homeProjectedScore!)}–${score(m.awayProjectedScore!)}` : undefined,
      };
    });
    if (previousWeek && previousWeek.length > 0) {
      previousWeek
        .filter((m) => !!m.winner)
        .forEach((m) => items.push(finalItem(m, `Wk ${week - 1} final`)));
    }
    return {
      ...base,
      phase: anyScore ? "week-live" : "week-upcoming",
      label: `Week ${week} · ${anyScore ? "Live" : "Upcoming"}`,
      items: [...items, ...storyItem],
      week,
    };
  }, [currentSeason, draftLoading, teams, isDraftComplete, draftData, matchupData, previousWeek, leagueSeason, latestStory, wirePosts, settings]);
}
