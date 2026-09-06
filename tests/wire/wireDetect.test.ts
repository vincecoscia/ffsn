import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import type { GenericActionCtx, GenericMutationCtx } from "convex/server";
import schema from "../../convex/schema";
import { internal } from "../../convex/_generated/api";
import { ingestTrendingRows } from "../../convex/wireDetect";
import type { DataModel } from "../../convex/_generated/dataModel";
import { GLOBAL_TAKES_PER_HOUR } from "../../src/lib/ai/wire/types";
import type { EspnInjuryEntry } from "../../src/lib/ai/wire/espn";

const modules = import.meta.glob("../../convex/**/*.*s");

// The type `t.run`'s callback receives (convex-test's own inferred shape, not exported by name).
type TestCtx = GenericMutationCtx<DataModel> & Pick<GenericActionCtx<DataModel>, "storage">;

const SEASON = 2026;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** A week-1 game for the season gate (`seasonHasKickedOff`) - `gameTime` in the past means kicked off. */
async function seedWeek1Game(ctx: TestCtx, gameTime: number) {
  await ctx.db.insert("nflSchedules", {
    season: SEASON,
    week: 1,
    teamId: 1,
    teamAbbrev: "DEN",
    opponent: "KC",
    isHome: true,
    gameTime,
    isByeWeek: false,
    createdAt: Date.now(),
  });
}

async function seedPlayer(
  ctx: TestCtx,
  opts: { espnId: string; fullName: string; defaultPosition: string; proTeamAbbrev?: string; percentOwned?: number }
) {
  const now = Date.now();
  await ctx.db.insert("playersEnhanced", {
    espnId: opts.espnId,
    season: SEASON,
    fullName: opts.fullName,
    defaultPositionId: 0,
    defaultPosition: opts.defaultPosition,
    eligibleSlots: [],
    eligiblePositions: [opts.defaultPosition],
    proTeamId: 1,
    proTeamAbbrev: opts.proTeamAbbrev,
    active: true,
    injured: false,
    droppable: true,
    ownership: { percentOwned: opts.percentOwned ?? 10, percentStarted: 5 },
    createdAt: now,
    updatedAt: now,
  });
}

async function seedNewsArticle(
  ctx: TestCtx,
  opts: {
    espnId: string;
    type: string;
    headline: string;
    description?: string;
    athletes: Array<{ id: number; name: string; position?: string }>;
  }
) {
  const now = Date.now();
  await ctx.db.insert("espnNews", {
    espnId: opts.espnId,
    type: opts.type,
    headline: opts.headline,
    description: opts.description,
    lastModified: new Date(now).toISOString(),
    published: new Date(now).toISOString(),
    premium: false,
    links: {},
    images: [],
    categories: { teams: [], athletes: opts.athletes, leagues: [] },
    createdAt: now,
    updatedAt: now,
  });
}

interface MkEntryOpts {
  date?: string;
  shortComment?: string;
  longComment?: string;
  previousStatus?: string;
  position?: string;
  nflTeam?: string;
}

function mkEntry(
  id: string,
  espnId: string,
  name: string,
  status: string,
  opts: MkEntryOpts = {}
): { entry: EspnInjuryEntry; previousStatus?: string } {
  return {
    entry: {
      id,
      status,
      date: opts.date ?? "2026-09-04T20:24:00Z",
      shortComment: opts.shortComment,
      longComment: opts.longComment,
      athlete: { espnId, name, position: opts.position, nflTeam: opts.nflTeam },
    },
    previousStatus: opts.previousStatus,
  };
}

