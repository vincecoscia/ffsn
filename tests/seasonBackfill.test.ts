/**
 * Pure functions only - `convex/lib/seasonBackfillPlan.ts` and
 * `convex/lib/standingsThroughWeek.ts` take no Convex runtime, matching
 * `tests/leagueCalendar.test.ts`'s style. See those files' headers for why
 * they're pure.
 */
import { describe, expect, it } from "vitest";
import {
  buildSeasonBackfillPlan,
  type SeasonBackfillPlanInput,
} from "../convex/lib/seasonBackfillPlan";
import { deriveLeagueCalendar } from "../convex/lib/leagueCalendar";
import {
  computeStandingsThroughWeek,
  type StandingsMatchupInput,
  type StandingsTeamInput,
} from "../convex/lib/standingsThroughWeek";

/* -------------------------------------------------------------------------- *
 * buildSeasonBackfillPlan
 * -------------------------------------------------------------------------- */

// 14-week regular season, 3 single-week playoff rounds - the fallback shape
// (convex/lib/leagueCalendar.ts's header) when a league has no synced ESPN
// settings: seasonEndWeek 17, midSeasonWeek 7, playoffPictureWeeks [12,13,14].
const CALENDAR = deriveLeagueCalendar({
  regularSeasonMatchupPeriods: 14,
  playoffRounds: 3,
  playoffMatchupPeriodLength: 1,
});

const TZ = "America/New_York";
// A real Tuesday (2025-09-02 00:00 ET), matching NFL_WEEK1_TUESDAY[2025] in
// convex/seasonBackfill.ts.
const WEEK1_TUESDAY = Date.UTC(2025, 8, 2, 4, 0, 0); // 00:00 ET = 04:00 UTC (EDT, UTC-4)

function baseInput(overrides: Partial<SeasonBackfillPlanInput> = {}): SeasonBackfillPlanInput {
  return {
    seasonId: 2025,
    calendar: CALENDAR,
    week1Tuesday: WEEK1_TUESDAY,
    timezone: TZ,
    existing: [],
    hasTradesForSeason: false,
    isCurrentSeason: false,
    ...overrides,
  };
}

