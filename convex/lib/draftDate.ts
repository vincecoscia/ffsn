/**
 * Pure helpers for reasoning about a league season's draft date.
 *
 * ESPN exposes two different "draft date" concepts, both stored verbatim (or
 * near-verbatim) on `leagueSeasons`:
 *
 *  - `draftSettings` (from ESPN's `settings.draftSettings`, `v.any()` on the
 *    schema) carries the SCHEDULED draft - `date` (epoch ms), `type`
 *    ("SNAKE" | "AUCTION" | "OFFLINE" | "AUTOPICK" ...), `timePerSelection`
 *    (seconds; large values mean a slow/rolling draft), `keeperCount`,
 *    `isTradingEnabled`, `orderType`.
 *  - `draftInfo` is written from `draftDetail` and carries the COMPLETION
 *    time, not the scheduled one: `draftDate` is
 *    `draftDetail.completeDate || (draftDetail.drafted ? 1 : undefined)` -
 *    i.e. either a real completion timestamp, or the sentinel `1` once
 *    `drafted` flips true but before ESPN backfills the real completion
 *    instant. `draftInfo.draftDate === 1` must never be treated as a real
 *    instant.
 *
 * No Convex imports here on purpose: this module is pure and standalone so it
 * stays trivially unit-testable and can't create a circular import with
 * convex/contentScheduling.ts (which imports `resolveScheduledDraftDate` and
 * `nextMorningAfter` from here).
 */

/** Anything at or before this is not a plausible scheduled/completed epoch-ms instant (ESPN ships `0` or other sentinels for unset dates). */
const MIN_PLAUSIBLE_EPOCH_MS = Date.UTC(2000, 0, 1);

/**
 * `draftSettings.timePerSelection` (seconds) at or above this marks a
 * slow/asynchronous "rolling" draft - ESPN's own UI calls this an untimed or
 * multi-day draft clock, which can span several days rather than running live
 * in one sitting.
 */
const ROLLING_DRAFT_TIME_PER_SELECTION_SECONDS = 60 * 60; // 1 hour

export interface DraftSettingsInput {
  date?: number;
  type?: string;
  timePerSelection?: number;
  keeperCount?: number;
  isTradingEnabled?: boolean;
  orderType?: string;
  [key: string]: unknown;
}

export interface DraftInfoInput {
  draftDate?: number;
  draftType?: string;
  timePerPick?: number;
  drafted?: boolean;
  inProgress?: boolean;
}

export interface DraftSeasonInput {
  draftSettings?: DraftSettingsInput | null;
  draftInfo?: DraftInfoInput | null;
}

export interface ResolvedDraftDate {
  /** The SCHEDULED draft start (`draftSettings.date`), when it looks like a real epoch-ms timestamp. */
  scheduledAt?: number;
  /** When the draft actually finished (`draftInfo.draftDate`), when it's a real timestamp rather than the `1` sentinel. */
  completedAt?: number;
  /** `draftSettings.type` if present, else `draftInfo.draftType`. */
  type?: string;
  /** True for an OFFLINE draft, or one whose pick clock is >= 1 hour per selection - a slow/rolling draft spread over days. */
  isRolling: boolean;
}

/**
 * Resolves a league season's `draftSettings`/`draftInfo` blobs into one
 * shape distinguishing "scheduled" from "completed", and flagging rolling
 * (slow/offline) drafts. See the module doc for why these two ESPN fields
 * can't just be treated as the same "draft date".
 */
export function resolveScheduledDraftDate(season: DraftSeasonInput): ResolvedDraftDate {
  const draftSettings = season.draftSettings ?? undefined;
  const draftInfo = season.draftInfo ?? undefined;

  const rawScheduled = typeof draftSettings?.date === "number" ? draftSettings.date : undefined;
  const scheduledAt =
    rawScheduled !== undefined && Number.isFinite(rawScheduled) && rawScheduled > MIN_PLAUSIBLE_EPOCH_MS
      ? rawScheduled
      : undefined;

  const rawCompleted = typeof draftInfo?.draftDate === "number" ? draftInfo.draftDate : undefined;
  // draftInfo.draftDate === 1 is the "drafted but no completeDate yet" sentinel, not a real instant.
  const completedAt =
    rawCompleted !== undefined && Number.isFinite(rawCompleted) && rawCompleted > 1 ? rawCompleted : undefined;

  const type = draftSettings?.type ?? draftInfo?.draftType;

  const timePerSelection =
    typeof draftSettings?.timePerSelection === "number" ? draftSettings.timePerSelection : undefined;
  const isRolling =
    type === "OFFLINE" ||
    (timePerSelection !== undefined && timePerSelection >= ROLLING_DRAFT_TIME_PER_SELECTION_SECONDS);

  return { scheduledAt, completedAt, type, isRolling };
}

/** A wall-clock <-> UTC-instant conversion pair, matching the shape of `convertUTCToTimeZone`/`convertTimeZoneToUTC` in convex/contentScheduling.ts. Injected rather than imported so this module stays import-free. */
export type TimeZoneConverter = (date: Date, timeZone: string) => Date;

export interface NextMorningAfterOptions {
  /** Local hour (0-23) of the target print time. */
  hour: number;
  /** Local minute (0-59) of the target print time. Defaults to 0. */
  minute?: number;
  /** The candidate must be at least this many hours after `triggerMs`. */
  minHoursAfter: number;
}

/**
 * The next local `hour:minute` in `timeZone` that is at least
 * `minHoursAfter` hours after `triggerMs`.
 *
 * Used to time `draft_rankings` so it prints "the morning after" a draft
 * finishes: a draft completing at 9pm Tuesday is well short of the 9am floor
 * for that same calendar day, so the next 9am that clears `triggerMs + 6h`
 * is Wednesday's. A draft that wraps at 3am or earlier already has more than
 * 6 hours of runway before that same morning's 9am, so it prints that same
 * day; anything after 3am (up to 9am) pushes to the following morning
 * instead, since the same-day slot would fall inside the 6-hour floor.
 *
 * Implementation walks forward one local calendar day at a time from the
 * trigger's own day (mutating only the day-of-month field, exactly like
 * `nextOccurrenceUtc` in contentScheduling.ts), re-deriving the UTC instant
 * through `convertTimeZoneToUTC` on every step. That makes it immune to DST:
 * a day can be 23 or 25 wall-clock hours long and the loop still lands on
 * the right local `hour:minute`, and it terminates in at most a handful of
 * iterations (bounded by `guard` as a defensive cap, never expected to bind).
 */
export function nextMorningAfter(
  triggerMs: number,
  timeZone: string,
  options: NextMorningAfterOptions,
  convertUTCToTimeZone: TimeZoneConverter,
  convertTimeZoneToUTC: TimeZoneConverter,
): number {
  const { hour } = options;
  const minute = options.minute ?? 0;
  const floorMs = triggerMs + options.minHoursAfter * 60 * 60 * 1000;

  const localTrigger = convertUTCToTimeZone(new Date(triggerMs), timeZone);
  const candidateLocal = new Date(
    localTrigger.getFullYear(),
    localTrigger.getMonth(),
    localTrigger.getDate(),
    hour,
    minute,
    0,
    0,
  );

  let candidateMs = convertTimeZoneToUTC(candidateLocal, timeZone).getTime();

  let guard = 0;
  while (candidateMs < floorMs && guard < 14) {
    candidateLocal.setDate(candidateLocal.getDate() + 1);
    candidateMs = convertTimeZoneToUTC(candidateLocal, timeZone).getTime();
    guard += 1;
  }

  return candidateMs;
}
