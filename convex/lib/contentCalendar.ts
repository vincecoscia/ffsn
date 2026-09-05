/**
 * The league's content calendar: every story the League Pass will print this season, week
 * by week, projected from the schedule rules and overlaid with the rows that already exist
 * (owner ask, 2026-09-05: "a content calendar so people don't use credits on content that
 * is already included in the league pass").
 *
 * Pure: `contentCalendar.getContentCalendar` loads the inputs and calls
 * `projectContentCalendar`. The projection mirrors the schedulers in
 * convex/contentScheduling.ts (weekly slots, season-based triggers, the draft-relative mock
 * draft, event types) and the interview rules in convex/commentRequests.ts (a recap waits
 * for Monday night, reaches out at 07:00 and prints a day later so managers get their 24h).
 */
import { deriveLeagueCalendar, type LeagueCalendar } from "./leagueCalendar";
import { COMMENT_WINDOWS_MS, LOOKBACK_INTERVIEW_TYPES } from "./interviewees";
import { alignPrintTime, nextWallClockAtOrAfter, nextWeekdayWallClockAtOrAfter, wallClockOnLocalDay } from "./printTime";
import { weeklyTargetWeekInSeason } from "./seasonWindow";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Quiet hours end: the earliest a lookback story reaches out (convex/commentRequests.ts). */
const INTERVIEW_SEND_HOUR = 7;

export type CalendarTiming = "exact" | "estimated" | "event";
export type CalendarStatus =
  | "projected"
  | "pending"
  | "generating"
  | "batched"
  | "published"
  | "failed"
  | "cancelled"
  | "backlogged"
  | "skipped";

export interface CalendarEntry {
  /** Stable key: `${contentType}:${week ?? "event"}:${at ?? "undated"}` or the row id. */
  key: string;
  contentType: string;
  /** Writer slug the schedule prefers; the row's own persona is not stored, so this is the rule's. */
  persona: string;
  /** The week the story is ABOUT (a Tuesday recap of week 3 sits in week 3). */
  week: number | null;
  /** Print instant, ms; null for an event story with no row yet. */
  at: number | null;
  timing: CalendarTiming;
  status: CalendarStatus;
  scheduledContentId: string | null;
  articleId: string | null;
  note: string | null;
  /** True when Sam reaches out for comment before this story prints. */
  interviews: boolean;
}

export interface CalendarWeek {
  week: number;
  start: number;
  end: number;
  phase: "regular" | "playoffs" | "championship";
  entries: CalendarEntry[];
}

export interface ContentCalendar {
  weeks: CalendarWeek[];
  undated: CalendarEntry[];
}

export interface CalendarRule {
  contentType: string;
  enabled: boolean;
  timezone?: string;
  preferredPersona?: string;
  schedule: {
    type: string;
    dayOfWeek?: number;
    hour?: number;
    minute?: number;
    trigger?: string;
    delayDays?: number;
    delayMinutes?: number;
    relativeTo?: string;
    offsetDays?: number;
  };
}

export interface CalendarRow {
  id: string;
  contentType: string;
  scheduledFor: number;
  status: string;
  week?: number;
  generatedContentId?: string;
}

export interface WeekBoundary {
  week: number;
  start: number;
  end: number;
  isPlayoffs: boolean;
}

export interface CalendarInput {
  now: number;
  timezone: string;
  weekBoundaries: WeekBoundary[];
  /** NFL regular-season start, for the season welcome. */
  regularSeasonStart: number;
  /** Parsed from the league's synced settings; undefined before the first sync. */
  leagueCalendar?: LeagueCalendar;
  /** The league's last week (championship); `FALLBACK_SEASON_END_WEEK` when unknown. */
  seasonEndWeek: number;
  draftScheduledAt?: number;
  drafted: boolean;
  rules: CalendarRule[];
  rows: CalendarRow[];
  /** `defaultPersonaFor(contentType)` for rules with no preferred writer. */
  defaultPersona: (contentType: string) => string;
}

const EVENT_NOTES: Record<string, string> = {
  draft_rankings: "About six hours after the draft ends. Every manager is asked for comment first.",
  trade_analysis: "About six hours after a trade goes through. Both sides are asked for comment first.",
  rivalry_week_special: "When the desk spots a rivalry matchup.",
  emergency_hot_takes: "When something breaks.",
  custom_roast: "On request.",
};

function statusOf(row: CalendarRow): CalendarStatus {
  switch (row.status) {
    case "pending":
    case "generating":
    case "batched":
    case "published":
    case "failed":
    case "cancelled":
    case "backlogged":
      return row.status;
    case "completed":
      return "published";
    default:
      return "pending";
  }
}

function slotInWeek(rule: CalendarRule, week: WeekBoundary, timezone: string): number | null {
  const { dayOfWeek, hour, minute } = rule.schedule;
  if (dayOfWeek === undefined || hour === undefined || minute === undefined) return null;
  const slot = nextWeekdayWallClockAtOrAfter(week.start, dayOfWeek, hour, minute, timezone);
  return slot <= week.end + DAY_MS ? slot : null;
}

