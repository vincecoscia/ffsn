/**
 * Week-1 preview scheduling gate (owner directive, 2026-09-03, verbatim): "the week 1 preview
 * needs to happen after the draft has occurred and about 3 days before the season starts. If
 * both of those conditions haven't been met, don't schedule that article."
 *
 * Every other `weekly_preview` row is stamped for that week's own Thursday (see
 * `DEFAULT_SCHEDULES.weekly_preview` in `convex/contentScheduling.ts`), which for week 1 lands on
 * kickoff day itself - too late for a preview, and before week 1 the draft may not even have
 * happened yet. This is the dedicated gate both `scheduleWeeklyContentCron` and
 * `triggerEventBasedContent`'s `draft_completed` branch defer to instead.
 *
 * Pure - no `ctx.db`, no wall clock read internally (`now` is always passed in) - so it is safe
 * to import as a value from `convex/contentScheduling.ts` and from a plain vitest file (see
 * `convex/lib/playoffs.ts`'s header for why that matters in this repo).
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const FIVE_MINUTES_MS = 5 * 60 * 1000;

/** How many days before kickoff the window opens - the owner's "about 3 days before." */
export const WEEK_ONE_PREVIEW_LEAD_DAYS = 3;

export interface WeekOnePreviewGateInput {
  now: number;
  /** `leagueSeasons.draftInfo.drafted === true` for the target season. */
  drafted: boolean;
  /** `leagueSeasons.draftInfo.inProgress === true` - a draft can be "drafted" and still
   * in-progress on ESPN's own flag during the transition; treated the same as not drafted. */
  draftInProgress: boolean;
  /** `nflSeasons.phases.regularSeason.start` for the target season - kickoff. */
  kickoffAt: number;
  /** `nflSeasons.weekBoundaries[week 1].start` for the target season, when known - a defensive
   * lower bound so the window never opens before week 1 has even nominally begun, even for a
   * league whose `leadDays` would otherwise push `windowStart` earlier than that. */
  week1TuesdayAt?: number;
  /** Days before kickoff the window opens. Defaults to the owner's "about 3 days." */
  leadDays?: number;
}

export type WeekOnePreviewReason = "not_drafted" | "too_early" | "too_late" | "ready";

export interface WeekOnePreviewDecision {
  schedule: boolean;
  /** Only set when `schedule` is true - `now + 5 minutes`, so the row prints promptly once both
   * conditions hold rather than waiting for some other fixed time of day. */
  scheduledFor?: number;
  reason: WeekOnePreviewReason;
}

export function weekOnePreviewDecision(input: WeekOnePreviewGateInput): WeekOnePreviewDecision {
  const leadDays = input.leadDays ?? WEEK_ONE_PREVIEW_LEAD_DAYS;
  const windowStart = Math.max(input.kickoffAt - leadDays * DAY_MS, input.week1TuesdayAt ?? -Infinity);

  if (!input.drafted || input.draftInProgress) {
    return { schedule: false, reason: "not_drafted" };
  }
  if (input.now < windowStart) {
    return { schedule: false, reason: "too_early" };
  }
  if (input.now >= input.kickoffAt) {
    return { schedule: false, reason: "too_late" };
  }
  return { schedule: true, scheduledFor: input.now + FIVE_MINUTES_MS, reason: "ready" };
}