describe("buildSeasonBackfillPlan", () => {
  it("counts one item per type per week, plus the season-level singletons, for a 14+3 calendar", () => {
    const plan = buildSeasonBackfillPlan(baseInput());

    const byType = new Map<string, number>();
    for (const item of plan) byType.set(item.contentType, (byType.get(item.contentType) ?? 0) + 1);

    expect(byType.get("weekly_preview")).toBe(17); // weeks 1-17 (seasonEndWeek)
    expect(byType.get("weekly_recap")).toBe(17);
    expect(byType.get("power_rankings")).toBe(17);
    expect(byType.get("mid_season_awards")).toBe(1);
    expect(byType.get("playoff_picture")).toBe(3); // playoffPictureWeeks
    expect(byType.get("season_recap")).toBe(1);
    expect(byType.get("trade_analysis")).toBe(1);
    expect(byType.get("waiver_wire_report")).toBe(1);
    // isCurrentSeason: false - season_welcome never appears in a past-season plan.
    expect(byType.has("season_welcome")).toBe(false);

    expect(plan.length).toBe(17 + 17 + 17 + 1 + 3 + 1 + 1 + 1);
  });

  it("adds season_welcome only when isCurrentSeason is true", () => {
    const plan = buildSeasonBackfillPlan(baseInput({ isCurrentSeason: true }));
    const welcome = plan.filter((item) => item.contentType === "season_welcome");
    expect(welcome).toHaveLength(1);
    expect(welcome[0]).toMatchObject({ week: 1, asOfWeek: 0, status: "planned" });
  });

  it("is sorted by printAt ascending across the whole plan", () => {
    const plan = buildSeasonBackfillPlan(baseInput());
    for (let i = 1; i < plan.length; i++) {
      expect(plan[i].printAt).toBeGreaterThanOrEqual(plan[i - 1].printAt);
    }
  });

  it("stamps asOfWeek off the results a printed article would actually have (preview off last week, recap/rankings off the week itself)", () => {
    const plan = buildSeasonBackfillPlan(baseInput());
    const previewWk5 = plan.find((i) => i.contentType === "weekly_preview" && i.week === 5)!;
    expect(previewWk5.asOfWeek).toBe(4);
    const recapWk5 = plan.find((i) => i.contentType === "weekly_recap" && i.week === 5)!;
    expect(recapWk5.asOfWeek).toBe(5);
    const rankingsWk5 = plan.find((i) => i.contentType === "power_rankings" && i.week === 5)!;
    expect(rankingsWk5.asOfWeek).toBe(5);
    const playoffPictureWk12 = plan.find((i) => i.contentType === "playoff_picture" && i.week === 12)!;
    expect(playoffPictureWk12.asOfWeek).toBe(11);
  });

  it("marks waiver_wire_report unsupported always, and trade_analysis unsupported only without trades", () => {
    const withoutTrades = buildSeasonBackfillPlan(baseInput());
    const waiver = withoutTrades.find((i) => i.contentType === "waiver_wire_report")!;
    expect(waiver.status).toBe("unsupported");
    expect(waiver.reason).toMatch(/free-agent pool/);
    const trades = withoutTrades.find((i) => i.contentType === "trade_analysis")!;
    expect(trades.status).toBe("unsupported");
    expect(trades.reason).toMatch(/no trades synced/);

    const withTrades = buildSeasonBackfillPlan(baseInput({ hasTradesForSeason: true }));
    const tradesPlanned = withTrades.find((i) => i.contentType === "trade_analysis")!;
    expect(tradesPlanned.status).toBe("planned");
    const waiverStillUnsupported = withTrades.find((i) => i.contentType === "waiver_wire_report")!;
    expect(waiverStillUnsupported.status).toBe("unsupported");
  });

  it("marks an item exists when a matching article is already on record (type + week for weekly types)", () => {
    const plan = buildSeasonBackfillPlan(
      baseInput({ existing: [{ contentType: "weekly_recap", week: 5 }] })
    );
    const recapWk5 = plan.find((i) => i.contentType === "weekly_recap" && i.week === 5)!;
    expect(recapWk5.status).toBe("exists");
    // A different week of the same type is unaffected.
    const recapWk6 = plan.find((i) => i.contentType === "weekly_recap" && i.week === 6)!;
    expect(recapWk6.status).toBe("planned");
    // A singleton type matches on type alone, regardless of the recorded week.
    const planSingleton = buildSeasonBackfillPlan(
      baseInput({ existing: [{ contentType: "season_recap", week: undefined }] })
    );
    expect(planSingleton.find((i) => i.contentType === "season_recap")!.status).toBe("exists");
  });

  it("types/weeks filters narrow the plan without renumbering index (stable across runs)", () => {
    const full = buildSeasonBackfillPlan(baseInput());
    const filtered = buildSeasonBackfillPlan(baseInput({ types: ["weekly_recap"], weeks: [5] }));

    expect(filtered).toHaveLength(1);
    const fullMatch = full.find((i) => i.contentType === "weekly_recap" && i.week === 5)!;
    expect(filtered[0].index).toBe(fullMatch.index);
    expect(filtered[0]).toMatchObject({ contentType: "weekly_recap", week: 5 });
  });
});

/* -------------------------------------------------------------------------- *
 * computeStandingsThroughWeek
 * -------------------------------------------------------------------------- */

