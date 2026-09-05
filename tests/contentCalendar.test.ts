import { describe, expect, it } from "vitest";
import { projectContentCalendar, type CalendarRule, type WeekBoundary } from "../convex/lib/contentCalendar";
import { deriveLeagueCalendar } from "../convex/lib/leagueCalendar";

/**
 * The League Pass content calendar, projected for a 2026 season that starts Tuesday
 * 2026-09-08 (week 1) with a 14-week regular season and three one-week playoff rounds.
 */
const NY = "America/New_York";
const DAY = 24 * 3_600_000;
const WEEK1_START = Date.parse("2026-09-08T04:00:00Z"); // Tue 00:00 ET

const boundaries: WeekBoundary[] = Array.from({ length: 18 }, (_, i) => ({
  week: i + 1,
  start: WEEK1_START + i * 7 * DAY,
  end: WEEK1_START + (i + 1) * 7 * DAY - 1,
  isPlayoffs: false,
}));

const leagueCalendar = deriveLeagueCalendar({
  regularSeasonMatchupPeriods: 14,
  playoffRounds: 3,
  playoffMatchupPeriodLength: 1,
});

const rules: CalendarRule[] = [
  { contentType: "weekly_recap", enabled: true, timezone: NY, preferredPersona: "mel-diaper", schedule: { type: "weekly", dayOfWeek: 2, hour: 11, minute: 0 } },
  { contentType: "power_rankings", enabled: true, timezone: NY, preferredPersona: "nina-sharpe", schedule: { type: "weekly", dayOfWeek: 2, hour: 10, minute: 0 } },
  { contentType: "weekly_preview", enabled: true, timezone: NY, preferredPersona: "curtis-vaughn", schedule: { type: "weekly", dayOfWeek: 4, hour: 9, minute: 0 } },
  { contentType: "mid_season_awards", enabled: true, timezone: NY, schedule: { type: "season_based", trigger: "week_9", delayDays: 0, hour: 9, minute: 0, dayOfWeek: 3 } },
  { contentType: "season_recap", enabled: true, timezone: NY, schedule: { type: "season_based", trigger: "champion_determined", delayDays: 1, hour: 9, minute: 0 } },
  { contentType: "trade_analysis", enabled: true, timezone: NY, schedule: { type: "event_triggered", trigger: "trade_occurred", delayMinutes: 15 } },
  { contentType: "draft_rankings", enabled: true, timezone: NY, schedule: { type: "event_triggered", trigger: "draft_completed", delayMinutes: 60 } },
  { contentType: "bank_statement", enabled: false, timezone: NY, schedule: { type: "weekly", dayOfWeek: 2, hour: 12, minute: 0 } },
];

function project(overrides: Partial<Parameters<typeof projectContentCalendar>[0]> = {}) {
  return projectContentCalendar({
    now: Date.parse("2026-09-05T16:00:00Z"),
    timezone: NY,
    weekBoundaries: boundaries,
    regularSeasonStart: Date.parse("2026-09-10T00:00:00Z"),
    leagueCalendar,
    seasonEndWeek: leagueCalendar.seasonEndWeek,
    drafted: false,
    draftScheduledAt: Date.parse("2026-09-07T23:00:00Z"),
    rules,
    rows: [],
    defaultPersona: () => "curtis-vaughn",
    ...overrides,
  });
}

