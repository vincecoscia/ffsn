import { describe, expect, it } from "vitest";
import {
  claimsHeat,
  countWord,
  faabRemainingFraction,
  findUniqueRosteredMention,
  firstSundayKickoff,
  hoursAgoPhrase,
  isInSeasonByMonth,
  isLateScratch,
  isLateSwap,
  isLineupMoveItem,
  isLockoutStatus,
  isQuietDeskDay,
  isReadsTheWire,
  isWeeklyRundownHour,
  isWithinQuietDeskWindow,
  isWorseThanActive,
  localWeekdayAndHour,
  looksLikeRumor,
  minutesUntil,
  ordinalWord,
  samQuestionGateReason,
  summarizeLineupMove,
} from "../../convex/lib/wireDeskRules";
import { lineupSlotName } from "../../convex/lib/lineupSlots";

const HOUR = 60 * 60 * 1000;
const MIN = 60 * 1000;

describe("wireDeskRules: lineup_move item classification", () => {
  it("a LINEUP item into a starting slot counts as a move", () => {
    expect(isLineupMoveItem({ type: "LINEUP", playerId: 1, fromLineupSlotId: 20, toLineupSlotId: 4 })).toBe(true);
  });

  it("a LINEUP item out to the bench counts as a move", () => {
    expect(isLineupMoveItem({ type: "LINEUP", playerId: 1, fromLineupSlotId: 4, toLineupSlotId: 20 })).toBe(true);
  });

  it("a pure IR move (20<->21) is never a lineup_move - it stays ir_move", () => {
    expect(isLineupMoveItem({ type: "LINEUP", playerId: 1, fromLineupSlotId: 20, toLineupSlotId: 21 })).toBe(false);
    expect(isLineupMoveItem({ type: "LINEUP", playerId: 1, fromLineupSlotId: 21, toLineupSlotId: 20 })).toBe(false);
  });

  it("a non-LINEUP item is never a lineup_move", () => {
    expect(isLineupMoveItem({ type: "ADD", playerId: 1, fromLineupSlotId: -1, toLineupSlotId: 20 })).toBe(false);
  });

  it("summarizeLineupMove prefers the into-starting move as primary and names the benched player", () => {
    const summary = summarizeLineupMove([
      { type: "LINEUP", playerId: 100, fromLineupSlotId: 20, toLineupSlotId: 23 }, // into FLEX
      { type: "LINEUP", playerId: 200, fromLineupSlotId: 4, toLineupSlotId: 20 }, // benched
    ]);
    expect(summary.movedInPlayerId).toBe(100);
    expect(summary.movedInToSlotId).toBe(23);
    expect(summary.benchedPlayerId).toBe(200);
  });

  it("summarizeLineupMove returns {} when nothing qualifies", () => {
    expect(summarizeLineupMove([{ type: "LINEUP", playerId: 1, fromLineupSlotId: 20, toLineupSlotId: 21 }])).toEqual({});
    expect(summarizeLineupMove([])).toEqual({});
  });

  it("lineupSlotName resolves the common ESPN slot ids", () => {
    expect(lineupSlotName(0)).toBe("QB");
    expect(lineupSlotName(23)).toBe("FLEX");
    expect(lineupSlotName(20)).toBe("Bench");
    expect(lineupSlotName(21)).toBe("IR");
    expect(lineupSlotName(9999)).toBe("Slot 9999");
  });
});

describe("wireDeskRules: late_swap", () => {
  const proposedDate = Date.UTC(2026, 8, 14, 12, 0, 0);

  it("is a late swap when kickoff is within the window after proposedDate", () => {
    expect(isLateSwap(proposedDate, proposedDate + 40 * MIN)).toBe(true);
  });

  it("is not a late swap once kickoff is beyond the window", () => {
    expect(isLateSwap(proposedDate, proposedDate + 2 * HOUR)).toBe(false);
  });

  it("is not a late swap when the kickoff already passed", () => {
    expect(isLateSwap(proposedDate, proposedDate - MIN)).toBe(false);
  });

  it("minutesUntil floors at 0 for a kickoff in the past", () => {
    expect(minutesUntil(proposedDate, proposedDate + HOUR)).toBe(0);
    expect(minutesUntil(proposedDate + 40 * MIN, proposedDate)).toBe(40);
  });
});