describe("computeStandingsThroughWeek", () => {
  const teams: StandingsTeamInput[] = [
    { externalId: "1", divisionId: 10 },
    { externalId: "2", divisionId: 10 },
    { externalId: "3", divisionId: 11 },
    { externalId: "4", divisionId: 11 },
  ];

  // Week 1-2 rows carry no playoffTier (legacy data - falls back to the week-number
  // heuristic). Week 3 has a playoff-tagged game (T1 vs T4) that must NOT count
  // even though its week number (3) is inside the regular season, alongside a
  // regular week-3 game (T2 vs T3, playoffTier "NONE") that DOES count.
  const matchups: StandingsMatchupInput[] = [
    { homeTeamId: "1", awayTeamId: "2", homeScore: 100, awayScore: 90, matchupPeriod: 1 },
    { homeTeamId: "3", awayTeamId: "4", homeScore: 95, awayScore: 92, matchupPeriod: 1 },
    { homeTeamId: "1", awayTeamId: "3", homeScore: 100, awayScore: 100, matchupPeriod: 2 }, // tie
    { homeTeamId: "2", awayTeamId: "4", homeScore: 110, awayScore: 80, matchupPeriod: 2 },
    {
      homeTeamId: "1",
      awayTeamId: "4",
      homeScore: 200,
      awayScore: 50,
      matchupPeriod: 3,
      playoffTier: "WINNERS_BRACKET", // must not count
    },
    { homeTeamId: "2", awayTeamId: "3", homeScore: 90, awayScore: 85, matchupPeriod: 3, playoffTier: "NONE" },
  ];

  it("excludes a playoff-tagged matchup even inside the regular-season week range", () => {
    const rows = computeStandingsThroughWeek(teams, matchups, { throughWeek: 3, lastRegularSeasonWeek: 3 });
    const t1 = rows.find((r) => r.externalId === "1")!;
    const t4 = rows.find((r) => r.externalId === "4")!;
    // T1's only week-3 game (vs T4) is excluded, so it has 2 games, not 3.
    expect(t1.wins + t1.losses + t1.ties).toBe(2);
    expect(t4.wins + t4.losses + t4.ties).toBe(2);
    // The blowout score (200-50) never lands in either team's points.
    expect(t1.pointsFor).toBe(200); // 100 (wk1) + 100 (wk2 tie) - not +200 from the excluded game
    expect(t4.pointsFor).toBe(172); // 92 (wk1) + 80 (wk2) - not +50 from the excluded game
  });

  it("counts a playoffTier NONE game inside the regular-season range", () => {
    const rows = computeStandingsThroughWeek(teams, matchups, { throughWeek: 3, lastRegularSeasonWeek: 3 });
    const t2 = rows.find((r) => r.externalId === "2")!;
    const t3 = rows.find((r) => r.externalId === "3")!;
    expect(t2.wins + t2.losses + t2.ties).toBe(3); // wk1 loss, wk2 win, wk3 win - all counted
    expect(t3.wins + t3.losses + t3.ties).toBe(3);
  });

  it("records ties correctly for both sides", () => {
    const rows = computeStandingsThroughWeek(teams, matchups, { throughWeek: 3, lastRegularSeasonWeek: 3 });
    const t1 = rows.find((r) => r.externalId === "1")!;
    const t3 = rows.find((r) => r.externalId === "3")!;
    expect(t1.ties).toBe(1);
    expect(t3.ties).toBe(1);
  });

  it("ranks wins desc then pointsFor desc, and stamps playoffSeed to match rank", () => {
    const rows = computeStandingsThroughWeek(teams, matchups, { throughWeek: 3, lastRegularSeasonWeek: 3 });
    // T2: 2-1-0 (290 PF) - most wins, rank 1.
    // T3: 1-1-1 (280 PF) and T1: 1-0-1 (200 PF) tie on wins; T3's higher PF ranks it above T1.
    // T4: 0-2-0, last.
    expect(rows.map((r) => r.externalId)).toEqual(["2", "3", "1", "4"]);
    expect(rows.map((r) => r.rank)).toEqual([1, 2, 3, 4]);
    rows.forEach((r) => expect(r.playoffSeed).toBe(r.rank));

    const t2 = rows.find((r) => r.externalId === "2")!;
    expect(t2).toMatchObject({ wins: 2, losses: 1, ties: 0, pointsFor: 290, pointsAgainst: 265 });
    const t3 = rows.find((r) => r.externalId === "3")!;
    expect(t3).toMatchObject({ wins: 1, losses: 1, ties: 1, pointsFor: 280, pointsAgainst: 282 });
    const t1 = rows.find((r) => r.externalId === "1")!;
    expect(t1).toMatchObject({ wins: 1, losses: 0, ties: 1, pointsFor: 200, pointsAgainst: 190 });
  });

  it("carries divisionId through unchanged", () => {
    const rows = computeStandingsThroughWeek(teams, matchups, { throughWeek: 3, lastRegularSeasonWeek: 3 });
    expect(rows.find((r) => r.externalId === "1")!.divisionId).toBe(10);
    expect(rows.find((r) => r.externalId === "3")!.divisionId).toBe(11);
  });

  it("returns every team at 0-0-0 when throughWeek is 0 (before the first game)", () => {
    const rows = computeStandingsThroughWeek(teams, matchups, { throughWeek: 0, lastRegularSeasonWeek: 3 });
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row.wins + row.losses + row.ties).toBe(0);
      expect(row.pointsFor).toBe(0);
    }
  });
});
