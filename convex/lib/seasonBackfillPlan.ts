/**
 * Pure plan builder for a season backfill run (`convex/seasonBackfill.ts`):
 * given a league's calendar shape and a season's first Tuesday, lay out every
 * automatic-content article that season should have produced, in print order,
 * and mark which ones already exist, which can't be written at all (no data
 * source for them), and which are ready to go.
 *
 * No Convex imports here on purpose, matching the convention set by
 * `convex/lib/leagueCalendar.ts` and `convex/lib/draftDate.ts` - this stays
 * trivially unit-testable with plain vitest (no `convex-test` harness) and
 * safe to import into `convex/seasonBackfill.ts` without the recursive-`api`
 * risk a value import of an `internal`-referencing module like
 * `convex/contentScheduling.ts` would carry (see the repo-wide gotcha in
 * project memory). The wall-clock <-> UTC-instant conversion pair below is
 * therefore a deliberate DUPLICATE of `convertUTCToTimeZone`/
 * `convertTimeZoneToUTC` in `convex/contentScheduling.ts` (same algorithm,
 * same DST handling) rather than an import of it.
 */

import type { LeagueCalendar } from "./leagueCalendar";

/* -------------------------------------------------------------------------- *
 * Wall-clock <-> UTC instant (duplicated from convex/contentScheduling.ts -
 * see the file header for why)
 * -------------------------------------------------------------------------- */

const WALL_CLOCK_PART_TYPES = ["year", "month", "day", "hour", "minute", "second"] as const;

function wallClockPartsAt(
  instantMs: number,
  timeZone: string
): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(instantMs));

  const read = (type: (typeof WALL_CLOCK_PART_TYPES)[number]) => {
    const part = parts.find((p) => p.type === type);
    if (!part) throw new Error(`Missing "${type}" in formatted parts for ${timeZone}`);
    return parseInt(part.value, 10);
  };

  // Some ICU builds render midnight as hour 24 under hour12:false.
  const hour = read("hour") % 24;
  return { year: read("year"), month: read("month"), day: read("day"), hour, minute: read("minute"), second: read("second") };
}

function zoneOffsetMsAt(instantMs: number, timeZone: string): number {
  const p = wallClockPartsAt(instantMs, timeZone);
  const asIfUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asIfUTC - Math.floor(instantMs / 1000) * 1000;
}

/** UTC instant -> a Date carrying that instant's wall clock in `timeZone`. */
export function convertUTCToTimeZone(dateUTC: Date, timeZone: string): Date {
  try {
    const p = wallClockPartsAt(dateUTC.getTime(), timeZone);
    return new Date(p.year, p.month - 1, p.day, p.hour, p.minute, p.second, 0);
  } catch {
    return new Date(dateUTC.getTime());
  }
}

/** A Date carrying a wall clock in `timeZone` -> the UTC instant it names. */
export function convertTimeZoneToUTC(dateInTZ: Date, timeZone: string): Date {
  const wallAsUTC = Date.UTC(
    dateInTZ.getFullYear(),
    dateInTZ.getMonth(),
    dateInTZ.getDate(),
    dateInTZ.getHours(),
    dateInTZ.getMinutes(),
    dateInTZ.getSeconds(),
    dateInTZ.getMilliseconds()
  );
  try {
    let instant = wallAsUTC - zoneOffsetMsAt(wallAsUTC, timeZone);
    instant = wallAsUTC - zoneOffsetMsAt(instant, timeZone);
    instant = wallAsUTC - zoneOffsetMsAt(instant, timeZone);
    if (!Number.isFinite(instant)) throw new Error("Non-finite instant");
    return new Date(instant);
  } catch {
    return new Date(wallAsUTC);
  }
}

