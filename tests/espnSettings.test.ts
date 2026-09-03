/**
 * `convex/lib/espnSettings.ts` - pure functions, no Convex runtime needed.
 *
 * The primary fixture (`tests/fixtures/espn-settings-public-2025.json`) is a
 * real ESPN `view=mSettings` response (public league 899513, season 2025;
 * owner/member data stripped) rather than a hand-built object, so the parser
 * is proven against ESPN's actual field names/shapes, not a guess at them -
 * see the audit finding this module fixes: the previous extraction in
 * `convex/espn.ts` read fields ESPN doesn't emit and silently fell back to
 * hard-coded defaults on every real league.
 */
import { describe, expect, it } from "vitest";
import fixture from "./fixtures/espn-settings-public-2025.json";
import {
  fantasyChampionshipWeek,
  matchupPeriodWeeks,
  parseEspnLeagueSettings,
  pickMirroredLeagueSettings,
  scoringLabel,
  weekToMatchupPeriod,
  type ParsedLeagueSettings,
} from "../convex/lib/espnSettings";

describe("parseEspnLeagueSettings", () => {
  describe("against a real ESPN response", () => {
    const parsed = parseEspnLeagueSettings(fixture.settings);

    it("parses top-level name/size", () => {
      expect(parsed.name).toBe("Pigskin Power Bottoms");
      expect(parsed.size).toBe(12);
    });

    it("has no reception bonus, so scoringType is standard (statId 53 absent from this league)", () => {
      expect(parsed.receptionPoints).toBeUndefined();
      expect(parsed.scoringType).toBe("standard");
      expect(parsed.scoringSystem).toBe("H2H_POINTS");
      expect(scoringLabel(parsed)).toBe("Standard");
    });

    it("parses regular-season length and playoff shape from the real field names", () => {
      // matchupPeriodCount, not the old (nonexistent) regularSeasonMatchupPeriods.
      expect(parsed.regularSeasonMatchupPeriods).toBe(14);
      expect(parsed.playoffTeamCount).toBe(4);
      expect(parsed.playoffMatchupPeriodLength).toBe(2);
      // ceil(log2(4)) = 2 rounds.
      expect(parsed.playoffRounds).toBe(2);
      expect(parsed.playoffSeedingRule).toBe("TOTAL_POINTS_SCORED");
      expect(parsed.playoffReseed).toBe(false);
      // 14 regular-season weeks + 2 rounds x 2 weeks/round.
      expect(fantasyChampionshipWeek(parsed)).toBe(18);
    });

    it("parses divisions with a numeric id", () => {
      expect(parsed.divisions).toEqual([{ id: 0, name: "Texas", size: 12 }]);
    });

    it("sorts scoring periods within a matchup period (ESPN sent week 15 as [16, 15])", () => {
      expect(parsed.matchupPeriods?.["15"]).toEqual([15, 16]);
      expect(parsed.matchupPeriods?.["16"]).toEqual([17, 18]);
      expect(parsed.matchupPeriods?.["1"]).toEqual([1]);
    });

    it("maps weeks to matchup periods and back through the two-week playoff round", () => {
      expect(weekToMatchupPeriod(parsed.matchupPeriods, 16)).toBe(15);
      expect(weekToMatchupPeriod(parsed.matchupPeriods, 17)).toBe(16);
      expect(matchupPeriodWeeks(parsed.matchupPeriods, 15)).toEqual([15, 16]);
    });

    it("names lineup slots by their human name, keeping zero-count slots for full fidelity", () => {
      expect(parsed.lineupSlots).toMatchObject({
        QB: 0,
        TQB: 1,
        DP: 1,
        "D/ST": 1,
        K: 1,
        BENCH: 7,
        IR: 2,
        FLEX: 4,
      });
      // Slot id 22 isn't in the known map - falls back rather than vanishing.
      expect(parsed.lineupSlots?.SLOT_22).toBe(0);
    });

    it("is not superflex (a lone TQB slot isn't a second QB slot or an OP slot)", () => {
      expect(parsed.isSuperflex).toBe(false);
    });

    it("detects IDP from the DP slot's nonzero count", () => {
      expect(parsed.hasIdp).toBe(true);
    });

    it("parses FAAB waiver settings", () => {
      expect(parsed.waiverType).toBe("faab");
      expect(parsed.faabBudget).toBe(200);
      expect(parsed.waiverHours).toBe(24);
    });

    it("parses trade settings", () => {
      expect(parsed.tradeDeadline).toBe(1764784800000);
      expect(parsed.vetoVotesRequired).toBe(0);
    });

    it("parses draft settings", () => {
      expect(parsed.draft).toEqual({
        date: 1755982800000,
        type: "AUCTION",
        timePerSelection: 60,
        keeperCount: 0,
        orderType: "MANUAL",
      });
    });
  });

  describe("reception-points scoring buckets", () => {
    function withReceptionPoints(points: number | undefined): unknown {
      return {
        scoringSettings: {
          scoringType: "H2H_POINTS",
          scoringItems:
            points === undefined ? [] : [{ statId: 53, points }],
        },
      };
    }

    it("full PPR (points 1)", () => {
      const parsed = parseEspnLeagueSettings(withReceptionPoints(1));
      expect(parsed.scoringType).toBe("ppr");
      expect(parsed.receptionPoints).toBe(1);
    });

    it("half PPR (points 0.5)", () => {
      const parsed = parseEspnLeagueSettings(withReceptionPoints(0.5));
      expect(parsed.scoringType).toBe("half_ppr");
      expect(parsed.receptionPoints).toBe(0.5);
    });

    it("standard (0 points)", () => {
      const parsed = parseEspnLeagueSettings(withReceptionPoints(0));
      expect(parsed.scoringType).toBe("standard");
      expect(parsed.receptionPoints).toBe(0);
    });

    it("standard (statId 53 absent)", () => {
      const parsed = parseEspnLeagueSettings(withReceptionPoints(undefined));
      expect(parsed.scoringType).toBe("standard");
      expect(parsed.receptionPoints).toBeUndefined();
    });

    it("custom (any other positive value, e.g. 0.25) - still stores receptionPoints", () => {
      const parsed = parseEspnLeagueSettings(withReceptionPoints(0.25));
      expect(parsed.scoringType).toBe("custom");
      expect(parsed.receptionPoints).toBe(0.25);
      expect(scoringLabel(parsed)).toBe("Custom");
    });
  });

  describe("superflex detection", () => {
    it("true when the OP slot is used", () => {
      const parsed = parseEspnLeagueSettings({
        rosterSettings: { lineupSlotCounts: { "0": 1, "7": 1, "20": 6 } },
      });
      expect(parsed.lineupSlots).toMatchObject({ QB: 1, OP: 1 });
      expect(parsed.isSuperflex).toBe(true);
    });

    it("true when there are 2+ dedicated QB slots and no OP slot", () => {
      const parsed = parseEspnLeagueSettings({
        rosterSettings: { lineupSlotCounts: { "0": 2, "20": 6 } },
      });
      expect(parsed.isSuperflex).toBe(true);
    });

    it("false for a single QB, no OP", () => {
      const parsed = parseEspnLeagueSettings({
        rosterSettings: { lineupSlotCounts: { "0": 1, "20": 6 } },
      });
      expect(parsed.isSuperflex).toBe(false);
    });
  });

  describe("tolerance", () => {
    it("settings undefined - returns a fully-defaulted object, not a throw", () => {
      const parsed = parseEspnLeagueSettings(undefined);
      expect(parsed.scoringType).toBe("standard");
      expect(parsed.regularSeasonMatchupPeriods).toBeUndefined();
      expect(parsed.divisions).toBeUndefined();
      expect(parsed.lineupSlots).toBeUndefined();
      expect(parsed.isSuperflex).toBeUndefined();
      expect(parsed.hasIdp).toBeUndefined();
    });

    it("settings null / a string / an array - same tolerant defaults, no throw", () => {
      for (const bad of [null, "not an object", [1, 2, 3], 42]) {
        expect(() => parseEspnLeagueSettings(bad)).not.toThrow();
        expect(parseEspnLeagueSettings(bad).scoringType).toBe("standard");
      }
    });

    it("a malformed nested section (wrong types) is ignored rather than throwing", () => {
      const parsed = parseEspnLeagueSettings({
        scheduleSettings: { matchupPeriodCount: "fourteen", divisions: "nope" },
        rosterSettings: { lineupSlotCounts: "nope" },
        scoringSettings: { scoringItems: "nope" },
      });
      expect(parsed.regularSeasonMatchupPeriods).toBeUndefined();
      expect(parsed.divisions).toBeUndefined();
      expect(parsed.lineupSlots).toBeUndefined();
      expect(parsed.scoringType).toBe("standard");
    });
  });
});

