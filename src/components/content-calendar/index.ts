// The League Pass content calendar (owner ask: a calendar so people don't spend credits on
// content the pass already covers) — display types, formatting, and the pieces the page and
// `ContentGenerator`'s "already scheduled" panel both need.

export type {
  CalendarEntry,
  CalendarEntryStatus,
  CalendarEntryTiming,
  CalendarWeek,
  CalendarWeekPhase,
  ContentCalendarResult,
} from "./types";

export { formatShortDay, formatWeekRange, describeEntryTiming, type EntryTimingDisplay } from "./calendarFormat";
export { CalendarStatusChip, calendarStatusLabel } from "./CalendarStatusChip";
export { EntryRow, type EntryRowProps } from "./EntryRow";
export { WeekSection, type WeekSectionProps } from "./WeekSection";
export { UpNextStrip, type UpNextStripProps } from "./UpNextStrip";
export { UndatedSection, type UndatedSectionProps } from "./UndatedSection";
export { allCalendarEntries, findMatchingCalendarEntry } from "./findCalendarEntry";
