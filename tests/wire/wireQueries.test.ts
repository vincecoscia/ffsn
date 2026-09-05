import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import type { GenericActionCtx, GenericMutationCtx } from "convex/server";
import schema from "../../convex/schema";
import { api } from "../../convex/_generated/api";
import type { DataModel } from "../../convex/_generated/dataModel";
import { CARD_MIN_INTEREST } from "../../src/lib/ai/wire/types";

const modules = import.meta.glob("../../convex/**/*.*s");

type TestCtx = GenericMutationCtx<DataModel> & Pick<GenericActionCtx<DataModel>, "storage">;

const SEASON = 2026;
const CLERK_COMMISH = "clerk_commish_queries";
const CLERK_MEMBER = "clerk_member_queries";
const CLERK_OUTSIDER = "clerk_outsider_queries";

async function seedLeague(ctx: TestCtx, passActive: boolean) {
  const now = Date.now();
  const leagueId = await ctx.db.insert("leagues", {
    name: "Query Test League",
    platform: "espn",
    externalId: "9991",
    commissionerUserId: CLERK_COMMISH,
    settings: { scoringType: "ppr", rosterSize: 16, playoffWeeks: 3, categories: [] },
    subscription: {
      tier: "season_pass",
      status: passActive ? "active" : "pending",
      creditsRemaining: 0,
      creditsMonthly: 0,
      paymentStatus: passActive ? "completed" : "pending",
      seasonYear: SEASON,
    },
    lastSync: now,
    createdAt: now,
  });
  await ctx.db.insert("leagueMemberships", { leagueId, userId: CLERK_MEMBER, role: "member", joinedAt: now });
  await ctx.db.insert("leagueMemberships", { leagueId, userId: CLERK_COMMISH, role: "commissioner", joinedAt: now });
  return leagueId;
}

async function seedGlobalPost(ctx: TestCtx) {
  const now = Date.now();
  const eventId = await ctx.db.insert("wireEvents", {
    kind: "injury_status",
    dedupeKey: `query-test:${now}`,
    observedAt: now,
    detectedAt: now,
    players: [{ espnId: "9401", name: "Query Test Player" }],
    facts: {
      kind: "injury_status",
      observedAt: now,
      players: [{ espnId: "9401", name: "Query Test Player" }],
      statusTo: "Out",
      source: { type: "espn_injuries", fetchedAt: now },
    },
    interest: 70,
    source: { type: "espn_injuries", fetchedAt: now },
  });
  const postId = await ctx.db.insert("wirePosts", {
    eventId,
    kind: "injury_status",
    persona: "dex-alvarez",
    text: "Query Test Player: out for the season.",
    tags: ["REPORTED"],
    status: "take",
    interest: 70,
    createdAt: now,
    updatedAt: now,
  });
  return postId;
}

describe("wire.ts: authorization + pass gating", () => {
  it("refuses a non-member of the league", async () => {
    const t = convexTest(schema, modules);
    const leagueId = await t.run((ctx) => seedLeague(ctx, true));

    await expect(
      t
        .withIdentity({ subject: CLERK_OUTSIDER })
        .query(api.wire.getGlobalPosts, { leagueId, paginationOpts: { numItems: 10, cursor: null } })
    ).rejects.toThrow();

    await expect(
      t
        .withIdentity({ subject: CLERK_OUTSIDER })
        .query(api.wire.getLeaguePosts, { leagueId, paginationOpts: { numItems: 10, cursor: null } })
    ).rejects.toThrow();
  });

  it("a league without a pass sees the global wire but no league posts", async () => {
    const t = convexTest(schema, modules);
    const leagueId = await t.run((ctx) => seedLeague(ctx, false));
    await t.run((ctx) => seedGlobalPost(ctx));

    const asMember = t.withIdentity({ subject: CLERK_MEMBER });

    const global = await asMember.query(api.wire.getGlobalPosts, {
      leagueId,
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(global.page.length).toBeGreaterThan(0);
    expect(global.page[0].interest).toBeGreaterThanOrEqual(CARD_MIN_INTEREST);
    // No pass -> never attach overlays, even if some existed.
    expect(global.page[0].overlays).toEqual([]);

    const league = await asMember.query(api.wire.getLeaguePosts, {
      leagueId,
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(league.page).toEqual([]);
    expect(league.isDone).toBe(true);
  });

  it("a league with an active pass sees both its own routine posts and global overlays", async () => {
    const t = convexTest(schema, modules);
    const leagueId = await t.run((ctx) => seedLeague(ctx, true));
    const postId = await t.run((ctx) => seedGlobalPost(ctx));

    const now = Date.now();
    await t.run(async (ctx) => {
      // A routine (non-overlay) post.
      await ctx.db.insert("wireLeaguePosts", {
        leagueId,
        seasonId: SEASON,
        kind: "week_final",
        persona: "curtis-vaughn",
        text: "Week 1 is in the books.",
        tags: ["FINAL"],
        featuredTeams: [],
        dedupeKey: "week_final:test:1",
        createdAt: now,
      });
      // An overlay of the seeded global post.
      await ctx.db.insert("wireLeaguePosts", {
        leagueId,
        seasonId: SEASON,
        kind: "injury_status",
        persona: "dex-alvarez",
        text: "Your team just lost its RB1.",
        tags: ["REPORTED"],
        globalPostId: postId,
        featuredTeams: [],
        dedupeKey: `overlay:${postId}:league:owner`,
        createdAt: now,
      });
    });

    const asMember = t.withIdentity({ subject: CLERK_MEMBER });

    const league = await asMember.query(api.wire.getLeaguePosts, {
      leagueId,
      paginationOpts: { numItems: 10, cursor: null },
    });
    // Only the routine post - the overlay is nested under its global post, never listed alone.
    expect(league.page).toHaveLength(1);
    expect(league.page[0].kind).toBe("week_final");

    const global = await asMember.query(api.wire.getGlobalPosts, {
      leagueId,
      paginationOpts: { numItems: 10, cursor: null },
    });
    const seeded = global.page.find((p) => p._id === postId);
    expect(seeded?.overlays).toHaveLength(1);
    expect(seeded?.overlays[0].text).toContain("RB1");
  });
});
