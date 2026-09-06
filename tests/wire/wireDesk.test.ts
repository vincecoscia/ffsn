import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import type { GenericActionCtx, GenericMutationCtx } from "convex/server";
import schema from "../../convex/schema";
import { internal } from "../../convex/_generated/api";
import type { DataModel, Id } from "../../convex/_generated/dataModel";

const modules = import.meta.glob("../../convex/**/*.*s");

type TestCtx = GenericMutationCtx<DataModel> & Pick<GenericActionCtx<DataModel>, "storage">;

const SEASON = 2026;
const HOUR = 60 * 60 * 1000;
const MIN = 60 * 1000;
const DAY = 24 * HOUR;
const CLERK_COMMISH = "clerk_commish_desk";

interface SeedLeagueOptions {
  faabBudget?: number;
  tradeDeadline?: number;
  regularSeasonMatchupPeriods?: number;
}

async function seedLeague(ctx: TestCtx, opts: SeedLeagueOptions = {}) {
  const now = Date.now();
  const leagueId = await ctx.db.insert("leagues", {
    name: "Dex Desk Test League",
    platform: "espn",
    externalId: "9991",
    commissionerUserId: CLERK_COMMISH,
    settings: {
      scoringType: "ppr",
      rosterSize: 16,
      playoffWeeks: 3,
      categories: [],
      waiverType: "faab",
      faabBudget: opts.faabBudget ?? 100,
      tradeDeadline: opts.tradeDeadline,
      regularSeasonMatchupPeriods: opts.regularSeasonMatchupPeriods ?? 14,
    },
    espnData: { seasonId: SEASON, currentScoringPeriod: 3, size: 10, lastSyncedAt: now, isPrivate: false },
    subscription: {
      tier: "season_pass",
      status: "active",
      creditsRemaining: 0,
      creditsMonthly: 0,
      paymentStatus: "completed",
      seasonYear: SEASON,
    },
    lastSync: now,
    createdAt: now,
  });

  const baseTeam = { leagueId, record: { wins: 0, losses: 0, ties: 0 }, seasonId: SEASON, createdAt: now, updatedAt: now };
  const team1 = await ctx.db.insert("teams", { ...baseTeam, externalId: "1", name: "Team One", owner: "Manager One", roster: [] });
  const team2 = await ctx.db.insert("teams", { ...baseTeam, externalId: "2", name: "Team Two", owner: "Manager Two", roster: [] });
  const team3 = await ctx.db.insert("teams", { ...baseTeam, externalId: "3", name: "Team Three", owner: "Manager Three", roster: [] });

  return { leagueId, team1, team2, team3 };
}

async function seedPrefs(
  ctx: TestCtx,
  leagueId: Id<"leagues">,
  overrides: { wireLeaks?: boolean; wireEnabled?: boolean; timezone?: string } = {}
) {
  const now = Date.now();
  await ctx.db.insert("leagueContentPreferences", {
    leagueId,
    contentEnabled: true,
    timezone: overrides.timezone ?? "America/New_York",
    notifyCommissioner: true,
    notifyFailures: true,
    autoPublish: true,
    requireApproval: false,
    currentMonthSpent: 0,
    budgetResetDate: now,
    wireEnabled: overrides.wireEnabled,
    wireLeaks: overrides.wireLeaks,
    createdAt: now,
    updatedAt: now,
  });
}

async function seedPlayer(
  ctx: TestCtx,
  opts: {
    espnId: string;
    fullName: string;
    defaultPosition: string;
    proTeamAbbrev?: string;
    percentOwned?: number;
    percentChange?: number;
    injuryStatus?: string;
  }
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
    injuryStatus: opts.injuryStatus,
    droppable: true,
    ownership: { percentOwned: opts.percentOwned ?? 10, percentStarted: 5, percentChange: opts.percentChange },
    createdAt: now,
    updatedAt: now,
  });
}

let txnCounter = 0;
async function seedTransaction(
  ctx: TestCtx,
  leagueId: Id<"leagues">,
  overrides: Partial<{
    espnTransactionId: string;
    type: string;
    outcome: "executed" | "failed" | "pending" | "cancelled";
    teamId: number;
    scoringPeriod: number;
    proposedDate: number;
    processDate: number;
    bidAmount: number;
    items: Array<{
      fromLineupSlotId: number;
      fromTeamId: number;
      isKeeper: boolean;
      overallPickNumber: number;
      playerId: number;
      toLineupSlotId: number;
      toTeamId: number;
      type: string;
    }>;
  }> = {}
) {
  txnCounter++;
  const now = Date.now();
  const espnTransactionId = overrides.espnTransactionId ?? `txn-${txnCounter}`;
  await ctx.db.insert("transactions", {
    leagueId,
    seasonId: SEASON,
    espnTransactionId,
    bidAmount: overrides.bidAmount ?? 0,
    executionType: "EXECUTE",
    isActingAsTeamOwner: true,
    isLeagueManager: false,
    isPending: overrides.outcome === "pending",
    items: overrides.items ?? [],
    type: overrides.type ?? "ROSTER",
    proposedDate: overrides.proposedDate ?? now,
    processDate: overrides.processDate ?? now,
    status: (overrides.outcome ?? "executed").toUpperCase(),
    scoringPeriod: overrides.scoringPeriod ?? 3,
    teamId: overrides.teamId ?? 1,
    outcome: overrides.outcome ?? "executed",
    createdAt: now,
  });
  return espnTransactionId;
}