describe("wireDetect: injury status thresholds + dedupe + coalesce", () => {
  it("an OUT designation posts a take_pending card above the take floor", async () => {
    const t = convexTest(schema, modules);

    const result = await t.mutation(internal.wireDetect.ingestInjuryEntries, {
      entries: [
        mkEntry("e1", "9001", "Test Player", "Out", {
          previousStatus: "Active",
          shortComment: "Player is out for the season with a torn ACL.",
        }),
      ],
      fetchedAt: Date.now(),
    });
    expect(result.posted).toBe(1);

    const events = await t.run((ctx) => ctx.db.query("wireEvents").collect());
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("injury_status");
    expect(events[0].interest).toBeGreaterThanOrEqual(50);

    const posts = await t.run((ctx) => ctx.db.query("wirePosts").collect());
    expect(posts).toHaveLength(1);
    expect(posts[0].status).toBe("take_pending");
  });

  it("a second report of the same status within the dedupe window is skipped", async () => {
    const t = convexTest(schema, modules);

    const first = await t.mutation(internal.wireDetect.ingestInjuryEntries, {
      entries: [
        mkEntry("e1", "9002", "Test Player Two", "Out", {
          previousStatus: "Active",
          shortComment: "Placed on injured reserve.",
        }),
      ],
      fetchedAt: Date.now(),
    });
    expect(first.posted).toBe(1);

    // A different entry id/date reporting the identical statusFrom->statusTo transition inside
    // STATUS_DEDUPE_WINDOW_MS is a confirmation, not a new event (spec §6/§7).
    const second = await t.mutation(internal.wireDetect.ingestInjuryEntries, {
      entries: [
        mkEntry("e2", "9002", "Test Player Two", "Out", {
          previousStatus: "Active",
          date: "2026-09-04T20:40:00Z",
          shortComment: "Placed on injured reserve.",
        }),
      ],
      fetchedAt: Date.now(),
    });
    expect(second.posted).toBe(0);
    expect(second.skipped).toBe(1);

    const events = await t.run((ctx) => ctx.db.query("wireEvents").collect());
    expect(events).toHaveLength(1);
  });

  it("a follow-up note for the same player coalesces into the existing post as an UPDATE", async () => {
    const t = convexTest(schema, modules);

    const first = await t.mutation(internal.wireDetect.ingestInjuryEntries, {
      entries: [
        // previousStatus === status -> injury_note, not injury_status
        mkEntry("n1", "9003", "Coalesce Guy", "Questionable", {
          previousStatus: "Questionable",
          date: "2026-09-01T12:00:00Z",
          shortComment: "Coalesce Guy is expected to miss 4-6 weeks with a hamstring issue.",
        }),
      ],
      fetchedAt: Date.now(),
    });
    expect(first.posted).toBe(1);

    const postsAfterFirst = await t.run((ctx) => ctx.db.query("wirePosts").collect());
    expect(postsAfterFirst).toHaveLength(1);
    const originalText = postsAfterFirst[0].text;

    const second = await t.mutation(internal.wireDetect.ingestInjuryEntries, {
      entries: [
        mkEntry("n2", "9003", "Coalesce Guy", "Questionable", {
          previousStatus: "Questionable",
          date: "2026-09-01T18:00:00Z",
          shortComment: "Coalesce Guy is still expected to miss 4-6 weeks; ran routes on the side Tuesday.",
        }),
      ],
      fetchedAt: Date.now(),
    });
    expect(second.coalesced).toBe(1);
    expect(second.posted).toBe(0);

    // Still exactly one post - patched, not duplicated.
    const postsAfterSecond = await t.run((ctx) => ctx.db.query("wirePosts").collect());
    expect(postsAfterSecond).toHaveLength(1);
    expect(postsAfterSecond[0].text).toMatch(/^UPDATE: /);
    expect(postsAfterSecond[0].text).not.toBe(originalText);

    // Two events exist (the original + the coalesced one), the second pointing at the first.
    const events = await t.run((ctx) => ctx.db.query("wireEvents").collect());
    expect(events).toHaveLength(2);
    const coalescedEvent = events.find((e) => e.coalescedInto !== undefined);
    expect(coalescedEvent).toBeDefined();
  });

  it("a status change always gets its own post, never coalesced", async () => {
    const t = convexTest(schema, modules);

    await t.mutation(internal.wireDetect.ingestInjuryEntries, {
      entries: [
        mkEntry("s1", "9004", "Status Guy", "Questionable", {
          previousStatus: "Active",
          date: "2026-09-01T12:00:00Z",
          shortComment: "Listed as questionable with a knee issue.",
        }),
      ],
      fetchedAt: Date.now(),
    });

    const result = await t.mutation(internal.wireDetect.ingestInjuryEntries, {
      entries: [
        mkEntry("s2", "9004", "Status Guy", "Out", {
          previousStatus: "Questionable",
          date: "2026-09-01T18:00:00Z",
          shortComment: "Downgraded to out for Sunday.",
        }),
      ],
      fetchedAt: Date.now(),
    });
    expect(result.posted).toBe(1);
    expect(result.coalesced).toBe(0);

    const posts = await t.run((ctx) => ctx.db.query("wirePosts").collect());
    expect(posts).toHaveLength(2);
  });

  it("downgrades to a card with a rate_limited flag once the hourly take budget is spent", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();

    // Seed the global rate limit's own count: GLOBAL_TAKES_PER_HOUR posts already take_pending
    // in the last hour, sharing one dummy event (referential identity doesn't matter here).
    await t.run(async (ctx) => {
      const eventId = await ctx.db.insert("wireEvents", {
        kind: "injury_status",
        dedupeKey: "filler:seed",
        observedAt: now,
        detectedAt: now,
        players: [{ espnId: "0", name: "Filler" }],
        facts: {},
        interest: 60,
        source: { type: "internal", fetchedAt: now },
      });
      for (let i = 0; i < GLOBAL_TAKES_PER_HOUR; i++) {
        await ctx.db.insert("wirePosts", {
          eventId,
          kind: "injury_status",
          persona: "dex-alvarez",
          text: `Filler take ${i}`,
          tags: ["REPORTED"],
          status: "take_pending",
          interest: 60,
          createdAt: now,
          updatedAt: now,
        });
      }
    });

    const result = await t.mutation(internal.wireDetect.ingestInjuryEntries, {
      entries: [
        mkEntry("rl1", "9005", "Rate Limited Guy", "Out", { previousStatus: "Active", shortComment: "Out for the year." }),
      ],
      fetchedAt: now,
    });
    expect(result.posted).toBe(1);

    const posts = await t.run((ctx) =>
      ctx.db
        .query("wirePosts")
        .filter((q) => q.eq(q.field("persona"), "dex-alvarez"))
        .collect()
    );
    const rateLimitedPost = posts.find((p) => p.generationStats?.flags.includes("rate_limited"));
    expect(rateLimitedPost).toBeDefined();
    expect(rateLimitedPost?.status).toBe("card");
  });

  it("below the card floor, the event is stored but never posted", async () => {
    const t = convexTest(schema, modules);

    const result = await t.mutation(internal.wireDetect.ingestInjuryEntries, {
      entries: [
        mkEntry("low1", "9006", "Quiet Guy", "Active", {
          previousStatus: "Active",
          date: "2026-09-01T12:00:00Z",
          shortComment: "Full participant in practice.",
        }),
      ],
      fetchedAt: Date.now(),
    });
    expect(result.posted).toBe(0);
    expect(result.coalesced).toBe(0);

    const events = await t.run((ctx) => ctx.db.query("wireEvents").collect());
    expect(events).toHaveLength(1);
    const posts = await t.run((ctx) => ctx.db.query("wirePosts").collect());
    expect(posts).toHaveLength(0);
  });
});

