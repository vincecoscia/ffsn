/**
 * Pure fantasy-season calendar math: given a league's parsed matchup-period
 * shape (see `convex/lib/espnSettings.ts`'s `ParsedLeagueSettings`), derive
 * the NFL week numbers each part of the automatic content calendar
 * (`convex/contentScheduling.ts`'s `DEFAULT_SCHEDULES`) should actually fire
 * on for THIS league, instead of the fixed NFL-week numbers baked into that
 * config (`week_9`, `weeks_12_14`, `week_14`, `championship_week` -> NFL
 * week 21) - which only happen to be right for a 14-week regular season with
 * three single-week playoff rounds. Audit finding: every real league was
 * being stored as exactly that shape regardless of its actual ESPN settings
 * (`convex/lib/espnSettings.ts`'s header comment has the production numbers),
 * so every league's automatic calendar was silently wrong except by
 * coincidence.
 *
 * This module is intentionally pure - no imports from `./_generated/api` or
 * any other `convex/*.ts` module that itself references `internal`/`api`
 * (the same rule documented in `./espnClient.ts` and `./espnSettings.ts`).
 * That keeps it safe to import directly from an action (like
 * `contentScheduling.scheduleSeasonAndRelativeContentCron`) and from a plain
 * vitest file with no Convex runtime at all.
 */

/** The subset of a league's parsed ESPN settings this module needs. */
export interface LeagueCalendarInput {
  /**
   * ESPN `scheduleSettings.matchupPeriodCount` - the last REGULAR-season
   * matchup period. Regular-season rounds are always exactly one NFL week
   * each (ESPN has no concept of a multi-week regular-season round), so this
   * number is also the last regular-season NFL week whenever `matchupPeriods`
   * is unavailable.
   */
  regularSeasonMatchupPeriods: number;
  /** ceil(log2(playoffTeamCount)) - how many playoff rounds. */
  playoffRounds: number;
  /** NFL weeks per playoff round (1 or 2). */
  playoffMatchupPeriodLength: number;
  /**
   * Matchup period (as its string key) -> the NFL weeks it spans, ascending
   * (see `convex/lib/espnSettings.ts`'s `parseEspnLeagueSettings`). When
   * present, this is used instead of the `playoffRounds` x
   * `playoffMatchupPeriodLength` arithmetic for anything playoff-round-shaped,
   * so an irregular round (ESPN allows a variable final-round length) is
   * still exact rather than assumed uniform.
   */
  matchupPeriods?: Record<string, number[]>;
}

export interface LeagueCalendar {
  /** The last NFL week of the regular season. */
  lastRegularSeasonWeek: number;
  /** The first NFL week of the playoffs. */
  playoffStartWeek: number;
  /** Every NFL week the LAST (championship) playoff round spans, ascending. */
  championshipWeeks: number[];
  /** The last NFL week of the season - the final entry of `championshipWeeks`. */
  seasonEndWeek: number;
  /** ceil(regularSeasonMatchupPeriods / 2) - the week `mid_season_awards` runs. */
  midSeasonWeek: number;
  /** [reg-2, reg-1, reg] - the three weeks the `playoff_picture` story covers. */
  playoffPictureWeeks: number[];
}

function weeksOfPeriod(
  matchupPeriods: Record<string, number[]> | undefined,
  period: number
): number[] | undefined {
  const weeks = matchupPeriods?.[String(period)];
  return weeks && weeks.length > 0 ? weeks : undefined;
}

/**
 * `[start, end]` (inclusive, expanded to every week in between) of the LAST
 * playoff round, purely from `regularSeasonMatchupPeriods` + `playoffRounds`
 * x `playoffMatchupPeriodLength` - used whenever `matchupPeriods` is absent
 * or doesn't cover the championship period.
 */
function arithmeticChampionshipWeeks(
  lastRegularSeasonWeek: number,
  playoffRounds: number,
  playoffMatchupPeriodLength: number
): number[] {
  const roundsBeforeChampionship = Math.max(0, playoffRounds - 1);
  const start = lastRegularSeasonWeek + roundsBeforeChampionship * playoffMatchupPeriodLength + 1;
  const end = lastRegularSeasonWeek + playoffRounds * playoffMatchupPeriodLength;
  const weeks: number[] = [];
  for (let week = start; week <= end; week++) weeks.push(week);
  return weeks;
}