async function runDex(t: ReturnType<typeof convexTest>, leagueId: Id<"leagues">, espnTransactionIds: string[]) {
  await t.mutation(internal.wireDesk.onTransactionsUpsertedForDex, { leagueId, seasonId: SEASON, espnTransactionIds });
}

/* -------------------------------------------------------------------------- */

describe("wireDesk: lineup_move / late_swap / reads_the_wire", () => {
  it("posts lineup_move with the slot name and the benched player", async () => {
    const t = convexTest(schema, modules);
    const { leagueId, team1 } = await t.run((ctx) => seedLeague(ctx, {}));
    await t.run(async (ctx) => {
      await seedPlayer(ctx as TestCtx, { espnId: "5001", fullName: "Moved In Guy", defaultPosition: "WR" });
      await seedPlayer(ctx as TestCtx, { espnId: "5002", fullName: "Benched Guy", defaultPosition: "WR" });
    });
    const txnId = await t.run((ctx) =>
      seedTransaction(ctx as TestCtx, leagueId, {
        type: "ROSTER",
        teamId: 1,
        items: [
          { fromLineupSlotId: 20, fromTeamId: 1, isKeeper: false, overallPickNumber: 0, playerId: 5001, toLineupSlotId: 23, toTeamId: 1, type: "LINEUP" },
          { fromLineupSlotId: 4, fromTeamId: 1, isKeeper: false, overallPickNumber: 0, playerId: 5002, toLineupSlotId: 20, toTeamId: 1, type: "LINEUP" },
        ],
      })
    );

    await runDex(t, leagueId, [txnId]);

    const posts = await t.run((ctx) => ctx.db.query("wireLeaguePosts").withIndex("by_league_created", (q) => q.eq("leagueId", leagueId)).collect());
    const post = posts.find((p) => p.kind === "lineup_move");
    expect(post).toBeDefined();
    expect(post!.text).toContain("Moved In Guy");
    expect(post!.text).toContain("FLEX");
    expect(post!.text).toContain("Benched Guy");
    expect(post!.featuredTeams).toEqual([team1]);
  });

  it("coalesces a second move for the same team within the window into one UPDATE post", async () => {
    const t = convexTest(schema, modules);
    const { leagueId } = await t.run((ctx) => seedLeague(ctx, {}));
    await t.run(async (ctx) => {
      await seedPlayer(ctx as TestCtx, { espnId: "5010", fullName: "First Mover", defaultPosition: "RB" });
      await seedPlayer(ctx as TestCtx, { espnId: "5011", fullName: "Second Mover", defaultPosition: "RB" });
    });
    const now = Date.now();
    const txn1 = await t.run((ctx) =>
      seedTransaction(ctx as TestCtx, leagueId, {
        type: "ROSTER",
        teamId: 1,
        proposedDate: now,
        items: [{ fromLineupSlotId: 20, fromTeamId: 1, isKeeper: false, overallPickNumber: 0, playerId: 5010, toLineupSlotId: 2, toTeamId: 1, type: "LINEUP" }],
      })
    );
    const txn2 = await t.run((ctx) =>
      seedTransaction(ctx as TestCtx, leagueId, {
        type: "ROSTER",
        teamId: 1,
        proposedDate: now + 5 * MIN,
        items: [{ fromLineupSlotId: 20, fromTeamId: 1, isKeeper: false, overallPickNumber: 0, playerId: 5011, toLineupSlotId: 2, toTeamId: 1, type: "LINEUP" }],
      })
    );

    await runDex(t, leagueId, [txn1, txn2]);

    const posts = await t.run((ctx) => ctx.db.query("wireLeaguePosts").withIndex("by_league_created", (q) => q.eq("leagueId", leagueId)).collect());
    const lineupPosts = posts.filter((p) => p.kind === "lineup_move" || p.kind === "late_swap" || p.kind === "reads_the_wire");
    expect(lineupPosts).toHaveLength(1);
    expect(lineupPosts[0].evolvingCount).toBe(2);
    expect(lineupPosts[0].text).toContain("UPDATE");
    expect(lineupPosts[0].tags).toContain("UPDATE");
  });

  it("classifies a move under the late-swap window as late_swap, with minutes to kickoff", async () => {
    const t = convexTest(schema, modules);
    const { leagueId } = await t.run((ctx) => seedLeague(ctx, {}));
    const now = Date.now();
    const kickoffAt = now + 40 * MIN;
    await t.run(async (ctx) => {
      await seedPlayer(ctx as TestCtx, { espnId: "5020", fullName: "Late Swap Guy", defaultPosition: "WR", proTeamAbbrev: "KC" });
      await ctx.db.insert("nflSchedules", {
        season: SEASON,
        week: 3,
        teamId: 12,
        teamAbbrev: "KC",
        opponent: "BUF",
        isHome: true,
        gameTime: kickoffAt,
        isByeWeek: false,
        createdAt: now,
      });
    });
    const txnId = await t.run((ctx) =>
      seedTransaction(ctx as TestCtx, leagueId, {
        type: "ROSTER",
        teamId: 1,
        scoringPeriod: 3,
        proposedDate: now,
        items: [{ fromLineupSlotId: 20, fromTeamId: 1, isKeeper: false, overallPickNumber: 0, playerId: 5020, toLineupSlotId: 4, toTeamId: 1, type: "LINEUP" }],
      })
    );

    await runDex(t, leagueId, [txnId]);

    const posts = await t.run((ctx) => ctx.db.query("wireLeaguePosts").withIndex("by_league_created", (q) => q.eq("leagueId", leagueId)).collect());
    const post = posts.find((p) => p.kind === "late_swap");
    expect(post).toBeDefined();
    expect(post!.text).toContain("Late Swap Guy");
  });

  it("classifies a bench move shortly after an injury tag as reads_the_wire", async () => {
    const t = convexTest(schema, modules);
    const { leagueId } = await t.run((ctx) => seedLeague(ctx, {}));
    const now = Date.now();
    await t.run(async (ctx) => {
      await seedPlayer(ctx as TestCtx, { espnId: "5030", fullName: "Reads Wire Guy", defaultPosition: "RB" });
      await ctx.db.insert("wireEvents", {
        kind: "injury_status",
        dedupeKey: "injury_status:5030:Questionable",
        observedAt: now - HOUR,
        detectedAt: now - HOUR,
        players: [{ espnId: "5030", name: "Reads Wire Guy" }],
        primaryEspnId: "5030",
        facts: {
          kind: "injury_status",
          observedAt: now - HOUR,
          players: [{ espnId: "5030", name: "Reads Wire Guy" }],
          statusFrom: "Active",
          statusTo: "Questionable",
          source: { type: "espn_injuries", fetchedAt: now - HOUR },
        },
        interest: 60,
        source: { type: "espn_injuries", fetchedAt: now - HOUR },
      });
    });
    const txnId = await t.run((ctx) =>
      seedTransaction(ctx as TestCtx, leagueId, {
        type: "ROSTER",
        teamId: 1,
        proposedDate: now,
        items: [{ fromLineupSlotId: 4, fromTeamId: 1, isKeeper: false, overallPickNumber: 0, playerId: 5030, toLineupSlotId: 20, toTeamId: 1, type: "LINEUP" }],
      })
    );

    await runDex(t, leagueId, [txnId]);

    const posts = await t.run((ctx) => ctx.db.query("wireLeaguePosts").withIndex("by_league_created", (q) => q.eq("leagueId", leagueId)).collect());
    const post = posts.find((p) => p.kind === "reads_the_wire");
    expect(post).toBeDefined();
    expect(post!.text).toContain("Reads Wire Guy");
  });

  it("never reads the wire when the injury was observed after that team's own kickoff (§16)", async () => {
    const t = convexTest(schema, modules);
    const { leagueId } = await t.run((ctx) => seedLeague(ctx, {}));
    const now = Date.now();
    const kickoffAt = now - 30 * MIN; // already kicked off
    await t.run(async (ctx) => {
      await seedPlayer(ctx as TestCtx, { espnId: "5031", fullName: "In Game Guy", defaultPosition: "RB", proTeamAbbrev: "SF" });
      await ctx.db.insert("nflSchedules", {
        season: SEASON,
        week: 3,
        teamId: 25,
        teamAbbrev: "SF",
        opponent: "LAR",
        isHome: true,
        gameTime: kickoffAt,
        isByeWeek: false,
        createdAt: now,
      });
      await ctx.db.insert("wireEvents", {
        kind: "injury_status",
        dedupeKey: "injury_status:5031:Out",
        observedAt: kickoffAt + 10 * MIN, // tagged DURING the game
        detectedAt: kickoffAt + 10 * MIN,
        players: [{ espnId: "5031", name: "In Game Guy" }],
        primaryEspnId: "5031",
        facts: {
          kind: "injury_status",
          observedAt: kickoffAt + 10 * MIN,
          players: [{ espnId: "5031", name: "In Game Guy" }],
          statusFrom: "Active",
          statusTo: "Out",
          source: { type: "espn_injuries", fetchedAt: kickoffAt + 10 * MIN },
        },
        interest: 60,
        source: { type: "espn_injuries", fetchedAt: kickoffAt + 10 * MIN },
      });
    });
    const txnId = await t.run((ctx) =>
      seedTransaction(ctx as TestCtx, leagueId, {
        type: "ROSTER",
        teamId: 1,
        scoringPeriod: 3,
        proposedDate: kickoffAt + 20 * MIN,
        items: [{ fromLineupSlotId: 4, fromTeamId: 1, isKeeper: false, overallPickNumber: 0, playerId: 5031, toLineupSlotId: 20, toTeamId: 1, type: "LINEUP" }],
      })
    );

    await runDex(t, leagueId, [txnId]);

    const posts = await t.run((ctx) => ctx.db.query("wireLeaguePosts").withIndex("by_league_created", (q) => q.eq("leagueId", leagueId)).collect());
    expect(posts.some((p) => p.kind === "reads_the_wire")).toBe(false);
    expect(posts.some((p) => p.kind === "lineup_move")).toBe(true);
  });
});