describe("wireDeskRules: reads_the_wire (§16 in-game injury rule)", () => {
  const kickoff = Date.UTC(2026, 8, 14, 17, 0, 0);
  const proposedDate = kickoff - 30 * MIN;

  it("reads the wire when the injury tag came shortly before the bench move", () => {
    expect(
      isReadsTheWire({ injuryObservedAt: proposedDate - 2 * HOUR, proposedDate, teamKickoffAt: kickoff })
    ).toBe(true);
  });

  it("never reads the wire when the injury was observed after that team's own kickoff (§16)", () => {
    expect(
      isReadsTheWire({ injuryObservedAt: kickoff + MIN, proposedDate: kickoff + HOUR, teamKickoffAt: kickoff })
    ).toBe(false);
  });

  it("is not a reads_the_wire move once the injury tag is outside the window", () => {
    expect(
      isReadsTheWire({ injuryObservedAt: proposedDate - 4 * HOUR, proposedDate, teamKickoffAt: kickoff })
    ).toBe(false);
  });

  it("isWorseThanActive is case/whitespace insensitive and false for Active", () => {
    expect(isWorseThanActive("Active")).toBe(false);
    expect(isWorseThanActive(" active ")).toBe(false);
    expect(isWorseThanActive("Questionable")).toBe(true);
    expect(isWorseThanActive(undefined)).toBe(false);
  });

  it("hoursAgoPhrase reads under an hour as minutes, an hour or more as a spelled-out count", () => {
    expect(hoursAgoPhrase(0, 40 * MIN)).toBe("40 minutes");
    expect(hoursAgoPhrase(0, MIN)).toBe("1 minute");
    expect(hoursAgoPhrase(0, 2 * HOUR)).toBe("two hours");
    expect(hoursAgoPhrase(0, HOUR)).toBe("one hour");
  });
});

describe("wireDeskRules: lineup_lock / late scratch (§16/§18)", () => {
  const kickoff = Date.UTC(2026, 8, 14, 17, 0, 0);

  it("a status observed inside the late-scratch window before kickoff is a late scratch", () => {
    expect(isLateScratch(kickoff - 20 * MIN, kickoff)).toBe(true);
  });

  it("a status observed well before kickoff is not a late scratch", () => {
    expect(isLateScratch(kickoff - 3 * HOUR, kickoff)).toBe(false);
  });

  it("isLockoutStatus recognizes OUT/IR/Doubtful/Suspension, case/whitespace insensitive", () => {
    for (const status of ["OUT", "Out", " ir ", "Injured Reserve", "doubtful", "Suspension", "SUSPENDED"]) {
      expect(isLockoutStatus(status)).toBe(true);
    }
    expect(isLockoutStatus("Questionable")).toBe(false);
    expect(isLockoutStatus("Active")).toBe(false);
    expect(isLockoutStatus(undefined)).toBe(false);
  });
});

describe("wireDeskRules: claims_in leak policy", () => {
  it("reads hot at or above the hot fraction of the FAAB budget", () => {
    expect(claimsHeat(20, 100)).toBe("the bidding looks high"); // 20%
    expect(claimsHeat(19, 100)).toBe("a bid or two in");
  });

  it("never divides by a zero/undefined budget", () => {
    expect(claimsHeat(50, 0)).toBe("a bid or two in");
    expect(claimsHeat(50, undefined)).toBe("a bid or two in");
  });

  it("countWord spells small counts, falls back to digits past ten", () => {
    expect(countWord(0)).toBe("zero");
    expect(countWord(3)).toBe("three");
    expect(countWord(15)).toBe("15");
  });

  it("ordinalWord spells small ordinals for the streaming_churn streak slot", () => {
    expect(ordinalWord(4)).toBe("fourth");
    expect(ordinalWord(1)).toBe("first");
    expect(ordinalWord(15)).toBe("15th");
  });
});

describe("wireDeskRules: season / calendar gates", () => {
  it("isInSeasonByMonth is true September through January", () => {
    expect(isInSeasonByMonth(new Date(Date.UTC(2026, 8, 1)))).toBe(true); // Sep
    expect(isInSeasonByMonth(new Date(Date.UTC(2026, 11, 31)))).toBe(true); // Dec
    expect(isInSeasonByMonth(new Date(Date.UTC(2027, 0, 15)))).toBe(true); // Jan
    expect(isInSeasonByMonth(new Date(Date.UTC(2026, 5, 1)))).toBe(false); // Jun
  });

  it("quiet_desk window is only inside 7 days before the deadline, never after", () => {
    const deadline = Date.UTC(2026, 10, 10);
    expect(isWithinQuietDeskWindow(deadline - 3 * 24 * HOUR, deadline)).toBe(true);
    expect(isWithinQuietDeskWindow(deadline - 8 * 24 * HOUR, deadline)).toBe(false);
    expect(isWithinQuietDeskWindow(deadline + HOUR, deadline)).toBe(false);
    expect(isWithinQuietDeskWindow(deadline, undefined)).toBe(false);
  });

  it("faabRemainingFraction never divides by zero", () => {
    expect(faabRemainingFraction(100, 90)).toBeCloseTo(0.1);
    expect(faabRemainingFraction(0, 0)).toBe(0);
  });

  it("localWeekdayAndHour reads a UTC instant in a real IANA timezone", () => {
    // 2026-09-09 12:00 UTC is 2026-09-09 08:00 America/New_York (EDT, UTC-4) - a Wednesday.
    const utcMs = Date.UTC(2026, 8, 9, 12, 0, 0);
    const { weekday, hour } = localWeekdayAndHour(utcMs, "America/New_York");
    expect(weekday).toBe(3); // Wednesday
    expect(hour).toBe(8);
  });

  it("isWeeklyRundownHour fires only Wednesday 07:00 league-local", () => {
    // 2026-09-09 11:00 UTC == 07:00 America/New_York.
    const sevenAmEastern = Date.UTC(2026, 8, 9, 11, 0, 0);
    expect(isWeeklyRundownHour(sevenAmEastern, "America/New_York")).toBe(true);
    expect(isWeeklyRundownHour(sevenAmEastern + HOUR, "America/New_York")).toBe(false); // 8am, wrong hour
    const tuesdaySevenAm = sevenAmEastern - 24 * HOUR;
    expect(isWeeklyRundownHour(tuesdaySevenAm, "America/New_York")).toBe(false); // Tuesday, wrong day
  });

  it("isQuietDeskDay fires only on Tuesdays league-local", () => {
    const tuesdayNoonEastern = Date.UTC(2026, 8, 8, 16, 0, 0);
    expect(isQuietDeskDay(tuesdayNoonEastern, "America/New_York")).toBe(true);
    expect(isQuietDeskDay(tuesdayNoonEastern + 24 * HOUR, "America/New_York")).toBe(false);
  });
});

