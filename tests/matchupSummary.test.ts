/**
 * Pure unit tests for `convex/lib/matchupSummary.ts` - no Convex runtime,
 * plain vitest. See that module's header comment for the three audit
 * findings (IR counted as a starter; "live" before kickoff; pre-draft
 * redraft leagues carrying over last season's lineups) this fixes.
 */
import { describe, expect, it } from "vitest";
import {
  NON_STARTER_LINEUP_SLOTS,
  isStarterSlot,
  isPreDraftRedraft,
  starterActualTotal,
  starterProjectedTotal,
  summarizeMatchup,
  type MatchupSummary,
} from "../convex/lib/matchupSummary";
import type { Doc, Id } from "../convex/_generated/dataModel";

function roster(
  players: Array<{ lineupSlotId: number; points: number; projectedPoints?: number }>
) {
  return {
    appliedStatTotal: players.reduce((sum, p) => sum + p.points, 0),
    players: players.map((p, i) => ({
      lineupSlotId: p.lineupSlotId,
      espnId: 1000 + i,
      fullName: `Player ${i}`,
      position: "RB",
      points: p.points,
      projectedPoints: p.projectedPoints,
    })),
  };
}

const BASE_MATCHUP: Doc<"matchups"> = {
  _id: "matchup1" as Id<"matchups">,
  _creationTime: 0,
  leagueId: "league1" as Id<"leagues">,
  seasonId: 2026,
  matchupPeriod: 1,
  scoringPeriod: 1,
  homeTeamId: "1",
  awayTeamId: "2",
  homeScore: 0,
  awayScore: 0,
  createdAt: 0,
};

describe("isStarterSlot / NON_STARTER_LINEUP_SLOTS", () => {
  it("treats bench (20) and IR (21) as non-starters, everything else as a starter", () => {
    expect(NON_STARTER_LINEUP_SLOTS.has(20)).toBe(true);
    expect(NON_STARTER_LINEUP_SLOTS.has(21)).toBe(true);
    expect(isStarterSlot(20)).toBe(false);
    expect(isStarterSlot(21)).toBe(false);
    // A sample of real ESPN starting slots: QB, RB, WR, TE, FLEX, DST, K.
    for (const slot of [0, 2, 4, 6, 23, 16, 17]) {
      expect(isStarterSlot(slot)).toBe(true);
    }
  });
});

describe("starterActualTotal / starterProjectedTotal", () => {
  it("excludes IR (slot 21) from both actual and projected totals - the audit finding", () => {
    const r = roster([
      { lineupSlotId: 0, points: 20, projectedPoints: 18 }, // QB starter
      { lineupSlotId: 2, points: 15, projectedPoints: 14 }, // RB starter
      { lineupSlotId: 21, points: 11.8, projectedPoints: 10 }, // IR - must NOT count
    ]);

    // Matches the prod finding: 20 + 15 = 35, not 46.8 with the IR player included.
    expect(starterActualTotal(r)).toBe(35);
    expect(starterProjectedTotal(r)).toBe(32);
  });

  it("excludes bench (slot 20) from both totals", () => {
    const r = roster([
      { lineupSlotId: 4, points: 10, projectedPoints: 9 }, // WR starter
      { lineupSlotId: 20, points: 25, projectedPoints: 30 }, // bench - must NOT count
    ]);

    expect(starterActualTotal(r)).toBe(10);
    expect(starterProjectedTotal(r)).toBe(9);
  });

  it("rounds to 1 decimal to avoid float garbage", () => {
    const r = roster([
      { lineupSlotId: 0, points: 0.1, projectedPoints: 0.1 },
      { lineupSlotId: 2, points: 0.2, projectedPoints: 0.2 },
    ]);
    // 0.1 + 0.2 === 0.30000000000000004 in raw float math.
    expect(starterActualTotal(r)).toBe(0.3);
    expect(starterProjectedTotal(r)).toBe(0.3);
  });

  it("returns undefined when the roster is absent", () => {
    expect(starterActualTotal(undefined)).toBeUndefined();
    expect(starterProjectedTotal(undefined)).toBeUndefined();
  });

  it("treats a missing projectedPoints on a player as 0", () => {
    const r = roster([{ lineupSlotId: 0, points: 10 }]);
    expect(starterProjectedTotal(r)).toBe(0);
  });
});