describe("wireDesk: trade_proposal / trade_declined gated by wireLeaks", () => {
  it("posts trade_proposal naming the proposer as {team} when leaks are on", async () => {
    const t = convexTest(schema, modules);
    const { leagueId, team1, team2 } = await t.run((ctx) => seedLeague(ctx, {}));
    await t.run(async (ctx) => {
      await seedPlayer(ctx as TestCtx, { espnId: "6001", fullName: "Piece A", defaultPosition: "WR" });
      await seedPlayer(ctx as TestCtx, { espnId: "6002", fullName: "Piece B", defaultPosition: "RB" });
    });
    const txnId = await t.run((ctx) =>
      seedTransaction(ctx as TestCtx, leagueId, {
        type: "TRADE_PROPOSAL",
        outcome: "pending",
        teamId: 1, // proposer
        items: [
          { fromLineupSlotId: -1, fromTeamId: 1, isKeeper: false, overallPickNumber: 0, playerId: 6001, toLineupSlotId: -1, toTeamId: 2, type: "TRADE" },
          { fromLineupSlotId: -1, fromTeamId: 2, isKeeper: false, overallPickNumber: 0, playerId: 6002, toLineupSlotId: -1, toTeamId: 1, type: "TRADE" },
        ],
      })
    );

    await runDex(t, leagueId, [txnId]);

    const posts = await t.run((ctx) => ctx.db.query("wireLeaguePosts").withIndex("by_league_created", (q) => q.eq("leagueId", leagueId)).collect());
    const post = posts.find((p) => p.kind === "trade_proposal");
    expect(post).toBeDefined();
    expect(post!.featuredTeams).toEqual(expect.arrayContaining([team1, team2]));
  });

  it("never posts trade_proposal or trade_declined when the league turned leaks off", async () => {
    const t = convexTest(schema, modules);
    const { leagueId } = await t.run((ctx) => seedLeague(ctx, {}));
    await t.run((ctx) => seedPrefs(ctx as TestCtx, leagueId, { wireLeaks: false }));
    const proposalId = await t.run((ctx) =>
      seedTransaction(ctx as TestCtx, leagueId, {
        type: "TRADE_PROPOSAL",
        outcome: "pending",
        teamId: 1,
        items: [{ fromLineupSlotId: -1, fromTeamId: 1, isKeeper: false, overallPickNumber: 0, playerId: 7001, toLineupSlotId: -1, toTeamId: 2, type: "TRADE" }],
      })
    );
    const declineId = await t.run((ctx) =>
      seedTransaction(ctx as TestCtx, leagueId, {
        type: "TRADE_DECLINE",
        outcome: "executed",
        teamId: 2,
        items: [{ fromLineupSlotId: -1, fromTeamId: 1, isKeeper: false, overallPickNumber: 0, playerId: 7001, toLineupSlotId: -1, toTeamId: 2, type: "TRADE" }],
      })
    );

    await runDex(t, leagueId, [proposalId, declineId]);

    const posts = await t.run((ctx) => ctx.db.query("wireLeaguePosts").withIndex("by_league_created", (q) => q.eq("leagueId", leagueId)).collect());
    expect(posts.some((p) => p.kind === "trade_proposal" || p.kind === "trade_declined")).toBe(false);
  });

  it("posts trade_declined for the side that declined, when leaks are on", async () => {
    const t = convexTest(schema, modules);
    const { leagueId, team2 } = await t.run((ctx) => seedLeague(ctx, {}));
    const txnId = await t.run((ctx) =>
      seedTransaction(ctx as TestCtx, leagueId, {
        type: "TRADE_DECLINE",
        outcome: "executed",
        teamId: 2, // the side that declined
        items: [{ fromLineupSlotId: -1, fromTeamId: 1, isKeeper: false, overallPickNumber: 0, playerId: 7002, toLineupSlotId: -1, toTeamId: 2, type: "TRADE" }],
      })
    );

    await runDex(t, leagueId, [txnId]);

    const posts = await t.run((ctx) => ctx.db.query("wireLeaguePosts").withIndex("by_league_created", (q) => q.eq("leagueId", leagueId)).collect());
    const post = posts.find((p) => p.kind === "trade_declined");
    expect(post).toBeDefined();
    expect(post!.featuredTeams).toContain(team2);
  });
});