/**
 * Derives the per-league content calendar (spec: audit finding above).
 *
 * `lastRegularSeasonWeek`/`playoffStartWeek`/`championshipWeeks`/
 * `seasonEndWeek` use the `matchupPeriods` map when it's present, so a
 * multi-week round is counted in real NFL weeks; they fall back to
 * `regularSeasonMatchupPeriods` + `playoffRounds` x
 * `playoffMatchupPeriodLength` arithmetic (a 1:1 matchup-period-to-week
 * mapping) when it is absent. `midSeasonWeek` and `playoffPictureWeeks` are
 * always arithmetic off `regularSeasonMatchupPeriods` alone - regular-season
 * matchup periods are always exactly one NFL week, map or no map.
 */
export function deriveLeagueCalendar(input: LeagueCalendarInput): LeagueCalendar {
  const { regularSeasonMatchupPeriods, playoffRounds, playoffMatchupPeriodLength, matchupPeriods } = input;

  const midSeasonWeek = Math.ceil(regularSeasonMatchupPeriods / 2);
  const playoffPictureWeeks = [
    regularSeasonMatchupPeriods - 2,
    regularSeasonMatchupPeriods - 1,
    regularSeasonMatchupPeriods,
  ];

  const regularSeasonWeeks = weeksOfPeriod(matchupPeriods, regularSeasonMatchupPeriods);
  const lastRegularSeasonWeek = regularSeasonWeeks
    ? Math.max(...regularSeasonWeeks)
    : regularSeasonMatchupPeriods;

  const championshipPeriod = regularSeasonMatchupPeriods + playoffRounds;
  const mappedChampionshipWeeks = weeksOfPeriod(matchupPeriods, championshipPeriod);
  const championshipWeeks = mappedChampionshipWeeks
    ? [...mappedChampionshipWeeks].sort((a, b) => a - b)
    : arithmeticChampionshipWeeks(lastRegularSeasonWeek, playoffRounds, playoffMatchupPeriodLength);

  const firstPlayoffPeriod = regularSeasonMatchupPeriods + 1;
  const mappedFirstPlayoffWeeks = weeksOfPeriod(matchupPeriods, firstPlayoffPeriod);
  const playoffStartWeek = mappedFirstPlayoffWeeks
    ? Math.min(...mappedFirstPlayoffWeeks)
    : lastRegularSeasonWeek + 1;

  const seasonEndWeek =
    championshipWeeks.length > 0
      ? championshipWeeks[championshipWeeks.length - 1]
      : lastRegularSeasonWeek + playoffRounds * playoffMatchupPeriodLength;

  return {
    lastRegularSeasonWeek,
    playoffStartWeek,
    championshipWeeks,
    seasonEndWeek,
    midSeasonWeek,
    playoffPictureWeeks,
  };
}

/**
 * Tolerant reader over an unknown blob shaped like `leagueSeasons.settings`
 * (`v.any()` in the schema - after this task's `espnSync.ts` changes it holds
 * the parsed-settings passthrough fields alongside the legacy ones; before a
 * league's first re-sync it may hold only the legacy fields, or nothing at
 * all). Returns `undefined` when the three numeric inputs
 * {@link deriveLeagueCalendar} needs aren't all present, which callers use as
 * the "fall back to the old NFL-week behaviour" signal.
 */
export function leagueCalendarInputFromSettings(settings: unknown): LeagueCalendarInput | undefined {
  if (typeof settings !== "object" || settings === null) return undefined;
  const record = settings as Record<string, unknown>;

  const regularSeasonMatchupPeriods = record.regularSeasonMatchupPeriods;
  const playoffRounds = record.playoffRounds;
  const playoffMatchupPeriodLength = record.playoffMatchupPeriodLength;

  if (
    typeof regularSeasonMatchupPeriods !== "number" ||
    typeof playoffRounds !== "number" ||
    typeof playoffMatchupPeriodLength !== "number"
  ) {
    return undefined;
  }

  const rawMatchupPeriods = record.matchupPeriods;
  let matchupPeriods: Record<string, number[]> | undefined;
  if (typeof rawMatchupPeriods === "object" && rawMatchupPeriods !== null) {
    const entries = Object.entries(rawMatchupPeriods as Record<string, unknown>).filter(
      (entry): entry is [string, number[]] => Array.isArray(entry[1])
    );
    if (entries.length > 0) matchupPeriods = Object.fromEntries(entries);
  }

  return { regularSeasonMatchupPeriods, playoffRounds, playoffMatchupPeriodLength, matchupPeriods };
}