describe("wireDeskRules: rumor_check", () => {
  it("looksLikeRumor matches the owner-specified keywords, case insensitive", () => {
    expect(looksLikeRumor("Hearing some noise about a trade")).toBe(true);
    expect(looksLikeRumor("Shopping my RB2, DM me")).toBe(true);
    expect(looksLikeRumor("There's a RUMOR going around")).toBe(true);
    expect(looksLikeRumor("Great win this week!")).toBe(false);
  });

  it("finds the unique rostered last name mentioned in the text", () => {
    const lastNames = new Map([
      ["jefferson", ["Justin Jefferson"]],
      ["chase", ["Ja'Marr Chase"]],
    ]);
    expect(findUniqueRosteredMention("hearing Jefferson is on the block", lastNames)).toBe("Justin Jefferson");
    expect(findUniqueRosteredMention("nothing about anyone here", lastNames)).toBeNull();
  });

  it("never matches a last name shorter than 4 letters", () => {
    const lastNames = new Map([["fox", ["Trey Fox"]]]);
    expect(findUniqueRosteredMention("shopping fox around", lastNames)).toBeNull();
  });

  it("never matches a last name shared by two rostered players (ambiguous)", () => {
    const lastNames = new Map([["smith", ["Alpha Smith", "Beta Smith"]]]);
    expect(findUniqueRosteredMention("hearing Smith could move", lastNames)).toBeNull();
  });

  it("returns null when two different rostered players are both mentioned", () => {
    const lastNames = new Map([
      ["jefferson", ["Justin Jefferson"]],
      ["chase", ["Ja'Marr Chase"]],
    ]);
    expect(findUniqueRosteredMention("hearing Jefferson and Chase both shopping", lastNames)).toBeNull();
  });
});

describe("wireDeskRules: sam_question gates", () => {
  it("passes when every count is under its cap", () => {
    expect(samQuestionGateReason({ perManagerToday: 0, perLeagueToday: 0, seasonSpendUsd: 0, spendCapUsd: 60 })).toBeNull();
  });

  it("gates on the manager daily limit first", () => {
    expect(samQuestionGateReason({ perManagerToday: 1, perLeagueToday: 0, seasonSpendUsd: 0, spendCapUsd: 60 })).toBe(
      "manager_daily_limit"
    );
  });

  it("gates on the league daily limit", () => {
    expect(samQuestionGateReason({ perManagerToday: 0, perLeagueToday: 10, seasonSpendUsd: 0, spendCapUsd: 60 })).toBe(
      "league_daily_limit"
    );
  });

  it("gates on the season spend cap", () => {
    expect(samQuestionGateReason({ perManagerToday: 0, perLeagueToday: 0, seasonSpendUsd: 60, spendCapUsd: 60 })).toBe(
      "season_spend_cap"
    );
  });
});

describe("wireDeskRules: firstSundayKickoff (lineup_lock on bye)", () => {
  // Thu 8:20pm ET (Sept 3, 2026), Sun 1:00pm ET and 4:25pm ET (Sept 6), Mon 8:15pm ET (Sept 7).
  const THU_NIGHT = Date.UTC(2026, 8, 4, 0, 20, 0);
  const SUN_EARLY = Date.UTC(2026, 8, 6, 17, 0, 0);
  const SUN_LATE = Date.UTC(2026, 8, 6, 20, 25, 0);
  const MON_NIGHT = Date.UTC(2026, 8, 8, 0, 15, 0);

  it("picks the earliest Sunday kickoff among a week's slate", () => {
    expect(firstSundayKickoff([THU_NIGHT, SUN_LATE, SUN_EARLY, MON_NIGHT])).toBe(SUN_EARLY);
  });

  it("returns undefined when no kickoff in the list falls on a Sunday", () => {
    expect(firstSundayKickoff([THU_NIGHT, MON_NIGHT])).toBeUndefined();
  });

  it("returns undefined for an empty list", () => {
    expect(firstSundayKickoff([])).toBeUndefined();
  });
});