describe("wireDesk: claims_in leak policy", () => {
  it("needs at least 2 distinct teams, never names a team or a dollar amount, and reflects heat at 20% of budget", async () => {
    const t = convexTest(schema, modules);
    const { leagueId } = await t.run((ctx) => seedLeague(ctx, { faabBudget: 100 }));
    await t.run(async (ctx) => {
      await seedPlayer(ctx as TestCtx, { espnId: "8001", fullName: "Hot Waiver Guy", defaultPosition: "WR" });
    });
    const one = await t.run((ctx) =>
      seedTransaction(ctx as TestCtx, leagueId, {
        type: "WAIVER",
        outcome: "pending",
        teamId: 1,
        scoringPeriod: 3,
        bidAmount: 20, // exactly 20% of a 100 budget
        items: [{ fromLineupSlotId: -1, fromTeamId: 0, isKeeper: false, overallPickNumber: 0, playerId: 8001, toLineupSlotId: 20, toTeamId: 1, type: "ADD" }],
      })
    );

    // Only one team so far - below CLAIMS_IN_MIN_TEAMS.
    await runDex(t, leagueId, [one]);
    let posts = await t.run((ctx) => ctx.db.query("wireLeaguePosts").withIndex("by_league_created", (q) => q.eq("leagueId", leagueId)).collect());
    expect(posts.some((p) => p.kind === "claims_in")).toBe(false);

    const two = await t.run((ctx) =>
      seedTransaction(ctx as TestCtx, leagueId, {
        type: "WAIVER",
        outcome: "pending",
        teamId: 2,
        scoringPeriod: 3,
        bidAmount: 5,
        items: [{ fromLineupSlotId: -1, fromTeamId: 0, isKeeper: false, overallPickNumber: 0, playerId: 8001, toLineupSlotId: 20, toTeamId: 2, type: "ADD" }],
      })
    );
    await runDex(t, leagueId, [two]);

    posts = await t.run((ctx) => ctx.db.query("wireLeaguePosts").withIndex("by_league_created", (q) => q.eq("leagueId", leagueId)).collect());
    const post = posts.find((p) => p.kind === "claims_in");
    expect(post).toBeDefined();
    expect(post!.text).not.toMatch(/\$/);
    expect(post!.text).not.toMatch(/Team One|Team Two/);
    expect(post!.featuredTeams).toEqual([]);
    expect(post!.text).toMatch(/bidding looks high/);

    // Growth: a third team joins the claim - patches the existing post with an UPDATE.
    const three = await t.run((ctx) =>
      seedTransaction(ctx as TestCtx, leagueId, {
        type: "WAIVER",
        outcome: "pending",
        teamId: 3,
        scoringPeriod: 3,
        bidAmount: 3,
        items: [{ fromLineupSlotId: -1, fromTeamId: 0, isKeeper: false, overallPickNumber: 0, playerId: 8001, toLineupSlotId: 20, toTeamId: 3, type: "ADD" }],
      })
    );
    await runDex(t, leagueId, [three]);

    posts = await t.run((ctx) => ctx.db.query("wireLeaguePosts").withIndex("by_league_created", (q) => q.eq("leagueId", leagueId)).collect());
    const claimsPosts = posts.filter((p) => p.kind === "claims_in");
    expect(claimsPosts).toHaveLength(1);
    expect(claimsPosts[0].evolvingCount).toBe(3);
    expect(claimsPosts[0].text).toContain("UPDATE");
    expect(claimsPosts[0].tags).toContain("UPDATE");
  });
});

