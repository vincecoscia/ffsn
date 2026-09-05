import { describe, expect, it } from "vitest";
import { alignPrintTime, nextFullHour, nextWallClockAtOrAfter } from "../convex/lib/printTime";

const NY = "America/New_York";
const at = (iso: string) => Date.parse(iso);

describe("nextWallClockAtOrAfter", () => {
  it("returns the same day's slot when it is still ahead", () => {
    // 00:30 ET on Tue 2026-09-15 (EDT, UTC-4) -> 11:00 ET the same day
    expect(nextWallClockAtOrAfter(at("2026-09-15T04:30:00Z"), 11, 0, NY)).toBe(at("2026-09-15T15:00:00Z"));
  });

  it("rolls to the next day once the slot has passed", () => {
    // 11:00:01 ET Tue -> 11:00 ET Wed
    expect(nextWallClockAtOrAfter(at("2026-09-15T15:00:01Z"), 11, 0, NY)).toBe(at("2026-09-16T15:00:00Z"));
  });

  it("is exact on the slot itself", () => {
    expect(nextWallClockAtOrAfter(at("2026-09-15T15:00:00Z"), 11, 0, NY)).toBe(at("2026-09-15T15:00:00Z"));
  });

  it("handles the fall-back DST change (EDT -> EST)", () => {
    // 2026-11-01 02:00 ET is when EDT ends. 23:00 ET on Oct 31 (UTC-4) -> 11:00 ET Nov 1 (UTC-5 = 16:00Z)
    expect(nextWallClockAtOrAfter(at("2026-11-01T03:00:00Z"), 11, 0, NY)).toBe(at("2026-11-01T16:00:00Z"));
  });
});

describe("alignPrintTime", () => {
  it("uses the schedule's hour and minute in the league timezone", () => {
    const earliest = at("2026-09-15T04:30:00Z"); // Tue 00:30 ET
    const weekly = { type: "weekly" as const, dayOfWeek: 2, hour: 11, minute: 0 };
    expect(alignPrintTime(earliest, weekly, NY)).toBe(at("2026-09-15T15:00:00Z"));
    // A day later when the window ends after that hour: Tue 12:00 ET -> Wed 11:00 ET
    expect(alignPrintTime(at("2026-09-15T16:00:00Z"), weekly, NY)).toBe(at("2026-09-16T15:00:00Z"));
  });

  it("rounds event schedules up to the next full hour", () => {
    const event = { type: "event_triggered" as const, trigger: "trade_occurred", delayMinutes: 15 };
    expect(alignPrintTime(at("2026-09-15T18:20:00Z"), event, NY)).toBe(at("2026-09-15T19:00:00Z"));
    expect(nextFullHour(at("2026-09-15T19:00:00Z"))).toBe(at("2026-09-15T19:00:00Z"));
  });

  it("falls back to the default timezone and to the next hour when the schedule has no time", () => {
    expect(alignPrintTime(at("2026-09-15T04:30:00Z"), { type: "weekly", dayOfWeek: 2, hour: 11, minute: 0 }, undefined)).toBe(at("2026-09-15T15:00:00Z"));
    expect(alignPrintTime(at("2026-09-15T04:30:00Z"), undefined, NY)).toBe(at("2026-09-15T05:00:00Z"));
  });
});
