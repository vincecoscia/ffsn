/**
 * When to nudge a manager who has not answered (spec §5: two reminders, at half the window
 * and shortly before print). Pure so the schedule is testable; `commentRequests.sendReminder`
 * checks at fire time that the request is still open and unanswered.
 */
const MINUTE = 60 * 1000;

/** No halfway reminder for a window shorter than this: it would land minutes after the ask. */
const MIN_WINDOW_FOR_HALFWAY = 2 * 60 * MINUTE;
/** The final reminder fires this long before print... */
const FINAL_LEAD = 30 * MINUTE;
/** ...and only if it is at least this far after the ask (and after the halfway nudge). */
const MIN_GAP = 45 * MINUTE;

export function reminderTimes(sentAt: number, deadline: number): { halfway?: number; final?: number } {
  const window = deadline - sentAt;
  if (window <= 0) return {};
  const out: { halfway?: number; final?: number } = {};
  if (window >= MIN_WINDOW_FOR_HALFWAY) out.halfway = sentAt + Math.floor(window / 2);
  const final = deadline - FINAL_LEAD;
  if (final - sentAt >= MIN_GAP && (out.halfway === undefined || final - out.halfway >= MIN_GAP)) out.final = final;
  return out;
}