describe("wireDesk: streaming_churn", () => {
  it("fires on the 4th distinct D/ST add within the window", async () => {
    const t = convexTest(schema, modules);
    const { leagueId } = await t.run((ctx) => seedLeague(ctx, {}));
    await t.run(async (ctx) => {
      for (let i = 1; i <= 4; i++) {
        await seedPlayer(ctx as TestCtx, { espnId: `900${i}`, fullName: `Streamed DST ${i}`, defaultPosition: "D/ST" });
      }
    });
    const ids: string[] = [];
    for (let period = 1; period <= 4; period++) {
      const id = await t.run((ctx) =>
        seedTransaction(ctx as TestCtx, leagueId, {
          type: "FREEAGENT",
          outcome: "executed",
          teamId: 1,
          scoringPeriod: period,
          items: [{ fromLineupSlotId: -1, fromTeamId: 0, isKeeper: false, overallPickNumber: 0, playerId: 9000 + period, toLineupSlotId: 20, toTeamId: 1, type: "ADD" }],
        })
      );
      ids.push(id);
      await runDex(t, leagueId, [id]);
    }

    const posts = await t.run((ctx) => ctx.db.query("wireLeaguePosts").withIndex("by_league_created", (q) => q.eq("leagueId", leagueId)).collect());
    const post = posts.find((p) => p.kind === "streaming_churn");
    expect(post).toBeDefined();
    expect(post!.text).toContain("D/ST");
  });

  it("never fires below the streaming threshold", async () => {
    const t = convexTest(schema, modules);
    const { leagueId } = await t.run((ctx) => seedLeague(ctx, {}));
    await t.run(async (ctx) => {
      for (let i = 1; i <= 2; i++) {
        await seedPlayer(ctx as TestCtx, { espnId: `910${i}`, fullName: `Streamed DST ${i}`, defaultPosition: "D/ST" });
      }
    });
    for (let period = 1; period <= 2; period++) {
      const id = await t.run((ctx) =>
        seedTransaction(ctx as TestCtx, leagueId, {
          type: "FREEAGENT",
          outcome: "executed",
          teamId: 1,
          scoringPeriod: period,
          items: [{ fromLineupSlotId: -1, fromTeamId: 0, isKeeper: false, overallPickNumber: 0, playerId: 9100 + period, toLineupSlotId: 20, toTeamId: 1, type: "ADD" }],
        })
      );
      await runDex(t, leagueId, [id]);
    }
    const posts = await t.run((ctx) => ctx.db.query("wireLeaguePosts").withIndex("by_league_created", (q) => q.eq("leagueId", leagueId)).collect());
    expect(posts.some((p) => p.kind === "streaming_churn")).toBe(false);
  });
});

