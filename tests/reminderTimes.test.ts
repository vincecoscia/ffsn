import { describe, expect, it } from "vitest";
import { reminderTimes } from "../convex/lib/reminderTimes";

const H = 60 * 60 * 1000;
const M = 60 * 1000;

describe("reminderTimes", () => {
  it("nudges halfway and 30 minutes before print on a 24-hour window", () => {
    const sent = 1_000_000;
    const deadline = sent + 24 * H;
    expect(reminderTimes(sent, deadline)).toEqual({ halfway: sent + 12 * H, final: deadline - 30 * M });
  });

  it("skips the halfway nudge on a short window and keeps the final one when there is room", () => {
    const sent = 1_000_000;
    expect(reminderTimes(sent, sent + 90 * M)).toEqual({ final: sent + 60 * M });
  });

  it("sends nothing useful for a window under 45 minutes", () => {
    const sent = 1_000_000;
    expect(reminderTimes(sent, sent + 40 * M)).toEqual({});
    expect(reminderTimes(sent, sent - 5 * M)).toEqual({});
  });

  it("drops the final nudge when it would land on top of the halfway one", () => {
    const sent = 1_000_000;
    // 2h window: halfway at +60m, final at +90m -> only 30m apart, so no final.
    expect(reminderTimes(sent, sent + 2 * H)).toEqual({ halfway: sent + 60 * M });
    // 3h window: halfway at +90m, final at +150m -> 60m apart, both.
    expect(reminderTimes(sent, sent + 3 * H)).toEqual({ halfway: sent + 90 * M, final: sent + 150 * M });
  });
});
