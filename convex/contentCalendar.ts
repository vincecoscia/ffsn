/**
 * The League Pass content calendar (owner ask, 2026-09-05): every story the league's
 * automatic programming will print this season, week by week, so nobody spends credits on
 * a story that is already coming. Any league member may read it.
 *
 * The projection itself is pure (convex/lib/contentCalendar.ts); this query only gathers
 * its inputs: the schedule rules, the rows that already exist, the NFL week boundaries, the
 * league's own calendar (regular season / playoffs / championship) and the draft date.
 */
import { v } from "convex/values";
import { query } from "./_generated/server";
import { requireLeagueMember } from "./lib/auth";
import { leagueCurrentSeason } from "./lib/season";
import { leagueCalendarInputFromSettings, deriveLeagueCalendar } from "./lib/leagueCalendar";
import { resolveSeasonEndWeek } from "./lib/seasonWindow";
import { resolveScheduledDraftDate } from "./lib/draftDate";
import { projectContentCalendar, type CalendarRow, type CalendarRule } from "./lib/contentCalendar";
import { contentTypePersonaMap, DEFAULT_PERSONA } from "../src/lib/ai/persona-prompts";

const DEFAULT_TIMEZONE = "America/New_York";
const DAY_MS = 24 * 60 * 60 * 1000;

const calendarEntryValidator = v.object({
  key: v.string(),
  contentType: v.string(),
  persona: v.string(),
  week: v.union(v.number(), v.null()),
  at: v.union(v.number(), v.null()),
  timing: v.union(v.literal("exact"), v.literal("estimated"), v.literal("event")),
  status: v.union(
    v.literal("projected"),
    v.literal("pending"),
    v.literal("generating"),
    v.literal("batched"),
    v.literal("published"),
    v.literal("failed"),
    v.literal("cancelled"),
    v.literal("backlogged"),
    v.literal("skipped")
  ),
  scheduledContentId: v.union(v.string(), v.null()),
  articleId: v.union(v.string(), v.null()),
  note: v.union(v.string(), v.null()),
  interviews: v.boolean(),
});

export const getContentCalendar = query({
  args: { leagueId: v.id("leagues") },
  returns: v.union(
    v.null(),
    v.object({
      season: v.number(),
      timezone: v.string(),
      contentEnabled: v.boolean(),
      passActive: v.boolean(),
      currentWeek: v.union(v.number(), v.null()),
      weeks: v.array(
        v.object({
          week: v.number(),
          start: v.number(),
          end: v.number(),
          phase: v.union(v.literal("regular"), v.literal("playoffs"), v.literal("championship")),
          entries: v.array(calendarEntryValidator),
        })
      ),
      undated: v.array(calendarEntryValidator),
    })
  ),
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    await requireLeagueMember(ctx, args.leagueId);

    const league = await ctx.db.get(args.leagueId);
    if (!league) return null;
    const season = leagueCurrentSeason(league);
    const now = Date.now();

    const preferences = await ctx.db
      .query("leagueContentPreferences")
      .withIndex("by_league", (q) => q.eq("leagueId", args.leagueId))
      .first();
    const timezone = preferences?.timezone?.trim() || DEFAULT_TIMEZONE;

    const nflSeason = await ctx.db
      .query("nflSeasons")
      .withIndex("by_year", (q) => q.eq("year", season))
      .first();
    if (!nflSeason) {
      return {
        season,
        timezone,
        contentEnabled: preferences?.contentEnabled ?? true,
        passActive: passIsActive(league),
        currentWeek: null,
        weeks: [],
        undated: [],
      };
    }

    const leagueSeason = await ctx.db
      .query("leagueSeasons")
      .withIndex("by_league_season", (q) => q.eq("leagueId", args.leagueId).eq("seasonId", season))
      .first();
    const calendarInput = leagueCalendarInputFromSettings(leagueSeason?.settings);
    const leagueCalendar = calendarInput ? deriveLeagueCalendar(calendarInput) : undefined;
    const seasonEndWeek = resolveSeasonEndWeek(leagueSeason?.settings);
    const draft = resolveScheduledDraftDate({
      draftSettings: leagueSeason?.draftSettings,
      draftInfo: leagueSeason?.draftInfo,
    });

    const schedules = await ctx.db
      .query("contentSchedules")
      .withIndex("by_league", (q) => q.eq("leagueId", args.leagueId))
      .collect();
    const rules: CalendarRule[] = schedules.map((s) => ({
      contentType: s.contentType,
      enabled: s.enabled,
      timezone: s.timezone,
      preferredPersona: s.preferredPersona,
      schedule: s.schedule as CalendarRule["schedule"],
    }));

    // Rows for this season: stamped with the season when they carry one, else by date.
    const seasonStart = nflSeason.phases.preseason.start - 30 * DAY_MS;
    const seasonEnd = nflSeason.phases.regularSeason.end + 60 * DAY_MS;
    const allRows = await ctx.db
      .query("scheduledContent")
      .withIndex("by_league", (q) => q.eq("leagueId", args.leagueId))
      .collect();
    const rows: CalendarRow[] = allRows
      .filter((row) => {
        const stamped = row.contextData?.seasonId ?? row.seasonId;
        if (stamped !== undefined) return stamped === season;
        return row.scheduledFor >= seasonStart && row.scheduledFor <= seasonEnd;
      })
      .map((row) => ({
        id: row._id as string,
        contentType: row.contentType,
        scheduledFor: row.scheduledFor,
        status: row.status,
        week: row.week ?? row.contextData?.week,
        generatedContentId: row.generatedContentId ? (row.generatedContentId as string) : undefined,
      }));

    const currentBoundary = nflSeason.weekBoundaries.find((w) => now >= w.start && now <= w.end);

    const calendar = projectContentCalendar({
      now,
      timezone,
      weekBoundaries: nflSeason.weekBoundaries,
      regularSeasonStart: nflSeason.phases.regularSeason.start,
      leagueCalendar,
      seasonEndWeek,
      draftScheduledAt: draft.scheduledAt ?? undefined,
      drafted: leagueSeason?.draftInfo?.drafted === true,
      rules,
      rows,
      defaultPersona: (contentType) => contentTypePersonaMap[contentType]?.[0] ?? DEFAULT_PERSONA,
    });

    return {
      season,
      timezone,
      contentEnabled: preferences?.contentEnabled ?? true,
      passActive: passIsActive(league),
      currentWeek: currentBoundary && currentBoundary.week <= seasonEndWeek ? currentBoundary.week : null,
      weeks: calendar.weeks,
      undated: calendar.undated,
    };
  },
});

function passIsActive(league: { subscription?: { tier?: string; status?: string } }): boolean {
  const tier = league.subscription?.tier;
  const status = league.subscription?.status;
  return (tier === "league_pass" || tier === "season_pass") && status === "active";
}