describe("summarizeMatchup - projected", () => {
  it("uses the roster's starter projected total when a roster exists", () => {
    const doc: Doc<"matchups"> = {
      ...BASE_MATCHUP,
      homeRoster: roster([{ lineupSlotId: 0, points: 10, projectedPoints: 22.5 }]),
    };
    const summary = summarizeMatchup(doc);
    expect(summary.homeProjected).toBe(22.5);
  });

  it("falls back to the stored homeProjectedScore when there is no roster", () => {
    const doc: Doc<"matchups"> = {
      ...BASE_MATCHUP,
      homeProjectedScore: 88.4,
    };
    const summary = summarizeMatchup(doc);
    expect(summary.homeProjected).toBe(88.4);
  });

  it("is null when there is no roster and no stored projected score", () => {
    const summary = summarizeMatchup(BASE_MATCHUP);
    expect(summary.homeProjected).toBeNull();
    expect(summary.awayProjected).toBeNull();
  });
});

describe("summarizeMatchup - score", () => {
  it("prefers doc.homeScore over the roster sum when doc.homeScore is > 0", () => {
    const doc: Doc<"matchups"> = {
      ...BASE_MATCHUP,
      homeScore: 146.2, // ESPN's cumulative total (e.g. 2-week playoff round)
      homeRoster: roster([{ lineupSlotId: 0, points: 50 }]), // only covers the last period
    };
    expect(summarizeMatchup(doc).homeScore).toBe(146.2);
  });

  it("falls back to the roster's starter actual total when doc.homeScore is 0", () => {
    const doc: Doc<"matchups"> = {
      ...BASE_MATCHUP,
      homeScore: 0,
      homeRoster: roster([
        { lineupSlotId: 0, points: 20 },
        { lineupSlotId: 21, points: 11.8 }, // IR - excluded from the fallback too
      ]),
    };
    expect(summarizeMatchup(doc).homeScore).toBe(20);
  });

  it("is 0 when doc.homeScore is 0 and the roster fallback is also 0 (or absent)", () => {
    expect(summarizeMatchup(BASE_MATCHUP).homeScore).toBe(0);
    const doc: Doc<"matchups"> = {
      ...BASE_MATCHUP,
      homeRoster: roster([{ lineupSlotId: 0, points: 0 }]),
    };
    expect(summarizeMatchup(doc).homeScore).toBe(0);
  });
});

describe("summarizeMatchup - status", () => {
  it("is final whenever doc.winner is set, regardless of score", () => {
    const doc: Doc<"matchups"> = { ...BASE_MATCHUP, winner: "home", homeScore: 100, awayScore: 90 };
    expect(summarizeMatchup(doc).status).toBe("final");
  });

  it("is scheduled before kickoff - zeros everywhere, no winner - not 'live'", () => {
    // This is the second audit finding: the old client logic showed
    // "in progress 0.0-0.0" here because it only checked
    // `matchupPeriod === currentScoringPeriod && !winner`.
    const summary = summarizeMatchup(BASE_MATCHUP);
    expect(summary.status).toBe("scheduled");
    expect(summary.homeScore).toBe(0);
    expect(summary.awayScore).toBe(0);
  });

  it("is live once either side's computed score is > 0, with no winner yet", () => {
    const doc: Doc<"matchups"> = { ...BASE_MATCHUP, homeScore: 12.4 };
    expect(summarizeMatchup(doc).status).toBe("live");
  });

  it("is live via homePointsByScoringPeriod alone, even when homeScore/awayScore are still 0", () => {
    const doc: Doc<"matchups"> = {
      ...BASE_MATCHUP,
      homeScore: 0,
      awayScore: 0,
      homePointsByScoringPeriod: { "1": 5.5 },
    };
    expect(summarizeMatchup(doc).status).toBe("live");
  });

  it("is live via awayPointsByScoringPeriod alone", () => {
    const doc: Doc<"matchups"> = {
      ...BASE_MATCHUP,
      homeScore: 0,
      awayScore: 0,
      awayPointsByScoringPeriod: { "1": 3.2 },
    };
    expect(summarizeMatchup(doc).status).toBe("live");
  });
});