describe("wireDetect: getDigestStats desk counts (spec §18 \"Not built\": a digest line for the desk)", () => {
  it("counts lineup moves, late swaps, proposals, claims_in, Sam questions and lock warnings in the window, deployment-wide", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    const since = now - 24 * 60 * 60 * 1000;

    const leagueId = await t.run((ctx) =>
      ctx.db.insert("leagues", {
        name: "Digest Desk League",
        platform: "espn",
        externalId: "77771",
        commissionerUserId: "clerk_digest_commish",
        settings: { scoringType: "PPR", rosterSize: 16, playoffWeeks: 3, categories: [] },
        espnData: { seasonId: 2026, currentScoringPeriod: 3, size: 2, lastSyncedAt: now, isPrivate: false },
        subscription: {
          tier: "season_pass",
          status: "active",
          creditsRemaining: 0,
          creditsMonthly: 0,
          paymentStatus: "completed",
          seasonYear: 2026,
        },
        lastSync: now,
        createdAt: now,
      })
    );

    const insertPost = (kind: string, createdAt: number) =>
      t.run((ctx) =>
        ctx.db.insert("wireLeaguePosts", {
          leagueId,
          seasonId: 2026,
          kind,
          text: "x",
          tags: [],
          featuredTeams: [],
          dedupeKey: `${kind}:${createdAt}:${Math.random()}`,
          createdAt,
        })
      );

    // Inside the window.
    await insertPost("lineup_move", now - 1000);
    await insertPost("lineup_move", now - 2000);
    await insertPost("late_swap", now - 3000);
    await insertPost("trade_proposal", now - 4000);
    await insertPost("claims_in", now - 5000);
    await insertPost("sam_question", now - 6000);
    // Outside the window - never counted.
    await insertPost("lineup_move", since - 1000);

    const userId = await t.run((ctx) =>
      ctx.db.insert("users", {
        clerkId: "clerk_digest_manager",
        name: "Digest Manager",
        hasCompletedOnboarding: true,
        createdAt: now,
        lastActiveAt: now,
      })
    );
    await t.mutation(internal.notifications.createNotification, {
      userId,
      leagueId,
      type: "wire_alert",
      title: "Test Guy is Out and still in your lineup",
      message: "Test Guy (WR) is Out with about 45 minutes to kickoff.",
      relatedEntityType: "wire_post",
      priority: "high",
      deliveryChannels: ["in_app"],
    });
    // A non-wire_alert notification in the same window must never be counted as a lock warning.
    await t.mutation(internal.notifications.createNotification, {
      userId,
      leagueId,
      type: "system_announcement",
      title: "Unrelated",
      message: "Unrelated",
      priority: "low",
      deliveryChannels: ["in_app"],
    });

    const stats = await t.query(internal.wireDetect.getDigestStats, { since });
    expect(stats.desk).toEqual({
      lineupMoves: 2,
      lateSwaps: 1,
      proposals: 1,
      claimsIn: 1,
      lockWarnings: 1,
      samQuestions: 1,
    });
  });
});