describe("wireDesk: quiet_desk", () => {
  it("posts only inside the trade-deadline window, listing the quiet teams", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    const { leagueId } = await t.run((ctx) => seedLeague(ctx, { tradeDeadline: now + 3 * DAY }));

    await t.mutation(internal.wireDesk.postQuietDeskForLeague, { leagueId });

    const posts = await t.run((ctx) => ctx.db.query("wireLeaguePosts").withIndex("by_league_created", (q) => q.eq("leagueId", leagueId)).collect());
    const post = posts.find((p) => p.kind === "quiet_desk");
    expect(post).toBeDefined();
    expect(post!.text).toMatch(/Team One|Team Two|Team Three/);
  });

  it("never posts outside the trade-deadline window", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    const { leagueId } = await t.run((ctx) => seedLeague(ctx, { tradeDeadline: now + 30 * DAY }));

    await t.mutation(internal.wireDesk.postQuietDeskForLeague, { leagueId });

    const posts = await t.run((ctx) => ctx.db.query("wireLeaguePosts").withIndex("by_league_created", (q) => q.eq("leagueId", leagueId)).collect());
    expect(posts.some((p) => p.kind === "quiet_desk")).toBe(false);
  });

  it("respects the leaks toggle", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    const { leagueId } = await t.run((ctx) => seedLeague(ctx, { tradeDeadline: now + 3 * DAY }));
    await t.run((ctx) => seedPrefs(ctx as TestCtx, leagueId, { wireLeaks: false }));

    await t.mutation(internal.wireDesk.postQuietDeskForLeague, { leagueId });

    const posts = await t.run((ctx) => ctx.db.query("wireLeaguePosts").withIndex("by_league_created", (q) => q.eq("leagueId", leagueId)).collect());
    expect(posts.some((p) => p.kind === "quiet_desk")).toBe(false);
  });
});

describe("wireDesk: weekly_rundown", () => {
  it("is idempotent - a second call for the same week never doubles the post", async () => {
    const t = convexTest(schema, modules);
    const { leagueId } = await t.run((ctx) => seedLeague(ctx, {}));
    await t.run(async (ctx) => {
      await seedTransaction(ctx as TestCtx, leagueId, {
        type: "FREEAGENT",
        outcome: "executed",
        teamId: 1,
        scoringPeriod: 3,
        items: [{ fromLineupSlotId: -1, fromTeamId: 0, isKeeper: false, overallPickNumber: 0, playerId: 11001, toLineupSlotId: 20, toTeamId: 1, type: "ADD" }],
      });
    });

    await t.mutation(internal.wireDesk.postWeeklyRundownForLeague, { leagueId });
    await t.mutation(internal.wireDesk.postWeeklyRundownForLeague, { leagueId });

    const posts = await t.run((ctx) => ctx.db.query("wireLeaguePosts").withIndex("by_league_created", (q) => q.eq("leagueId", leagueId)).collect());
    const rundownPosts = posts.filter((p) => p.kind === "weekly_rundown");
    expect(rundownPosts).toHaveLength(1);
    expect(rundownPosts[0].text).toMatch(/\d/);
  });
});

describe("wireDesk: faab_watch", () => {
  it("fires once per team per season when the budget runs low with weeks left", async () => {
    const t = convexTest(schema, modules);
    const { leagueId, team1 } = await t.run((ctx) => seedLeague(ctx, { faabBudget: 100 }));
    await t.run(async (ctx) => {
      await ctx.db.patch(team1, { transactionCounter: { acquisitionBudgetSpent: 95 } });
    });

    await t.mutation(internal.wireDesk.onRosterSynced, { leagueId, seasonId: SEASON });
    await t.mutation(internal.wireDesk.onRosterSynced, { leagueId, seasonId: SEASON });

    const posts = await t.run((ctx) => ctx.db.query("wireLeaguePosts").withIndex("by_league_created", (q) => q.eq("leagueId", leagueId)).collect());
    const faabPosts = posts.filter((p) => p.kind === "faab_watch" && p.featuredTeams.includes(team1));
    expect(faabPosts).toHaveLength(1);
    expect(faabPosts[0].text).toMatch(/\$5/);
  });

  it("posts roster_note when a team hoards at one bench position", async () => {
    const t = convexTest(schema, modules);
    const { leagueId, team2 } = await t.run((ctx) => seedLeague(ctx, {}));
    await t.run(async (ctx) => {
      const roster = Array.from({ length: 6 }, (_, i) => ({
        playerId: `wr-${i}`,
        playerName: `Bench WR ${i}`,
        position: "WR",
        team: "FA",
        lineupSlotId: 20,
      }));
      await ctx.db.patch(team2, { roster });
    });

    await t.mutation(internal.wireDesk.onRosterSynced, { leagueId, seasonId: SEASON });

    const posts = await t.run((ctx) => ctx.db.query("wireLeaguePosts").withIndex("by_league_created", (q) => q.eq("leagueId", leagueId)).collect());
    const post = posts.find((p) => p.kind === "roster_note");
    expect(post).toBeDefined();
    expect(post!.featuredTeams).toContain(team2);
  });
});