/** Midnight local time on an ISO `"YYYY-MM-DD"` date, in `timeZone`, as a UTC instant. Used to resolve the `NFL_WEEK1_TUESDAY` fallback table (`convex/seasonBackfill.ts`). */
export function localMidnightUtc(isoDate: string, timeZone: string): number {
  const [year, month, day] = isoDate.split("-").map((part) => parseInt(part, 10));
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    throw new Error(`Invalid ISO date "${isoDate}", expected "YYYY-MM-DD"`);
  }
  return convertTimeZoneToUTC(new Date(year, month - 1, day, 0, 0, 0, 0), timeZone).getTime();
}

/* -------------------------------------------------------------------------- *
 * The plan
 * -------------------------------------------------------------------------- */

export interface SeasonBackfillPlanInput {
  seasonId: number;
  calendar: LeagueCalendar;
  /** UTC ms of the season's first Tuesday, 00:00 local in `timezone`. */
  week1Tuesday: number;
  timezone: string;
  /** Every article already on record for this league/season, from `aiContent`. */
  existing: Array<{ contentType: string; week?: number }>;
  /** Narrows the plan to these content types, when given. */
  types?: string[];
  /** Narrows the plan to these weeks, when given. */
  weeks?: number[];
  /** Whether a real trade happened this season (the `trades` table is normally empty - see the file header on `convex/seasonBackfill.ts`). */
  hasTradesForSeason: boolean;
  /** Whether `seasonId` is the league's CURRENT season (only `season_welcome` cares). */
  isCurrentSeason: boolean;
}

export interface SeasonBackfillPlanItem {
  /** Stable position in the FULL, unfiltered, printAt-ordered plan - what `runSeasonBackfill`'s `startIndex` resumes from. */
  index: number;
  contentType: string;
  week: number;
  /** The week `getLeagueDataForAI`'s `asOf.week` should be for this article. */
  asOfWeek: number;
  printAt: number;
  status: "planned" | "exists" | "unsupported";
  reason?: string;
}

/** Types that can occur more than once a season - existence is checked type AND week; every other type is a singleton and matches on type alone. */
const WEEK_SCOPED_TYPES = new Set(["weekly_preview", "weekly_recap", "power_rankings", "playoff_picture"]);

function alreadyExists(
  existing: SeasonBackfillPlanInput["existing"],
  contentType: string,
  week: number
): boolean {
  return existing.some((row) => {
    if (row.contentType !== contentType) return false;
    return WEEK_SCOPED_TYPES.has(contentType) ? row.week === week : true;
  });
}

/** Local day-of-week offsets from `week1Tuesday` (which IS a Tuesday). */
const TUE = 0;
const WED = 1;
const THU = 2;

type RawItem = Omit<SeasonBackfillPlanItem, "index">;

/**
 * Lays out every automatic content type across a season (spec: brief A
 * deliverable 4). Mirrors `convex/contentScheduling.ts`'s `DEFAULT_SCHEDULES`
 * timing (Tuesday/Wednesday/Thursday mornings) but computed against the
 * SEASON's actual weeks instead of the wall clock, since every article here
 * is backdated.
 */