describe("wireDetect: Sleeper trending (spec update 2026-09-06 - board + genuine spikes only)", () => {
  it("pre-kickoff: gated, stores nothing at all (no event, no post, no cursor)", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    await t.run((ctx) => seedWeek1Game(ctx, now + DAY)); // kickoff is tomorrow

    const result = await t.run((ctx) => ingestTrendingRows(ctx, [{ espnId: "1", trendingAdds: 50000, rank: 0 }], { now }));
    expect(result).toEqual({ posted: 0, skipped: 0, gated: true, seeded: false, board: false });

    expect(await t.run((ctx) => ctx.db.query("wireEvents").collect())).toHaveLength(0);
    expect(await t.run((ctx) => ctx.db.query("wirePosts").collect())).toHaveLength(0);
    expect(await t.run((ctx) => ctx.db.query("wireSourceState").collect())).toHaveLength(0);
  });

  it("first in-season sync: seeded, posts one trending_board card at fixed interest 40, no spikes", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    await t.run((ctx) => seedWeek1Game(ctx, now - HOUR)); // kickoff already happened

    const rows = [
      { espnId: "b1", trendingAdds: 50000, position: "WR", team: "HOU", rank: 0 },
      { espnId: "b2", trendingAdds: 40000, position: "RB", team: "GB", rank: 1 },
      { espnId: "b3", trendingAdds: 30000, position: "WR", team: "SF", rank: 2 },
      { espnId: "b4", trendingAdds: 20000, position: "RB", team: "TB", rank: 3 },
      { espnId: "b5", trendingAdds: 10000, position: "WR", team: "CAR", rank: 4 },
      { espnId: "b6", trendingAdds: 5000, position: "TE", team: "KC", rank: 5 },
    ];
    const result = await t.run((ctx) => ingestTrendingRows(ctx, rows, { now }));
    expect(result.gated).toBe(false);
    expect(result.seeded).toBe(true);
    expect(result.board).toBe(true);
    expect(result.posted).toBe(0); // spikes are skipped entirely on the seed run

    const posts = await t.run((ctx) => ctx.db.query("wirePosts").collect());
    expect(posts).toHaveLength(1);
    expect(posts[0].kind).toBe("trending_board");
    expect(posts[0].status).toBe("card");
    expect(posts[0].interest).toBe(40);

    const state = await t.run((ctx) =>
      ctx.db
        .query("wireSourceState")
        .withIndex("by_source", (q) => q.eq("source", "sleeper_trending"))
        .first()
    );
    expect(state?.cursor.top).toHaveLength(5);
    expect(state?.cursor.counts.b1).toBe(50000);
  });

  it("a sub-50%-owned player doubling past the floor spikes on the next sync, carrying trendingPrevAdds and a same-team related fact -> take_pending", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    await t.run(async (ctx) => {
      await seedWeek1Game(ctx, now - HOUR);
      await seedPlayer(ctx, { espnId: "riser1", fullName: "Riser Guy", defaultPosition: "WR", proTeamAbbrev: "DEN", percentOwned: 45 });
      // A same-team injury_status event from 1h ago - the "related" fact a take may cite.
      const relatedFacts = {
        kind: "injury_status" as const,
        observedAt: now - HOUR,
        players: [{ espnId: "starter1", name: "Starter Guy", position: "WR", nflTeam: "DEN" }],
        nflTeam: "DEN",
        statusFrom: "Questionable",
        statusTo: "Out",
        source: { type: "espn_injuries" as const, fetchedAt: now - HOUR },
      };
      await ctx.db.insert("wireEvents", {
        kind: "injury_status",
        dedupeKey: "injury_status:starter1:Out",
        observedAt: now - HOUR,
        detectedAt: now - HOUR,
        players: relatedFacts.players,
        primaryEspnId: "starter1",
        nflTeam: "DEN",
        facts: relatedFacts,
        interest: 60,
        source: relatedFacts.source,
      });
    });

    // Seed run: establishes riser1's baseline at 500 adds (spikes are skipped on this run).
    await t.run((ctx) => ingestTrendingRows(ctx, [{ espnId: "riser1", trendingAdds: 500, position: "WR", team: "DEN", rank: 0 }], { now }));

    const secondNow = now + 60_000;
    const second = await t.run((ctx) =>
      ingestTrendingRows(ctx, [{ espnId: "riser1", trendingAdds: 1200, position: "WR", team: "DEN", rank: 0 }], { now: secondNow })
    );
    expect(second.posted).toBe(1);

    const events = await t.run((ctx) =>
      ctx.db
        .query("wireEvents")
        .withIndex("by_kind_detected", (q) => q.eq("kind", "trending"))
        .collect()
    );
    expect(events).toHaveLength(1);
    expect(events[0].facts.trendingPrevAdds).toBe(500);
    expect(events[0].facts.related?.players).toContain("Starter Guy");
    expect(events[0].interest).toBeGreaterThanOrEqual(50);

    const posts = await t.run((ctx) =>
      ctx.db
        .query("wirePosts")
        .withIndex("by_event", (q) => q.eq("eventId", events[0]._id))
        .collect()
    );
    expect(posts[0].status).toBe("take_pending");
  });

  it("a 93%-rostered player at 3x adds never spikes", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    await t.run(async (ctx) => {
      await seedWeek1Game(ctx, now - HOUR);
      await seedPlayer(ctx, { espnId: "chalk1", fullName: "Chalk Guy", defaultPosition: "RB", percentOwned: 93 });
      await ctx.db.insert("wireSourceState", {
        source: "sleeper_trending",
        cursor: { counts: { chalk1: 1000 }, floor: 500, top: ["chalk1"], lastBoardAt: now, syncedAt: now },
        lastRunAt: now,
        ok: true,
        summary: "seed",
      });
    });

    const result = await t.run((ctx) =>
      ingestTrendingRows(ctx, [{ espnId: "chalk1", trendingAdds: 3500, position: "RB", team: "SF", rank: 0 }], { now: now + 60_000 })
    );
    expect(result.posted).toBe(0);

    const events = await t.run((ctx) =>
      ctx.db
        .query("wireEvents")
        .withIndex("by_kind_detected", (q) => q.eq("kind", "trending"))
        .collect()
    );
    expect(events).toHaveLength(0);
  });

  it("a newcomer not in the previous sync's counts compares against the floor", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    await t.run(async (ctx) => {
      await seedWeek1Game(ctx, now - HOUR);
      // percentOwned=20 puts this comfortably above CARD_MIN_INTEREST once the floor math spikes it
      // (interestBase 20 + 20/2 = 30), so `posted` isolates the floor behavior from the card bar.
      await seedPlayer(ctx, { espnId: "newbie1", fullName: "Newbie Guy", defaultPosition: "WR", percentOwned: 20 });
      await ctx.db.insert("wireSourceState", {
        source: "sleeper_trending",
        cursor: { counts: { existing1: 5000 }, floor: 100, top: ["existing1"], lastBoardAt: now, syncedAt: now },
        lastRunAt: now,
        ok: true,
        summary: "seed",
      });
    });

    const result = await t.run((ctx) =>
      ingestTrendingRows(ctx, [{ espnId: "newbie1", trendingAdds: 1500, position: "WR", rank: 0 }], { now: now + 60_000 })
    );
    expect(result.posted).toBe(1);

    const events = await t.run((ctx) =>
      ctx.db
        .query("wireEvents")
        .withIndex("by_kind_detected", (q) => q.eq("kind", "trending"))
        .collect()
    );
    expect(events).toHaveLength(1);
    expect(events[0].facts.trendingPrevAdds).toBe(100);
  });

  it("re-checks the board only after the minimum gap, and dedupes a spike within 24h", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    await t.run(async (ctx) => {
      await seedWeek1Game(ctx, now - HOUR);
      await seedPlayer(ctx, { espnId: "spiker1", fullName: "Spike Guy", defaultPosition: "WR", percentOwned: 10 });
    });

    await t.run((ctx) => ingestTrendingRows(ctx, [{ espnId: "spiker1", trendingAdds: 500, rank: 0 }], { now }));

    const secondNow = now + HOUR;
    const second = await t.run((ctx) => ingestTrendingRows(ctx, [{ espnId: "spiker1", trendingAdds: 1200, rank: 0 }], { now: secondNow }));
    expect(second.posted).toBe(1);
    expect(second.board).toBe(false); // well under TRENDING_BOARD_MIN_GAP_MS since the seed run's board post

    const thirdNow = secondNow + 6 * HOUR;
    const third = await t.run((ctx) => ingestTrendingRows(ctx, [{ espnId: "spiker1", trendingAdds: 2500, rank: 0 }], { now: thirdNow }));
    expect(third.board).toBe(false);
    expect(third.posted).toBe(0);
    expect(third.skipped).toBe(1); // same player, inside the 24h dedupe window

    const events = await t.run((ctx) =>
      ctx.db
        .query("wireEvents")
        .withIndex("by_kind_detected", (q) => q.eq("kind", "trending"))
        .collect()
    );
    expect(events).toHaveLength(1); // only the second sync's spike ever posted
  });

  it("caps spikes at 3 per sync even when more rows qualify", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    const espnIds = ["c1", "c2", "c3", "c4", "c5"];
    await t.run(async (ctx) => {
      await seedWeek1Game(ctx, now - HOUR);
      for (const id of espnIds) await seedPlayer(ctx, { espnId: id, fullName: `Player ${id}`, defaultPosition: "WR", percentOwned: 10 });
    });

    await t.run((ctx) => ingestTrendingRows(ctx, espnIds.map((id, i) => ({ espnId: id, trendingAdds: 100, rank: i })), { now }));

    const secondNow = now + HOUR;
    const rows = espnIds.map((id, i) => ({ espnId: id, trendingAdds: 5000 - i * 10, rank: i }));
    const result = await t.run((ctx) => ingestTrendingRows(ctx, rows, { now: secondNow }));
    expect(result.posted).toBe(3);

    const events = await t.run((ctx) =>
      ctx.db
        .query("wireEvents")
        .withIndex("by_kind_detected", (q) => q.eq("kind", "trending"))
        .collect()
    );
    expect(events).toHaveLength(3);
  });

  it("does not repost the board once the gap has elapsed if the top-5 set is unchanged", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    await t.run((ctx) => seedWeek1Game(ctx, now - HOUR));

    const rows = [
      { espnId: "s1", trendingAdds: 500, rank: 0 },
      { espnId: "s2", trendingAdds: 400, rank: 1 },
      { espnId: "s3", trendingAdds: 300, rank: 2 },
      { espnId: "s4", trendingAdds: 200, rank: 3 },
      { espnId: "s5", trendingAdds: 100, rank: 4 },
    ];
    const first = await t.run((ctx) => ingestTrendingRows(ctx, rows, { now }));
    expect(first.board).toBe(true);

    const laterNow = now + 21 * HOUR;
    const second = await t.run((ctx) =>
      ingestTrendingRows(ctx, rows.map((r) => ({ ...r, trendingAdds: r.trendingAdds + 5 })), { now: laterNow })
    );
    expect(second.board).toBe(false);

    const boardPosts = await t.run((ctx) =>
      ctx.db
        .query("wirePosts")
        .filter((q) => q.eq(q.field("kind"), "trending_board"))
        .collect()
    );
    expect(boardPosts).toHaveLength(1);
  });

  it("fanOutGlobalPost creates no per-league overlays for a trending_board post", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    const postId = await t.run(async (ctx) => {
      const eventId = await ctx.db.insert("wireEvents", {
        kind: "trending_board",
        dedupeKey: "trending_board:seed",
        observedAt: now,
        detectedAt: now,
        players: [{ espnId: "1", name: "Board Guy" }],
        facts: {
          kind: "trending_board",
          observedAt: now,
          players: [{ espnId: "1", name: "Board Guy" }],
          board: [{ espnId: "1", name: "Board Guy", trendingAdds: 5000 }],
          source: { type: "sleeper", fetchedAt: now },
        },
        interest: 40,
        source: { type: "sleeper", fetchedAt: now },
      });
      return ctx.db.insert("wirePosts", {
        eventId,
        kind: "trending_board",
        persona: "nina-sharpe",
        text: "Most added on Sleeper, last 24 h: Board Guy 5,000",
        tags: ["REPORTED"],
        status: "card",
        interest: 40,
        createdAt: now,
        updatedAt: now,
      });
    });

    await t.mutation(internal.wireOverlay.fanOutGlobalPost, { postId });

    const overlays = await t.run((ctx) =>
      ctx.db
        .query("wireLeaguePosts")
        .withIndex("by_global_post", (q) => q.eq("globalPostId", postId))
        .collect()
    );
    expect(overlays).toHaveLength(0);
  });
});