describe("fantasyChampionshipWeek", () => {
  it("undefined when any input is missing rather than guessing", () => {
    const base: ParsedLeagueSettings = parseEspnLeagueSettings(undefined);
    expect(fantasyChampionshipWeek(base)).toBeUndefined();
    expect(
      fantasyChampionshipWeek({ ...base, regularSeasonMatchupPeriods: 14 })
    ).toBeUndefined();
    expect(
      fantasyChampionshipWeek({
        ...base,
        regularSeasonMatchupPeriods: 14,
        playoffMatchupPeriodLength: 1,
        playoffRounds: 3,
      })
    ).toBe(17);
  });
});

describe("pickMirroredLeagueSettings", () => {
  it("drops undefined fields and excludes name/size/vetoVotesRequired/draft", () => {
    const parsed = parseEspnLeagueSettings(fixture.settings);
    const mirrored = pickMirroredLeagueSettings(parsed);

    expect(mirrored).toMatchObject({
      scoringType: "standard",
      scoringSystem: "H2H_POINTS",
      regularSeasonMatchupPeriods: 14,
      playoffTeamCount: 4,
      playoffMatchupPeriodLength: 2,
      playoffRounds: 2,
      playoffSeedingRule: "TOTAL_POINTS_SCORED",
      playoffReseed: false,
      waiverType: "faab",
      faabBudget: 200,
      waiverHours: 24,
      tradeDeadline: 1764784800000,
    });
    expect(mirrored).not.toHaveProperty("name");
    expect(mirrored).not.toHaveProperty("size");
    expect(mirrored).not.toHaveProperty("vetoVotesRequired");
    expect(mirrored).not.toHaveProperty("draft");
    // receptionPoints was undefined on the parsed input (no reception bonus
    // in this league) - dropped, not written as `undefined`.
    expect(mirrored).not.toHaveProperty("receptionPoints");
  });

  it("excludes scoringType when scoringSystem is undefined (an empty/malformed parse can't downgrade a stored scoring type)", () => {
    const emptyParse = parseEspnLeagueSettings(undefined);
    expect(emptyParse.scoringType).toBe("standard"); // always resolves to a bucket...
    expect(emptyParse.scoringSystem).toBeUndefined(); // ...but nothing backs it up here.

    const mirrored = pickMirroredLeagueSettings(emptyParse);
    expect(mirrored).not.toHaveProperty("scoringType");
  });

  it("includes scoringType when scoringSystem is present, even if it resolves to standard", () => {
    const parsed = parseEspnLeagueSettings({
      scoringSettings: { scoringType: "H2H_POINTS", scoringItems: [] },
    });
    expect(parsed.scoringType).toBe("standard");
    expect(parsed.scoringSystem).toBe("H2H_POINTS");

    const mirrored = pickMirroredLeagueSettings(parsed);
    expect(mirrored.scoringType).toBe("standard");
  });
});
