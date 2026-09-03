/**
 * `convex/lib/weekOneGate.ts` - pure function, no Convex runtime needed.
 *
 * Fixture is the real 2026 prod dates from brief-preview-common.md's audit: draft completes the
 * evening of 2026-09-07, kickoff is 2026-09-10T00:00:00Z as stored on `nflSeasons`, so the
 * 3-day-lead window opens 2026-09-07T00:00:00Z.
 */
import { describe, expect, it } from "vitest";
import { weekOnePreviewDecision } from "../convex/lib/weekOneGate";

const KICKOFF = Date.parse("2026-09-10T00:00:00Z");
const WINDOW_START = Date.parse("2026-09-07T00:00:00Z"); // kickoff - 3 days
const DRAFT_COMPLETED_AT = Date.parse("2026-09-07T23:00:00Z"); // "draft 2026-09-07 evening"

describe("weekOnePreviewDecision", () => {
  it("refuses when the draft has not happened yet, even inside the window", () => {
    const decision = weekOnePreviewDecision({
      now: DRAFT_COMPLETED_AT,
      drafted: false,
      draftInProgress: false,
      kickoffAt: KICKOFF,
    });
    expect(decision).toEqual({ schedule: false, reason: "not_drafted" });
  });

  it("refuses while the draft is still in progress, even once ESPN has set `drafted`", () => {
    const decision = weekOnePreviewDecision({
      now: DRAFT_COMPLETED_AT,
      drafted: true,
      draftInProgress: true,
      kickoffAt: KICKOFF,
    });
    expect(decision).toEqual({ schedule: false, reason: "not_drafted" });
  });

  it("refuses as too_early before the lead-time window opens, even if already drafted", () => {
    const decision = weekOnePreviewDecision({
      now: WINDOW_START - 60 * 60 * 1000, // one hour before the window opens
      drafted: true,
      draftInProgress: false,
      kickoffAt: KICKOFF,
    });
    expect(decision).toEqual({ schedule: false, reason: "too_early" });
  });

  it("refuses as too_late once kickoff has arrived", () => {
    const decision = weekOnePreviewDecision({
      now: KICKOFF,
      drafted: true,
      draftInProgress: false,
      kickoffAt: KICKOFF,
    });
    expect(decision).toEqual({ schedule: false, reason: "too_late" });
    const decisionAfter = weekOnePreviewDecision({
      now: KICKOFF + 60 * 60 * 1000,
      drafted: true,
      draftInProgress: false,
      kickoffAt: KICKOFF,
    });
    expect(decisionAfter.schedule).toBe(false);
    expect(decisionAfter.reason).toBe("too_late");
  });

  it("schedules for now + 5 minutes once both conditions hold - the 2026 prod scenario", () => {
    const decision = weekOnePreviewDecision({
      now: DRAFT_COMPLETED_AT,
      drafted: true,
      draftInProgress: false,
      kickoffAt: KICKOFF,
    });
    expect(decision.schedule).toBe(true);
    expect(decision.reason).toBe("ready");
    expect(decision.scheduledFor).toBe(DRAFT_COMPLETED_AT + 5 * 60 * 1000);
  });

  it("is ready right at the window's opening instant (inclusive lower bound)", () => {
    const decision = weekOnePreviewDecision({
      now: WINDOW_START,
      drafted: true,
      draftInProgress: false,
      kickoffAt: KICKOFF,
    });
    expect(decision.schedule).toBe(true);
  });

  it("is ready one millisecond before kickoff (exclusive upper bound)", () => {
    const decision = weekOnePreviewDecision({
      now: KICKOFF - 1,
      drafted: true,
      draftInProgress: false,
      kickoffAt: KICKOFF,
    });
    expect(decision.schedule).toBe(true);
  });

  it("honors a custom leadDays", () => {
    const fiveDayWindowStart = KICKOFF - 5 * 24 * 60 * 60 * 1000;
    const tooEarlyForThree = weekOnePreviewDecision({
      now: fiveDayWindowStart + 60 * 60 * 1000,
      drafted: true,
      draftInProgress: false,
      kickoffAt: KICKOFF,
      leadDays: 5,
    });
    expect(tooEarlyForThree.schedule).toBe(true);

    const stillTooEarlyForDefault = weekOnePreviewDecision({
      now: fiveDayWindowStart + 60 * 60 * 1000,
      drafted: true,
      draftInProgress: false,
      kickoffAt: KICKOFF,
    });
    expect(stillTooEarlyForDefault).toEqual({ schedule: false, reason: "too_early" });
  });

  it("never opens the window before week 1's own Tuesday, even with a generous leadDays", () => {
    const week1Tuesday = KICKOFF - 2 * 24 * 60 * 60 * 1000; // later than a 10-day lead would allow
    const decision = weekOnePreviewDecision({
      now: KICKOFF - 9 * 24 * 60 * 60 * 1000, // inside a 10-day lead window, but before week1Tuesday
      drafted: true,
      draftInProgress: false,
      kickoffAt: KICKOFF,
      week1TuesdayAt: week1Tuesday,
      leadDays: 10,
    });
    expect(decision).toEqual({ schedule: false, reason: "too_early" });

    const decisionAtTuesday = weekOnePreviewDecision({
      now: week1Tuesday,
      drafted: true,
      draftInProgress: false,
      kickoffAt: KICKOFF,
      week1TuesdayAt: week1Tuesday,
      leadDays: 10,
    });
    expect(decisionAtTuesday.schedule).toBe(true);
  });
});