/** `[12, 13, 14]` -> `"12-14"`; `[16]` -> `"16"`. Range notation for a log line, not a literal list of every week. */
function weekRange(weeks: number[]): string {
  if (weeks.length === 0) return "?";
  const min = Math.min(...weeks);
  const max = Math.max(...weeks);
  return min === max ? String(min) : `${min}-${max}`;
}

/** A single-line human summary of a derived calendar, for the sync/cron logs (spec: log which path was used). */
export function describeLeagueCalendar(
  calendar: LeagueCalendar,
  extra: { regularSeasonMatchupPeriods: number; playoffTeamCount?: number; playoffMatchupPeriodLength: number }
): string {
  const roundLabel = extra.playoffMatchupPeriodLength === 1 ? "1-week rounds" : `${extra.playoffMatchupPeriodLength}-week rounds`;
  const teamsLabel = extra.playoffTeamCount !== undefined ? `${extra.playoffTeamCount} playoff teams` : "unknown playoff team count";
  return (
    `${extra.regularSeasonMatchupPeriods}-week regular season, ${teamsLabel}, ${roundLabel} -> ` +
    `playoff picture wks ${weekRange(calendar.playoffPictureWeeks)}, ` +
    `awards wk ${calendar.midSeasonWeek}, ` +
    `hall of shame wk ${calendar.lastRegularSeasonWeek}, ` +
    `championship wks ${weekRange(calendar.championshipWeeks)}, ` +
    `recap after wk ${calendar.seasonEndWeek}`
  );
}

/** The subset of a league's settings `matchupPeriodIdsFromSettings` needs. */
export interface MatchupPeriodIdSource {
  regularSeasonMatchupPeriods?: number;
  playoffRounds?: number;
  playoffMatchupPeriodLength?: number;
  /** Legacy count field (playoffRounds x playoffMatchupPeriodLength) - only used by the tier-3 fallback. */
  playoffWeeks?: number;
  matchupPeriods?: Record<string, number[]>;
}

/**
 * The full list of ESPN matchup period ids a sync should request data for
 * (used to build the `X-Fantasy-Filter` header in `convex/espnSync.ts` and
 * the roster-fetch period list in `convex/matchupRosters.ts`). Three-tier
 * fallback (audit finding: every league used to be synced as a hard-coded 14
 * regular + 4 playoff weeks, see this module's header comment):
 *  1. The exact period ids from `matchupPeriods`'s keys, when present -
 *     correct even for an irregular final round.
 *  2. `regularSeasonMatchupPeriods + playoffRounds x playoffMatchupPeriodLength`
 *     when the map isn't available yet but the parsed counts are (a
 *     deliberately generous NFL-week count rather than the smaller true
 *     period count - safe to over-request, since ESPN just returns nothing
 *     for a period id that doesn't exist).
 *  3. `(regularSeasonMatchupPeriods || 14) + (playoffWeeks || 4)` - the
 *     historic default, for a league that hasn't been synced with the parser
 *     yet.
 */
export function matchupPeriodIdsFromSettings(settings: MatchupPeriodIdSource | undefined): number[] {
  const mapKeys = settings?.matchupPeriods
    ? Object.keys(settings.matchupPeriods)
        .map(Number)
        .filter((n) => Number.isFinite(n))
    : [];
  if (mapKeys.length > 0) return mapKeys.sort((a, b) => a - b);

  if (
    typeof settings?.regularSeasonMatchupPeriods === "number" &&
    typeof settings?.playoffRounds === "number" &&
    typeof settings?.playoffMatchupPeriodLength === "number"
  ) {
    const total =
      settings.regularSeasonMatchupPeriods + settings.playoffRounds * settings.playoffMatchupPeriodLength;
    return Array.from({ length: total }, (_, i) => i + 1);
  }

  const regularSeasonWeeks = settings?.regularSeasonMatchupPeriods || 14;
  const playoffWeeks = settings?.playoffWeeks || 4;
  const total = regularSeasonWeeks + playoffWeeks;
  return Array.from({ length: total }, (_, i) => i + 1);
}