const et = (ms: number) =>
  new Intl.DateTimeFormat("en-US", { timeZone: NY, weekday: "short", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(ms));

describe("projectContentCalendar", () => {
  it("covers the league's season only, with league-relative phases", () => {
    const cal = project();
    expect(cal.weeks.map((w) => w.week)).toEqual(Array.from({ length: 17 }, (_, i) => i + 1));
    expect(cal.weeks[13].phase).toBe("regular");
    expect(cal.weeks[14].phase).toBe("playoffs");
    expect(cal.weeks[16].phase).toBe("championship");
  });

  it("puts a Tuesday 11:00 recap of week 3 on Wednesday 11:00, because managers get a day to comment", () => {
    const cal = project();
    const recap = cal.weeks[2].entries.find((e) => e.contentType === "weekly_recap")!;
    expect(recap.week).toBe(3);
    expect(recap.timing).toBe("estimated");
    expect(recap.interviews).toBe(true);
    expect(et(recap.at!)).toBe("Wed, Sep 30, 11:00");
    expect(recap.note).toContain("24-hour window");
    expect(recap.persona).toBe("mel-diaper");
    // No recap of "week 0", and no recap after the championship week.
    expect(cal.weeks[0].entries.find((e) => e.contentType === "weekly_recap")!.week).toBe(1);
    expect(cal.weeks[16].entries.some((e) => e.contentType === "weekly_recap")).toBe(true);
  });

  it("keeps a story with no interview window on its slot", () => {
    const cal = project();
    const rankings = cal.weeks[2].entries.find((e) => e.contentType === "power_rankings")!;
    expect(rankings.timing).toBe("exact");
    expect(rankings.interviews).toBe(false);
    expect(et(rankings.at!)).toBe("Tue, Sep 29, 10:00");
    const preview = cal.weeks[2].entries.find((e) => e.contentType === "weekly_preview")!;
    expect(et(preview.at!)).toBe("Thu, Sep 24, 09:00");
    expect(preview.week).toBe(3);
  });

  it("marks the week-1 preview as draft-dependent", () => {
    const preview = project().weeks[0].entries.find((e) => e.contentType === "weekly_preview")!;
    expect(preview.timing).toBe("estimated");
    expect(preview.note).toContain("drafted");
  });

  it("places season-based stories on the league's own weeks", () => {
    const cal = project();
    const awards = cal.weeks[leagueCalendar.midSeasonWeek - 1].entries.find((e) => e.contentType === "mid_season_awards")!;
    expect(awards.week).toBe(7);
    expect(et(awards.at!)).toBe("Wed, Oct 21, 09:00");
    const recap = cal.weeks[16].entries.find((e) => e.contentType === "season_recap")!;
    expect(et(recap.at!)).toBe("Tue, Jan 05, 09:00");
  });

  it("lists event stories and the pre-draft pieces as undated, and skips disabled rules", () => {
    const cal = project();
    const types = cal.undated.map((e) => e.contentType);
    expect(types).toEqual(expect.arrayContaining(["trade_analysis", "draft_rankings"]));
    expect(cal.undated.find((e) => e.contentType === "trade_analysis")!.timing).toBe("event");
    expect(cal.undated.find((e) => e.contentType === "draft_rankings")!.note).toContain("six hours");
    const all = [...cal.undated, ...cal.weeks.flatMap((w) => w.entries)];
    expect(all.some((e) => e.contentType === "bank_statement")).toBe(false);
  });

  it("overlays the rows that exist: a published recap links to its article, a queued row shows its real time", () => {
    const published = { id: "row_pub", contentType: "weekly_recap", scheduledFor: Date.parse("2026-09-30T15:00:00Z"), status: "published", week: 3, generatedContentId: "article_3" };
    const queued = { id: "row_q", contentType: "power_rankings", scheduledFor: Date.parse("2026-10-06T14:00:00Z"), status: "pending", week: 4 };
    const trade = { id: "row_trade", contentType: "trade_analysis", scheduledFor: Date.parse("2026-09-24T22:00:00Z"), status: "published", generatedContentId: "article_t" };
    const cal = project({ rows: [published, queued, trade] });
    const recap = cal.weeks[2].entries.find((e) => e.contentType === "weekly_recap")!;
    expect(recap).toMatchObject({ status: "published", articleId: "article_3", scheduledContentId: "row_pub", key: "row_pub" });
    expect(cal.weeks[2].entries.filter((e) => e.contentType === "weekly_recap")).toHaveLength(1);
    const rankings = cal.weeks[3].entries.find((e) => e.contentType === "power_rankings")!;
    expect(rankings).toMatchObject({ status: "pending", scheduledContentId: "row_q", timing: "exact" });
    // The trade row lands in the week its date falls in; the undated event entry stays.
    const tradeEntry = cal.weeks[2].entries.find((e) => e.contentType === "trade_analysis")!;
    expect(tradeEntry).toMatchObject({ status: "published", articleId: "article_t" });
    expect(cal.undated.some((e) => e.contentType === "trade_analysis" && e.status === "projected")).toBe(true);
  });

  it("calls a slot that went by with no row 'skipped'", () => {
    const cal = project({ now: Date.parse("2026-10-15T16:00:00Z") });
    const recap = cal.weeks[2].entries.find((e) => e.contentType === "weekly_recap")!;
    expect(recap.status).toBe("skipped");
    expect(recap.note).toContain("went by");
  });
});