/**
 * Where a lookback story with an interview window actually prints: the requests go out
 * once the week is final and never before 07:00, and the article never prints before
 * send + window (convex/commentRequests.ts). For a Tuesday 11:00 recap that is Wednesday
 * 11:00.
 */
function interviewAdjustedPrint(
  rule: CalendarRule,
  slot: number,
  week: WeekBoundary,
  timezone: string
): { at: number; timing: CalendarTiming; note: string | null } {
  const window = COMMENT_WINDOWS_MS[rule.contentType];
  if (window === undefined || !LOOKBACK_INTERVIEW_TYPES.has(rule.contentType)) {
    return { at: slot, timing: "exact", note: null };
  }
  // The week ends Monday night; the earliest send is 07:00 on the following day.
  const earliestSend = nextWallClockAtOrAfter(week.end, INTERVIEW_SEND_HOUR, 0, timezone);
  const sendAt = Math.max(slot - window, earliestSend);
  if (slot - sendAt >= window) return { at: slot, timing: "exact", note: null };
  const at = alignPrintTime(sendAt + window, rule.schedule, timezone);
  const hours = Math.round(window / 3_600_000);
  return {
    at,
    timing: "estimated",
    note: `Waits for Monday night to finish, then asks every manager for comment with a ${hours}-hour window, so it prints the next day.`,
  };
}

function phaseOf(week: number, calendar: LeagueCalendar | undefined, seasonEndWeek: number): CalendarWeek["phase"] {
  if (calendar) {
    if (calendar.championshipWeeks.includes(week)) return "championship";
    if (week > calendar.lastRegularSeasonWeek) return "playoffs";
    return "regular";
  }
  return week === seasonEndWeek ? "championship" : "regular";
}

