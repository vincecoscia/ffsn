import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import schema from "../../convex/schema";
import { internal } from "../../convex/_generated/api";
import { GLOBAL_TAKES_PER_HOUR } from "../../src/lib/ai/wire/types";
import type { EspnInjuryEntry } from "../../src/lib/ai/wire/espn";

const modules = import.meta.glob("../../convex/**/*.*s");

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