describe("wireDetect: ESPN news relevance-gated posting (spec update 2026-09-06)", () => {
  it("skips a feature Story with no injury/role/transaction signal, storing no event", async () => {
    const t = convexTest(schema, modules);
    await t.run((ctx) =>
      seedNewsArticle(ctx, {
        espnId: "story1",
        type: "Story",
        headline: "The story behind Steelers' viral field blessing: 'God doesn't pick sides'",
        description: "Before every home game, a local pastor blesses the Acrisure Stadium turf.",
        athletes: [{ id: 9999, name: "Aaron Rodgers" }],
      })
    );

    const result = await t.mutation(internal.wireDetect.ingestNews, { espnIds: ["story1"] });
    expect(result).toEqual({ posted: 0, stored: 0, skipped: 1 });

    const events = await t.run((ctx) => ctx.db.query("wireEvents").collect());
    expect(events).toHaveLength(0);
  });

  it("stores a HeadlineNews event without posting when it never clears the take bar and has no timetable", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await seedPlayer(ctx, { espnId: "hn1", fullName: "Headline Guy", defaultPosition: "RB", percentOwned: 30 });
      await seedNewsArticle(ctx, {
        espnId: "headline1",
        type: "HeadlineNews",
        headline: "Headline Guy's court date moved up",
        description: "A minor legal matter, nothing to do with football.",
        athletes: [{ id: 1, name: "Headline Guy" }],
      });
    });

    const result = await t.mutation(internal.wireDetect.ingestNews, { espnIds: ["headline1"] });
    expect(result).toEqual({ posted: 0, stored: 1, skipped: 0 });

    const events = await t.run((ctx) => ctx.db.query("wireEvents").collect());
    expect(events).toHaveLength(1);
    const posts = await t.run((ctx) => ctx.db.query("wirePosts").collect());
    expect(posts).toHaveLength(0);
  });

  it("posts as a card once a timetable shows up, even when the raw interest falls short of take_pending", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await seedPlayer(ctx, { espnId: "tt1", fullName: "Timetable Guy", defaultPosition: "WR", percentOwned: 15 });
      await seedNewsArticle(ctx, {
        espnId: "story2",
        type: "Story",
        headline: "Timetable Guy is day-to-day with a minor ailment",
        description: "The receiver tweaked something in practice Wednesday.",
        athletes: [{ id: 2, name: "Timetable Guy" }],
      });
    });

    // interestBase(news, timetable) = 40, + 15/2 = 47.5 -> 48: below TAKE_MIN_INTEREST (50), so
    // without the timetable bypass this would only be a stored event (like the HeadlineNews case
    // above). The timetable forces the post; createPostForEvent still decides card vs. take_pending
    // on the raw interest alone, so it lands as a card.
    const result = await t.mutation(internal.wireDetect.ingestNews, { espnIds: ["story2"] });
    expect(result).toEqual({ posted: 1, stored: 0, skipped: 0 });

    const posts = await t.run((ctx) => ctx.db.query("wirePosts").collect());
    expect(posts).toHaveLength(1);
    expect(posts[0].status).toBe("card");
  });

  it("posts the real-world motivating case - a multi-week timetable on a widely-rostered player", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await seedPlayer(ctx, { espnId: "tt2", fullName: "Rehab Guy", defaultPosition: "WR", percentOwned: 40 });
      await seedNewsArticle(ctx, {
        espnId: "story3",
        type: "Story",
        headline: "Rehab Guy expected to miss 4-6 weeks with a hamstring injury",
        description: "The receiver popped his hamstring in practice Wednesday.",
        athletes: [{ id: 3, name: "Rehab Guy" }],
      });
    });

    const result = await t.mutation(internal.wireDetect.ingestNews, { espnIds: ["story3"] });
    expect(result.posted).toBe(1);
    const posts = await t.run((ctx) => ctx.db.query("wirePosts").collect());
    expect(posts[0].status).toBe("take_pending");
  });

  it("builds a card capped at 3 players with the headline-named athlete first, from a 4-athlete article", async () => {
    const t = convexTest(schema, modules);
    await t.run((ctx) =>
      seedNewsArticle(ctx, {
        espnId: "henderson1",
        type: "Story",
        headline: "What will Patriots do if RB TreVeyon Henderson is out Week 1?",
        description: "New England may lean on a committee if Henderson can't go.",
        athletes: [
          { id: 1, name: "Rhamondre Stevenson" },
          { id: 2, name: "Antonio Gibson" },
          { id: 3, name: "TreVeyon Henderson" },
          { id: 4, name: "Terrell Jennings" },
        ],
      })
    );

    const result = await t.mutation(internal.wireDetect.ingestNews, { espnIds: ["henderson1"] });
    expect(result.skipped).toBe(0);

    const events = await t.run((ctx) => ctx.db.query("wireEvents").collect());
    expect(events).toHaveLength(1);
    const players = events[0].facts.players as Array<{ name: string }>;
    expect(players).toHaveLength(3);
    expect(players[0].name).toBe("TreVeyon Henderson");
    expect(players.map((p) => p.name)).not.toContain("Terrell Jennings");
  });
});
