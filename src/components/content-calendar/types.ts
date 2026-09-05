// Local mirror of `contentCalendar.getContentCalendar`'s return shape (owner ask: a content
// calendar so people don't spend credits on a story the League Pass already has coming).
// Hand-written rather than inferred — matches the house pattern in
// `content-schedule/WeeklyContentCard.tsx` (`ContentScheduleData`) — so these components keep
// their types no matter what shape `api` happens to be mid-refactor.

export type CalendarEntryStatus =
  | "projected"
  | "pending"
  | "generating"
  | "batched"
  | "published"
  | "failed"
  | "cancelled"
  | "backlogged"
  | "skipped";

export type CalendarEntryTiming = "exact" | "estimated" | "event";

export interface CalendarEntry {
  key: string;
  /** Slug — label it with `contentTypeLabel()` from the broadcast kit. */
  contentType: string;
  /** Writer slug — name/avatar via the broadcast kit's `personaRoster`. */
  persona: string;
  /** The week this story is ABOUT (not necessarily the week it prints in). */
  week: number | null;
  /** Print instant, ms. Null for an event story with no row yet. */
  at: number | null;
  timing: CalendarEntryTiming;
  status: CalendarEntryStatus;
  scheduledContentId: string | null;
  /** `aiContent` id once published. */
  articleId: string | null;
  note: string | null;
  /** Sam Ortega reaches out for comment before this story. */
  interviews: boolean;
}

export type CalendarWeekPhase = "regular" | "playoffs" | "championship";

export interface CalendarWeek {
  week: number;
  /** NFL week boundary, ms — Tuesday 00:00 UTC. */
  start: number;
  /** NFL week boundary, ms — the following Tuesday 00:00 UTC. */
  end: number;
  phase: CalendarWeekPhase;
  /** Sorted by `at`. */
  entries: CalendarEntry[];
}

export interface ContentCalendarResult {
  season: number;
  /** League print clock, e.g. "America/New_York". */
  timezone: string;
  /** League-wide automatic programming switch. */
  contentEnabled: boolean;
  /** Whether the League Pass covers the automated stories. */
  passActive: boolean;
  /** NFL week now; null before kickoff / after the season. */
  currentWeek: number | null;
  weeks: CalendarWeek[];
  /** Event-driven stories and pre-season pieces with no fixed week. */
  undated: CalendarEntry[];
}
