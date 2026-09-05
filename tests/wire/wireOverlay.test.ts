import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import type { GenericActionCtx, GenericMutationCtx } from "convex/server";
import schema from "../../convex/schema";
import { internal } from "../../convex/_generated/api";
import type { DataModel, Id } from "../../convex/_generated/dataModel";
import type { WireFactCard } from "../../src/lib/ai/wire/types";

const modules = import.meta.glob("../../convex/**/*.*s");

// The type `t.run`'s callback receives (convex-test's own inferred shape, not exported by name).
type TestCtx = GenericMutationCtx<DataModel> & Pick<GenericActionCtx<DataModel>, "storage">;

const SEASON = 2026;
const CLERK_COMMISH = "clerk_commish_wire";

const injuryCard = (overrides: Partial<WireFactCard> = {}): WireFactCard => ({
  kind: "injury_status",
  observedAt: Date.now(),
  players: [{ espnId: "9101", name: "Star Player", position: "RB", nflTeam: "KC" }],
  statusFrom: "Active",
  statusTo: "Out",
  timetable: "4-6 weeks",
  source: { type: "espn_injuries", id: "e1", fetchedAt: Date.now() },
  ...overrides,
});

async function seedLeague(
  ctx: TestCtx,
  opts: {
    passActive?: boolean;
    waiverType?: "faab" | "waivers" | "free_agency";
    faabBudget?: number;
    wireEnabled?: boolean;
    /** Seed a leagueSeasons row sitting before its draft; keeperCount > 0 makes it a keeper league. */
    preDraft?: { keeperCount: number };
  } = {}
) {
  const now = Date.now();
  const leagueId = await ctx.db.insert("leagues", {
    name: "Overlay Test League",
    platform: "espn",
    externalId: "7771",
    commissionerUserId: CLERK_COMMISH,
    settings: {
      scoringType: "ppr",
      rosterSize: 16,
      playoffWeeks: 3,
      categories: [],
      waiverType: opts.waiverType,
      faabBudget: opts.faabBudget,
    },
    espnData: {
      seasonId: SEASON,
      currentScoringPeriod: 1,
      size: 10,
      lastSyncedAt: now,
      isPrivate: false,
    },
    subscription: {
      tier: "season_pass",
      status: opts.passActive === false ? "pending" : "active",
      creditsRemaining: 0,
      creditsMonthly: 0,
      paymentStatus: "completed",
      seasonYear: SEASON,
    },
    lastSync: now,
    createdAt: now,
  });

  if (opts.wireEnabled !== undefined) {
    await ctx.db.insert("leagueContentPreferences", {
      leagueId,
      contentEnabled: true,
      timezone: "America/New_York",
      currentMonthSpent: 0,
      budgetResetDate: now,
      notifyCommissioner: true,
      notifyFailures: true,
      autoPublish: true,
      requireApproval: false,
      wireEnabled: opts.wireEnabled,
      createdAt: now,
      updatedAt: now,
    });
  }

  const ownerTeamId = await ctx.db.insert("teams", {
    leagueId,
    externalId: "1",
    name: "Owner Team",
    owner: "Owner Manager",
    ownerInfo: { displayName: "Owner Manager", id: "owner-swid" },
    record: { wins: 0, losses: 0, ties: 0 },
    roster: [{ playerId: "9101", playerName: "Star Player", position: "RB", team: "KC", lineupSlotId: 2 }],
    transactionCounter: { acquisitionBudgetSpent: 35 },
    seasonId: SEASON,
    createdAt: now,
    updatedAt: now,
  });
  const opponentTeamId = await ctx.db.insert("teams", {
    leagueId,
    externalId: "2",
    name: "Opponent Team",
    owner: "Opponent Manager",
    ownerInfo: { displayName: "Opponent Manager", id: "opponent-swid" },
    record: { wins: 0, losses: 0, ties: 0 },
    roster: [],
    seasonId: SEASON,
    createdAt: now,
    updatedAt: now,
  });

  await ctx.db.insert("matchups", {
    leagueId,
    seasonId: SEASON,
    matchupPeriod: 1,
    scoringPeriod: 1,
    homeTeamId: "1",
    awayTeamId: "2",
    homeScore: 0,
    awayScore: 0,
    updatedAt: now,
    createdAt: now,
  });

  if (opts.preDraft) {
    await ctx.db.insert("leagueSeasons", {
      leagueId,
      seasonId: SEASON,
      settings: {},
      draftInfo: { drafted: false, inProgress: false },
      draftSettings: { keeperCount: opts.preDraft.keeperCount, keeperCountFuture: 0 },
      createdAt: now,
    });
  }

  return { leagueId, ownerTeamId, opponentTeamId };
}