describe("summarizeMatchup - shape", () => {
  it("returns exactly the documented fields, with winner/playoffTier defaulted to null", () => {
    const summary: MatchupSummary = summarizeMatchup(BASE_MATCHUP);
    expect(summary).toEqual({
      _id: BASE_MATCHUP._id,
      matchupPeriod: 1,
      scoringPeriod: 1,
      homeTeamId: "1",
      awayTeamId: "2",
      winner: null,
      status: "scheduled",
      playoffTier: null,
      homeScore: 0,
      awayScore: 0,
      homeProjected: null,
      awayProjected: null,
      isBye: false,
    });
  });

  it("passes through playoffTier when set", () => {
    const doc: Doc<"matchups"> = { ...BASE_MATCHUP, playoffTier: "WINNERS_BRACKET" };
    expect(summarizeMatchup(doc).playoffTier).toBe("WINNERS_BRACKET");
  });
});

describe("isPreDraftRedraft", () => {
  it("is true for a redraft league (both keeper counts 0) that hasn't drafted yet", () => {
    expect(
      isPreDraftRedraft({
        draftInfo: { drafted: false },
        draftSettings: { keeperCount: 0, keeperCountFuture: 0 },
      })
    ).toBe(true);
  });

  it("is true when the keeper counts are absent entirely (defaults to 0)", () => {
    expect(isPreDraftRedraft({ draftInfo: { drafted: false }, draftSettings: {} })).toBe(true);
    expect(isPreDraftRedraft({ draftInfo: { drafted: false } })).toBe(true);
  });

  it("is false for a keeper league (keeperCount > 0), even before its draft", () => {
    expect(
      isPreDraftRedraft({
        draftInfo: { drafted: false },
        draftSettings: { keeperCount: 2, keeperCountFuture: 0 },
      })
    ).toBe(false);
  });

  it("is false once the league has drafted", () => {
    expect(
      isPreDraftRedraft({
        draftInfo: { drafted: true },
        draftSettings: { keeperCount: 0, keeperCountFuture: 0 },
      })
    ).toBe(false);
  });

  it("is false when drafted is undefined (not yet synced) - never guess", () => {
    expect(isPreDraftRedraft({ draftInfo: {}, draftSettings: { keeperCount: 0 } })).toBe(false);
    expect(isPreDraftRedraft({})).toBe(false);
    expect(isPreDraftRedraft(undefined)).toBe(false);
    expect(isPreDraftRedraft(null)).toBe(false);
  });

  it("is false when keeperCountFuture alone is > 0", () => {
    expect(
      isPreDraftRedraft({
        draftInfo: { drafted: false },
        draftSettings: { keeperCount: 0, keeperCountFuture: 3 },
      })
    ).toBe(false);
  });
});

describe("summarizeMatchup - hideProjections", () => {
  it("nulls out both projected fields when hideProjections is true, leaving scores/status/pairings alone", () => {
    const doc: Doc<"matchups"> = {
      ...BASE_MATCHUP,
      winner: "home",
      homeScore: 120,
      awayScore: 90,
      homeRoster: roster([{ lineupSlotId: 0, points: 20, projectedPoints: 25 }]),
    };

    const shown = summarizeMatchup(doc);
    expect(shown.homeProjected).toBe(25);

    const hidden = summarizeMatchup(doc, { hideProjections: true });
    expect(hidden.homeProjected).toBeNull();
    expect(hidden.awayProjected).toBeNull();
    // Everything else is unaffected.
    expect(hidden.status).toBe("final");
    expect(hidden.winner).toBe("home");
    expect(hidden.homeScore).toBe(120);
    expect(hidden.awayScore).toBe(90);
    expect(hidden.homeTeamId).toBe(doc.homeTeamId);
    expect(hidden.awayTeamId).toBe(doc.awayTeamId);
  });
});