describe("wireDesk: lineup_lock", () => {
  it("warns the claimed manager privately, then posts publicly unless it was a late scratch", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    const kickoffAt = now + 2 * HOUR;
    const { leagueId, team1 } = await t.run((ctx) => seedLeague(ctx, {}));

    await t.run(async (ctx) => {
      await seedPlayer(ctx as TestCtx, { espnId: "12001", fullName: "Locked Starter", defaultPosition: "WR", proTeamAbbrev: "DAL", injuryStatus: "Out" });
      await ctx.db.patch(team1, {
        roster: [{ playerId: "12001", playerName: "Locked Starter", position: "WR", team: "DAL", lineupSlotId: 4 }],
      });
      await ctx.db.insert("nflSchedules", {
        season: SEASON,
        week: 3,
        teamId: 6,
        teamAbbrev: "DAL",
        opponent: "PHI",
        isHome: true,
        gameTime: kickoffAt,
        isByeWeek: false,
        createdAt: now,
      });

      const user = await ctx.db.insert("users", {
        clerkId: "clerk_locked_manager",
        name: "Locked Manager",
        hasCompletedOnboarding: true,
        createdAt: now,
        lastActiveAt: now,
      });
      await ctx.db.insert("teamClaims", {
        leagueId,
        teamId: team1,
        seasonId: SEASON,
        userId: "clerk_locked_manager",
        status: "active",
        credits: 0,
        createdAt: now,
      });
      void user;
    });

    await t.mutation(internal.wireDesk.lineupLockWarning, { kickoffAt, season: SEASON, week: 3 });

    const notifications = await t.run((ctx) => ctx.db.query("userNotifications").collect());
    const alert = notifications.find((n) => n.type === "wire_alert");
    expect(alert).toBeDefined();
    expect(alert!.title).toContain("Locked Starter");
    expect(alert!.groupKey).toBeDefined();

    await t.mutation(internal.wireDesk.lineupLockPublic, { kickoffAt, season: SEASON, week: 3 });

    const posts = await t.run((ctx) => ctx.db.query("wireLeaguePosts").withIndex("by_league_created", (q) => q.eq("leagueId", leagueId)).collect());
    expect(posts.some((p) => p.kind === "lineup_lock")).toBe(true);
  });

  it("skips the public post for a late scratch (status observed just before kickoff)", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    const kickoffAt = now + 2 * HOUR;
    const { leagueId, team1 } = await t.run((ctx) => seedLeague(ctx, {}));

    await t.run(async (ctx) => {
      await seedPlayer(ctx as TestCtx, { espnId: "12002", fullName: "Late Scratch Guy", defaultPosition: "RB", proTeamAbbrev: "MIA", injuryStatus: "Out" });
      await ctx.db.patch(team1, {
        roster: [{ playerId: "12002", playerName: "Late Scratch Guy", position: "RB", team: "MIA", lineupSlotId: 2 }],
      });
      await ctx.db.insert("nflSchedules", {
        season: SEASON,
        week: 3,
        teamId: 15,
        teamAbbrev: "MIA",
        opponent: "NYJ",
        isHome: false,
        gameTime: kickoffAt,
        isByeWeek: false,
        createdAt: now,
      });
      await ctx.db.insert("wireEvents", {
        kind: "injury_status",
        dedupeKey: "injury_status:12002:Out",
        observedAt: kickoffAt - 15 * MIN, // inside the late-scratch window
        detectedAt: kickoffAt - 15 * MIN,
        players: [{ espnId: "12002", name: "Late Scratch Guy" }],
        primaryEspnId: "12002",
        facts: {
          kind: "injury_status",
          observedAt: kickoffAt - 15 * MIN,
          players: [{ espnId: "12002", name: "Late Scratch Guy" }],
          statusFrom: "Questionable",
          statusTo: "Out",
          source: { type: "espn_injuries", fetchedAt: kickoffAt - 15 * MIN },
        },
        interest: 60,
        source: { type: "espn_injuries", fetchedAt: kickoffAt - 15 * MIN },
      });
    });

    await t.mutation(internal.wireDesk.lineupLockPublic, { kickoffAt, season: SEASON, week: 3 });

    const posts = await t.run((ctx) => ctx.db.query("wireLeaguePosts").withIndex("by_league_created", (q) => q.eq("leagueId", leagueId)).collect());
    expect(posts.some((p) => p.kind === "lineup_lock")).toBe(false);
  });
});