async function seedPost(ctx: TestCtx, card: WireFactCard, interest = 70) {
  const now = Date.now();
  const eventId = await ctx.db.insert("wireEvents", {
    kind: card.kind,
    dedupeKey: `test:${now}:${Math.random()}`,
    observedAt: card.observedAt,
    detectedAt: now,
    players: card.players,
    nflTeam: card.nflTeam,
    facts: card,
    interest,
    source: card.source,
  });
  const postId = await ctx.db.insert("wirePosts", {
    eventId,
    kind: card.kind,
    persona: "dex-alvarez",
    text: "placeholder card text",
    tags: ["REPORTED"],
    status: "take",
    interest,
    createdAt: now,
    updatedAt: now,
  });
  return { eventId, postId: postId as Id<"wirePosts"> };
}

describe("wireOverlay: per-league fill", () => {
  it("owner + opponent variants fill from roster and this week's matchup; a non-FAAB league drops the FAAB sentence", async () => {
    const t = convexTest(schema, modules);
    const { leagueId } = await t.run((ctx) => seedLeague(ctx, { waiverType: "waivers" }));
    const { postId } = await t.run((ctx) => seedPost(ctx, injuryCard()));

    await t.mutation(internal.wireOverlay.fanOutGlobalPostForLeague, { postId, leagueId });

    const rows = await t.run((ctx) =>
      ctx.db
        .query("wireLeaguePosts")
        .withIndex("by_league_created", (q) => q.eq("leagueId", leagueId))
        .collect()
    );

    const owner = rows.find((r) => r.impact?.variant === "owner");
    const opponent = rows.find((r) => r.impact?.variant === "opponent");
    expect(owner).toBeDefined();
    expect(opponent).toBeDefined();

    expect(owner!.text).toContain("Star Player");
    expect(owner!.text).toContain("4-6 weeks");
    // The FAAB sentence is dropped (this league isn't FAAB), everything else survives.
    expect(owner!.text).not.toContain("FAAB");

    expect(opponent!.text).toContain("Opponent Team");
    expect(opponent!.text).toContain("Owner Team");
  });

  it("computes FAAB remaining from the league budget minus the team's spend", async () => {
    const t = convexTest(schema, modules);
    const { leagueId } = await t.run((ctx) => seedLeague(ctx, { waiverType: "faab", faabBudget: 100 }));
    const { postId } = await t.run((ctx) => seedPost(ctx, injuryCard()));

    await t.mutation(internal.wireOverlay.fanOutGlobalPostForLeague, { postId, leagueId });

    const rows = await t.run((ctx) =>
      ctx.db
        .query("wireLeaguePosts")
        .withIndex("by_league_created", (q) => q.eq("leagueId", leagueId))
        .collect()
    );
    const owner = rows.find((r) => r.impact?.variant === "owner");
    expect(owner).toBeDefined();
    // budget 100 - acquisitionBudgetSpent 35 = 65
    expect(owner!.text).toContain("$65");
    expect(owner!.impact?.slots.faab).toBe("$65");
  });

  it("free-agent variant fills when unrostered and widely owned, using the precomputed backup", async () => {
    const t = convexTest(schema, modules);
    const { leagueId } = await t.run((ctx) => seedLeague(ctx, { waiverType: "waivers" }));

    const card = injuryCard({
      players: [{ espnId: "9199", name: "Wire Wanted Guy", position: "RB", nflTeam: "KC", percentOwned: 45 }],
    });
    const { postId } = await t.run((ctx) => seedPost(ctx, card));

    await t.mutation(internal.wireOverlay.fanOutGlobalPostForLeague, {
      postId,
      leagueId,
      backupEspnId: "9202",
      backupName: "Backup Guy",
    });

    const rows = await t.run((ctx) =>
      ctx.db
        .query("wireLeaguePosts")
        .withIndex("by_league_created", (q) => q.eq("leagueId", leagueId))
        .collect()
    );
    const freeAgent = rows.find((r) => r.kind === "injury_status" && !r.impact);
    expect(freeAgent).toBeDefined();
    expect(freeAgent!.text).toContain("Backup Guy");
    expect(freeAgent!.featuredTeams).toHaveLength(0);
  });

  it("pre-draft REDRAFT league -> no overlay rows, even for a kept-looking roster or a star on the board", async () => {
    const t = convexTest(schema, modules);
    const { leagueId } = await t.run((ctx) => seedLeague(ctx, { waiverType: "faab", faabBudget: 100, preDraft: { keeperCount: 0 } }));

    // Rostered star (seedLeague puts 9101 on Owner Team) and an unrostered, widely-owned one.
    const rostered = await t.run((ctx) => seedPost(ctx, injuryCard()));
    const onBoard = await t.run((ctx) =>
      seedPost(ctx, injuryCard({ players: [{ espnId: "9199", name: "Board Guy", position: "RB", nflTeam: "KC", percentOwned: 90 }] }))
    );
    await t.mutation(internal.wireOverlay.fanOutGlobalPostForLeague, { postId: rostered.postId, leagueId });
    await t.mutation(internal.wireOverlay.fanOutGlobalPostForLeague, { postId: onBoard.postId, leagueId, backupEspnId: "9202", backupName: "Backup Guy" });

    const rows = await t.run((ctx) =>
      ctx.db.query("wireLeaguePosts").withIndex("by_league_created", (q) => q.eq("leagueId", leagueId)).collect()
    );
    expect(rows).toHaveLength(0);
  });

  it("pre-draft KEEPER league -> owner note for a kept player without waiver sentences; draft-board note with ADP for a star on the board", async () => {
    const t = convexTest(schema, modules);
    const { leagueId } = await t.run((ctx) => seedLeague(ctx, { waiverType: "faab", faabBudget: 100, preDraft: { keeperCount: 2 } }));

    const now = Date.now();
    await t.run((ctx) =>
      ctx.db.insert("playerIntel", {
        espnId: "9199",
        season: new Date().getFullYear() >= SEASON ? SEASON : SEASON, // intel season label = current NFL season
        source: "ffc",
        kind: "market",
        fetchedAt: now,
        market: "ppr-12",
        adp: 18.4,
        adpPositionRank: 7,
      })
    );

    const kept = await t.run((ctx) => seedPost(ctx, injuryCard()));
    const onBoard = await t.run((ctx) =>
      seedPost(ctx, injuryCard({ players: [{ espnId: "9199", name: "Board Guy", position: "RB", nflTeam: "KC", percentOwned: 90 }] }))
    );
    await t.mutation(internal.wireOverlay.fanOutGlobalPostForLeague, { postId: kept.postId, leagueId });
    await t.mutation(internal.wireOverlay.fanOutGlobalPostForLeague, { postId: onBoard.postId, leagueId, backupEspnId: "9202", backupName: "Backup Guy" });

    const rows = await t.run((ctx) =>
      ctx.db.query("wireLeaguePosts").withIndex("by_league_created", (q) => q.eq("leagueId", leagueId)).collect()
    );
    const owner = rows.find((r) => r.impact?.variant === "owner");
    expect(owner).toBeDefined();
    expect(owner!.text).toContain("Owner Team");
    expect(owner!.text).not.toMatch(/FAAB|waivers/);
    expect(rows.find((r) => r.impact?.variant === "opponent")).toBeUndefined();

    const board = rows.find((r) => !r.impact);
    expect(board).toBeDefined();
    expect(board!.text).toContain("still on the board");
    expect(board!.text).not.toContain("Backup Guy");
    expect(board!.text).toMatch(/ADP 18\.4, RB7/);
  });

  it("no active pass -> no overlay rows at all", async () => {
    const t = convexTest(schema, modules);
    const { leagueId } = await t.run((ctx) => seedLeague(ctx, { passActive: false }));
    const { postId } = await t.run((ctx) => seedPost(ctx, injuryCard()));

    await t.mutation(internal.wireOverlay.fanOutGlobalPostForLeague, { postId, leagueId });

    const rows = await t.run((ctx) => ctx.db.query("wireLeaguePosts").collect());
    expect(rows).toHaveLength(0);
  });

  it("wireEnabled: false -> no overlay rows even with an active pass", async () => {
    const t = convexTest(schema, modules);
    const { leagueId } = await t.run((ctx) => seedLeague(ctx, { wireEnabled: false }));
    const { postId } = await t.run((ctx) => seedPost(ctx, injuryCard()));

    await t.mutation(internal.wireOverlay.fanOutGlobalPostForLeague, { postId, leagueId });

    const rows = await t.run((ctx) => ctx.db.query("wireLeaguePosts").collect());
    expect(rows).toHaveLength(0);
  });

  it("is idempotent: calling fanOutGlobalPostForLeague twice never doubles the rows", async () => {
    const t = convexTest(schema, modules);
    const { leagueId } = await t.run((ctx) => seedLeague(ctx, { waiverType: "waivers" }));
    const { postId } = await t.run((ctx) => seedPost(ctx, injuryCard()));

    await t.mutation(internal.wireOverlay.fanOutGlobalPostForLeague, { postId, leagueId });
    await t.mutation(internal.wireOverlay.fanOutGlobalPostForLeague, { postId, leagueId });

    const rows = await t.run((ctx) => ctx.db.query("wireLeaguePosts").collect());
    // owner + opponent, not doubled.
    expect(rows).toHaveLength(2);
  });
});