export function buildSeasonBackfillPlan(input: SeasonBackfillPlanInput): SeasonBackfillPlanItem[] {
  const { calendar, week1Tuesday, timezone, existing, hasTradesForSeason, isCurrentSeason } = input;
  const seasonEndWeek = calendar.seasonEndWeek;

  /** "week w" -> its local Tuesday 00:00, as a UTC instant. */
  const printAtForWeek = (week: number, dayOffset: number, hour: number, minute = 0): number => {
    const localWeek1 = convertUTCToTimeZone(new Date(week1Tuesday), timezone);
    const local = new Date(localWeek1.getFullYear(), localWeek1.getMonth(), localWeek1.getDate());
    local.setDate(local.getDate() + (week - 1) * 7 + dayOffset);
    local.setHours(hour, minute, 0, 0);
    return convertTimeZoneToUTC(local, timezone).getTime();
  };

  const raw: RawItem[] = [];

  const withStatus = (contentType: string, week: number, asOfWeek: number, printAt: number): RawItem => ({
    contentType,
    week,
    asOfWeek,
    printAt,
    status: alreadyExists(existing, contentType, week) ? "exists" : "planned",
  });

  // weekly_preview: printed Thursday of the week it previews, off last week's results.
  for (let w = 1; w <= seasonEndWeek; w++) {
    raw.push(withStatus("weekly_preview", w, Math.max(0, w - 1), printAtForWeek(w, THU, 9)));
  }

  // weekly_recap: printed the Tuesday after the week it recaps.
  for (let w = 1; w <= seasonEndWeek; w++) {
    raw.push(withStatus("weekly_recap", w, w, printAtForWeek(w + 1, TUE, 9)));
  }

  // power_rankings: printed the Wednesday after the week it ranks off.
  for (let w = 1; w <= seasonEndWeek; w++) {
    raw.push(withStatus("power_rankings", w, w, printAtForWeek(w + 1, WED, 9)));
  }

  // mid_season_awards: one shot, the Wednesday after the league's midpoint.
  raw.push(
    withStatus(
      "mid_season_awards",
      calendar.midSeasonWeek,
      calendar.midSeasonWeek,
      printAtForWeek(calendar.midSeasonWeek + 1, WED, 9)
    )
  );

  // playoff_picture: one per playoffPictureWeeks entry, Thursday noon, off the prior week's results.
  for (const w of calendar.playoffPictureWeeks) {
    raw.push(withStatus("playoff_picture", w, Math.max(0, w - 1), printAtForWeek(w, THU, 12)));
  }

  // season_recap: one shot, the Tuesday after the season's last week.
  raw.push(
    withStatus("season_recap", seasonEndWeek, seasonEndWeek, printAtForWeek(seasonEndWeek + 1, TUE, 9))
  );

  // trade_analysis: only when a real trade happened this season - the `trades`
  // table is normally empty (see convex/seasonBackfill.ts's header), so this
  // is "unsupported" in practice. When it IS supported, no per-trade date is
  // available to this pure planner, so one item is planned at the league's
  // last regular-season week (a deliberate placeholder - see the header on
  // `convex/seasonBackfill.ts` for why a real trade date isn't threaded
  // through here).
  if (hasTradesForSeason) {
    const week = calendar.lastRegularSeasonWeek;
    raw.push(withStatus("trade_analysis", week, week, printAtForWeek(week + 1, TUE, 9)));
  } else {
    raw.push({
      contentType: "trade_analysis",
      week: 1,
      asOfWeek: 0,
      printAt: printAtForWeek(1, TUE, 9),
      status: "unsupported",
      reason: "no trades synced for this season",
    });
  }

  // waiver_wire_report: never plannable - ESPN no longer serves the
  // free-agent pool as it stood at a past week.
  raw.push({
    contentType: "waiver_wire_report",
    week: 1,
    asOfWeek: 0,
    printAt: printAtForWeek(1, TUE, 9),
    status: "unsupported",
    reason: "needs the free-agent pool at that week, which ESPN no longer serves",
  });

  // season_welcome: only makes sense for the CURRENT season - its prepared
  // query always reads the league's current season regardless of any forced
  // period, so backfilling a past season can never produce a correct one.
  if (isCurrentSeason) {
    raw.push(withStatus("season_welcome", 1, 0, printAtForWeek(1, TUE, 9)));
  }

  const sorted = [...raw].sort((a, b) => a.printAt - b.printAt);
  const withIndex: SeasonBackfillPlanItem[] = sorted.map((item, index) => ({ ...item, index }));

  const typeFilter = input.types && input.types.length > 0 ? new Set(input.types) : undefined;
  const weekFilter = input.weeks && input.weeks.length > 0 ? new Set(input.weeks) : undefined;

  return withIndex.filter(
    (item) => (!typeFilter || typeFilter.has(item.contentType)) && (!weekFilter || weekFilter.has(item.week))
  );
}