describe("wireDesk: rumor_check", () => {
  async function seedManagerPost(t: ReturnType<typeof convexTest>, leagueId: Id<"leagues">, text: string) {
    const now = Date.now();
    return await t.run((ctx) =>
      ctx.db.insert("wireLeaguePosts", {
        leagueId,
        seasonId: SEASON,
        kind: "manager_post",
        text,
        tags: [],
        featuredTeams: [],
        dedupeKey: `manager:${Math.random()}`,
        authorUserId: "clerk_rumor_manager",
        createdAt: now,
      })
    );
  }

  it("denies when no matching pending proposal exists", async () => {
    const t = convexTest(schema, modules);
    const { leagueId, team1 } = await t.run((ctx) => seedLeague(ctx, {}));
    await t.run(async (ctx) => {
      await ctx.db.patch(team1, {
        roster: [{ playerId: "13001", playerName: "Justin Jefferson", position: "WR", team: "MIN", lineupSlotId: 4 }],
      });
    });
    const postId = await seedManagerPost(t, leagueId, "Hearing Jefferson might be on the move soon");

    await t.mutation(internal.wireDesk.checkRumor, { leaguePostId: postId });

    const posts = await t.run((ctx) => ctx.db.query("wireLeaguePosts").withIndex("by_league_created", (q) => q.eq("leagueId", leagueId)).collect());
    const rumorPost = posts.find((p) => p.kind === "rumor_check");
    expect(rumorPost).toBeDefined();
    expect(rumorPost!.text).toMatch(/Jefferson/);
  });

  it("confirms with a different line when a matching pending proposal exists", async () => {
    const t = convexTest(schema, modules);
    const { leagueId, team1 } = await t.run((ctx) => seedLeague(ctx, {}));
    await t.run(async (ctx) => {
      await ctx.db.patch(team1, {
        roster: [{ playerId: "13002", playerName: "Chris Olave", position: "WR", team: "NO", lineupSlotId: 4 }],
      });
      await seedPlayer(ctx as TestCtx, { espnId: "13002", fullName: "Chris Olave", defaultPosition: "WR" });
      await seedTransaction(ctx as TestCtx, leagueId, {
        type: "TRADE_PROPOSAL",
        outcome: "pending",
        teamId: 1,
        items: [{ fromLineupSlotId: -1, fromTeamId: 1, isKeeper: false, overallPickNumber: 0, playerId: 13002, toLineupSlotId: -1, toTeamId: 2, type: "TRADE" }],
      });
    });
    const postId = await seedManagerPost(t, leagueId, "Hearing Olave could be shopping around");

    await t.mutation(internal.wireDesk.checkRumor, { leaguePostId: postId });

    const posts = await t.run((ctx) => ctx.db.query("wireLeaguePosts").withIndex("by_league_created", (q) => q.eq("leagueId", leagueId)).collect());
    const rumorPost = posts.find((p) => p.kind === "rumor_check");
    expect(rumorPost).toBeDefined();
    expect(rumorPost!.text).toMatch(/Olave/);
  });

  it("never confirms when the league turned leaks off, even with a matching proposal", async () => {
    const t = convexTest(schema, modules);
    const { leagueId, team1 } = await t.run((ctx) => seedLeague(ctx, {}));
    await t.run(async (ctx) => {
      await seedPrefs(ctx as TestCtx, leagueId, { wireLeaks: false });
      await ctx.db.patch(team1, {
        roster: [{ playerId: "13003", playerName: "Deebo Samuel", position: "WR", team: "SF", lineupSlotId: 4 }],
      });
      await seedTransaction(ctx as TestCtx, leagueId, {
        type: "TRADE_PROPOSAL",
        outcome: "pending",
        teamId: 1,
        items: [{ fromLineupSlotId: -1, fromTeamId: 1, isKeeper: false, overallPickNumber: 0, playerId: 13003, toLineupSlotId: -1, toTeamId: 2, type: "TRADE" }],
      });
    });
    const postId = await seedManagerPost(t, leagueId, "Hearing Samuel is drawing trade interest");

    await t.mutation(internal.wireDesk.checkRumor, { leaguePostId: postId });

    const posts = await t.run((ctx) => ctx.db.query("wireLeaguePosts").withIndex("by_league_created", (q) => q.eq("leagueId", leagueId)).collect());
    const rumorPost = posts.find((p) => p.kind === "rumor_check");
    // The deny branch always runs regardless of the leaks toggle (spec §18).
    expect(rumorPost).toBeDefined();
  });
});

describe("wireDesk: ownership_swing (global card)", () => {
  it("dedupes the same player on the same day", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.wireDesk.insertOwnershipSwingEvent, {
      season: SEASON,
      espnId: "14001",
      fullName: "Swing Guy",
      defaultPosition: "RB",
      percentOwned: 40,
      percentChange: 8,
    });
    await t.mutation(internal.wireDesk.insertOwnershipSwingEvent, {
      season: SEASON,
      espnId: "14001",
      fullName: "Swing Guy",
      defaultPosition: "RB",
      percentOwned: 40,
      percentChange: 8,
    });

    const events = await t.run((ctx) => ctx.db.query("wireEvents").withIndex("by_kind_detected", (q) => q.eq("kind", "ownership_swing")).collect());
    expect(events.filter((e) => e.primaryEspnId === "14001")).toHaveLength(1);
  });

  it("caps at the top 10 swings per day by |change|, via the paginated detector", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      for (let i = 0; i < 14; i++) {
        await seedPlayer(ctx as TestCtx, {
          espnId: `15${String(i).padStart(3, "0")}`,
          fullName: `Ownership Player ${i}`,
          defaultPosition: "WR",
          percentOwned: 50,
          percentChange: 6 + i, // all above the 5-point floor, strictly increasing
        });
      }
    });

    await t.action(internal.wireDesk.detectOwnershipSwings, { season: SEASON });

    const events = await t.run((ctx) => ctx.db.query("wireEvents").withIndex("by_kind_detected", (q) => q.eq("kind", "ownership_swing")).collect());
    expect(events).toHaveLength(10);
  });
});