export function projectContentCalendar(input: CalendarInput): ContentCalendar {
  const tz = input.timezone;
  const boundaries = [...input.weekBoundaries]
    .filter((w) => w.week >= 1 && w.week <= input.seasonEndWeek)
    .sort((a, b) => a.week - b.week);
  const boundaryOf = (week: number) => boundaries.find((w) => w.week === week);

  // Weekly slots are walked one week past the league's last week: a lookback story about
  // the championship week fires in the following week's slot (the Tuesday after).
  const slotBoundaries = [...input.weekBoundaries].filter((w) => w.week >= 1).sort((a, b) => a.week - b.week);
  const lastSlot = slotBoundaries[slotBoundaries.length - 1];
  if (lastSlot && lastSlot.week <= input.seasonEndWeek) {
    const length = lastSlot.end - lastSlot.start + 1;
    slotBoundaries.push({ week: lastSlot.week + 1, start: lastSlot.end + 1, end: lastSlot.end + length, isPlayoffs: lastSlot.isPlayoffs });
  }

  const weeks: CalendarWeek[] = boundaries.map((w) => ({
    week: w.week,
    start: w.start,
    end: w.end,
    phase: phaseOf(w.week, input.leagueCalendar, input.seasonEndWeek),
    entries: [],
  }));
  const undated: CalendarEntry[] = [];
  const rows = [...input.rows];

  const personaFor = (rule: CalendarRule) => rule.preferredPersona ?? input.defaultPersona(rule.contentType);

  /** Attach a row to a projected entry, or leave it for the row pass below. */
  const claimRow = (contentType: string, week: number | null, at: number | null): CalendarRow | undefined => {
    const index = rows.findIndex((row) => {
      if (row.contentType !== contentType) return false;
      if (week !== null && row.week !== undefined) return row.week === week;
      if (at === null) return false;
      return Math.abs(row.scheduledFor - at) < 2 * DAY_MS;
    });
    if (index < 0) return undefined;
    return rows.splice(index, 1)[0];
  };

  const push = (
    week: number | null,
    entry: Omit<CalendarEntry, "key" | "status" | "scheduledContentId" | "articleId"> & { at: number | null }
  ) => {
    const row = claimRow(entry.contentType, week, entry.at);
    const full: CalendarEntry = {
      key: row ? row.id : `${entry.contentType}:${week ?? "event"}:${entry.at ?? "undated"}`,
      ...entry,
      at: row ? row.scheduledFor : entry.at,
      timing: row ? "exact" : entry.timing,
      status: row ? statusOf(row) : entry.at !== null && entry.at < input.now ? "skipped" : "projected",
      scheduledContentId: row ? row.id : null,
      articleId: row?.generatedContentId ?? null,
      note: row ? (row.status === "published" || row.status === "completed" ? null : entry.note) : entry.at !== null && entry.at < input.now ? "This slot went by without a story." : entry.note,
    };
    const target = week !== null ? weeks.find((w) => w.week === week) : undefined;
    if (target) target.entries.push(full);
    else undated.push(full);
  };

  for (const rule of input.rules) {
    if (!rule.enabled) continue;
    const persona = personaFor(rule);
    const ruleTz = rule.timezone && rule.timezone.trim().length > 0 ? rule.timezone : tz;
    const interviews = COMMENT_WINDOWS_MS[rule.contentType] !== undefined;
    const s = rule.schedule;

    if (s.type === "weekly") {
      for (const w of slotBoundaries) {
        const slot = slotInWeek(rule, w, ruleTz);
        if (slot === null) continue;
        const targetWeek = LOOKBACK_INTERVIEW_TYPES.has(rule.contentType) ? w.week - 1 : w.week;
        if (!weeklyTargetWeekInSeason({ contentType: rule.contentType, targetWeek, seasonEndWeek: input.seasonEndWeek }).inSeason) continue;
        const storyWeek = boundaryOf(targetWeek);
        const adjusted = interviewAdjustedPrint(rule, slot, storyWeek ?? w, ruleTz);
        let note = adjusted.note;
        let timing = adjusted.timing;
        if (rule.contentType === "weekly_preview" && targetWeek === 1) {
          timing = "estimated";
          note = "Only once the league has drafted, about three days before kickoff.";
        }
        push(targetWeek, { contentType: rule.contentType, persona, week: targetWeek, at: adjusted.at, timing, note, interviews });
      }
      continue;
    }

    if (s.type === "season_based") {
      const cal = input.leagueCalendar;
      const trigger = s.trigger ?? "";
      const hour = s.hour ?? 9;
      const minute = s.minute ?? 0;
      const delayDays = s.delayDays ?? 0;
      const atWeekSlot = (w: WeekBoundary) =>
        s.dayOfWeek !== undefined
          ? nextWeekdayWallClockAtOrAfter(w.start, s.dayOfWeek, hour, minute, ruleTz)
          : wallClockOnLocalDay(w.start + delayDays * DAY_MS, hour, minute, ruleTz);

      const weeksFor = (): number[] => {
        switch (rule.contentType) {
          case "mid_season_awards":
            if (cal) return [cal.midSeasonWeek];
            break;
          case "hall_of_shame":
            if (cal) return [cal.lastRegularSeasonWeek];
            break;
          case "playoff_picture":
            if (cal) return cal.playoffPictureWeeks;
            break;
          case "championship_manifesto":
            if (cal) return [cal.championshipWeeks[0]];
            break;
          case "season_recap":
            return [input.seasonEndWeek];
        }
        const single = /^week_(\d+)$/.exec(trigger);
        if (single) return [Number(single[1])];
        const range = /^weeks_(\d+)_(\d+)$/.exec(trigger);
        if (range) {
          const out: number[] = [];
          for (let w = Number(range[1]); w <= Number(range[2]); w++) out.push(w);
          return out;
        }
        if (trigger === "championship_week") return [input.seasonEndWeek];
        return [];
      };

      if (trigger === "season_start") {
        const at = wallClockOnLocalDay(input.regularSeasonStart + delayDays * DAY_MS, hour, minute, ruleTz);
        push(null, { contentType: rule.contentType, persona, week: null, at, timing: "exact", note: "Before kickoff.", interviews });
        continue;
      }

      for (const week of weeksFor()) {
        const w = boundaryOf(week);
        if (!w) continue;
        const at =
          rule.contentType === "season_recap"
            ? wallClockOnLocalDay(w.end + Math.max(1, delayDays) * DAY_MS, hour, minute, ruleTz)
            : atWeekSlot(w);
        // The slot is whatever the league's rule says (offset days and hour are the
        // commissioner's); no fixed wording, the time speaks for itself.
        push(week, { contentType: rule.contentType, persona, week, at, timing: "exact", note: null, interviews });
      }
      continue;
    }

    if (s.type === "relative" && s.relativeTo === "draft_date") {
      if (input.drafted || input.draftScheduledAt === undefined) continue;
      const at = wallClockOnLocalDay(input.draftScheduledAt + (s.offsetDays ?? 0) * DAY_MS, s.hour ?? 9, s.minute ?? 0, ruleTz);
      push(null, { contentType: rule.contentType, persona, week: null, at, timing: "exact", note: "A week before the draft.", interviews });
      continue;
    }

    if (s.type === "event_triggered") {
      push(null, {
        contentType: rule.contentType,
        persona,
        week: null,
        at: null,
        timing: "event",
        note: EVENT_NOTES[rule.contentType] ?? "When it happens.",
        interviews,
      });
    }
  }

  // Rows nothing projected claimed: manual schedules, event rows, older configurations.
  for (const row of rows) {
    const rule = input.rules.find((r) => r.contentType === row.contentType);
    const persona = rule ? personaFor(rule) : input.defaultPersona(row.contentType);
    const week = row.week ?? boundaries.find((w) => row.scheduledFor >= w.start && row.scheduledFor <= w.end)?.week ?? null;
    const entry: CalendarEntry = {
      key: row.id,
      contentType: row.contentType,
      persona,
      week,
      at: row.scheduledFor,
      timing: "exact",
      status: statusOf(row),
      scheduledContentId: row.id,
      articleId: row.generatedContentId ?? null,
      note: null,
      interviews: COMMENT_WINDOWS_MS[row.contentType] !== undefined,
    };
    const target = week !== null ? weeks.find((w) => w.week === week) : undefined;
    if (target) target.entries.push(entry);
    else undated.push(entry);
  }

  for (const w of weeks) w.entries.sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity));
  undated.sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity));
  return { weeks, undated };
}

export { deriveLeagueCalendar };
