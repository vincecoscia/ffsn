import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import schema from "../convex/schema";
import { internal } from "../convex/_generated/api";

const modules = import.meta.glob("../convex/**/*.*s");

/**
 * `aiQueries.getMockDraftDataForAI` (owner ask, 2026-09-05): the pool is the top of the season by
 * ESPN ADP through the ADP index (it used to be the best 50 of an arbitrary 200 rows), every
 * pool player carries ADP, positional rank, status and the week's headline, the league type is
 * read from ESPN's draft settings, and last year's draft becomes per-manager tendencies.
 */

const SEASON = 2026;
const PREV = 2025;
const CLERK = "clerk_mock_draft";

async function seed(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const leagueId = await ctx.db.insert("leagues", {
      name: "Mock Draft League",
      platform: "espn",
      externalId: "9999",
      commissionerUserId: CLERK,
      settings: { scoringType: "ppr", rosterSize: 17, playoffWeeks: 3, categories: [] },
      espnData: { seasonId: SEASON, currentScoringPeriod: 0, size: 2, lastSyncedAt: now, isPrivate: false },
      subscription: { tier: "season_pass", status: "active", creditsRemaining: 0, creditsMonthly: 0, paymentStatus: "completed", seasonYear: SEASON },
      lastSync: now,
      createdAt: now,
    });
    await ctx.db.insert("users", { clerkId: CLERK, name: "Ava Drafter", hasCompletedOnboarding: true, createdAt: now, lastActiveAt: now });

    const team = async (seasonId: number, externalId: string, name: string, wins: number, losses: number) =>
      await ctx.db.insert("teams", {
        leagueId, externalId, seasonId, name, owner: `Owner ${externalId}`,
        record: { wins, losses, ties: 0, pointsFor: 1000 + wins, pointsAgainst: 900 },
        roster: [], createdAt: now, updatedAt: now,
      });
    const teamA = await team(SEASON, "1", "Ava's Avalanche", 0, 0);
    await team(SEASON, "2", "Bruisers", 0, 0);
    await team(PREV, "1", "Ava's Old Name", 9, 5);
    await team(PREV, "2", "Old Bruisers", 5, 9);
    await ctx.db.insert("teamClaims", { leagueId, teamId: teamA, seasonId: SEASON, userId: CLERK, status: "active", credits: 0, createdAt: now });

    for (const seasonId of [SEASON, PREV]) {
      await ctx.db.insert("leagueSeasons", {
        leagueId, seasonId, settings: {},
        draftSettings: { type: "SNAKE", keeperCount: seasonId === SEASON ? 2 : 0, pickOrder: [2, 1], date: now + 86_400_000 },
        draftInfo: { drafted: seasonId === PREV, inProgress: false },
        createdAt: now,
      });
    }

    const player = async (espnId: string, season: number, fullName: string, pos: string, adp: number, status = "ACTIVE", outlook = "") =>
      await ctx.db.insert("playersEnhanced", {
        espnId, season, fullName, defaultPosition: pos, defaultPositionId: 2, eligibleSlots: [2, 20], eligiblePositions: [pos],
        proTeamId: 8, proTeamAbbrev: "DET", active: true, injured: status !== "ACTIVE", injuryStatus: status, droppable: true,
        ownership: { percentOwned: 99, percentStarted: 90, averageDraftPosition: adp }, seasonOutlook: outlook,
        stats: [{ externalId: String(season), statSourceId: 1, appliedTotal: 300 - adp, appliedAverage: 18 }],
        createdAt: now, updatedAt: now,
      });
    // 2026 pool: an ADP-1 star with a status, a WR2, a benchwarmer with no ADP, and an inactive row.
    await player("100", SEASON, "Jahmyr Gibbs", "RB", 1.3, "ACTIVE", "Gibbs is the engine of the Detroit offense. He also catches passes.");
    await player("101", SEASON, "Puka Nacua", "WR", 5.3, "QUESTIONABLE");
    await player("102", SEASON, "Amon-Ra St. Brown", "WR", 8.4);
    await player("103", SEASON, "No Adp Guy", "TE", 0);
    // 2025 rows carry last year's ADP for the tendencies.
    await player("100", PREV, "Jahmyr Gibbs", "RB", 4.0);
    await player("200", PREV, "Alvin Kamara", "RB", 62.0);
    await player("201", PREV, "Josh Allen", "QB", 1.5);
    await player("101", PREV, "Puka Nacua", "WR", 7.0);

    const draftPick = async (overall: number, playerId: number, toTeamId: number) =>
      await ctx.db.insert("transactions", {
        leagueId, seasonId: PREV, espnTransactionId: `d-${overall}`, bidAmount: 0, executionType: "EXECUTE", isActingAsTeamOwner: false, isLeagueManager: false, isPending: false,
        items: [{ fromLineupSlotId: 0, fromTeamId: 0, isKeeper: false, overallPickNumber: overall, playerId, toLineupSlotId: 2, toTeamId, type: "DRAFT" }],
        type: "DRAFT", proposedDate: now, status: "EXECUTED", scoringPeriod: 0, teamId: toTeamId, createdAt: now,
      });
    await draftPick(1, 100, 1); // Gibbs at 1.01 (ADP 4)
    await draftPick(2, 101, 2); // Nacua at 1.02 (ADP 7)
    await draftPick(3, 200, 2); // Kamara at 2.01 (ADP 62 - the reach)
    await draftPick(4, 201, 1); // Allen at 2.02 (ADP 1.5 - the value: 2.5 spots late)

    // News: a story about Gibbs this week, a listicle tagged to everyone, and an old story.
    const story = async (headline: string, daysAgo: number, athletes: number[]) =>
      await ctx.db.insert("espnNews", {
        espnId: `n-${headline.length}-${daysAgo}`, type: "Story", headline, lastModified: new Date(now - daysAgo * 86_400_000).toISOString(),
        published: new Date(now - daysAgo * 86_400_000).toISOString(), premium: false, links: {}, images: [],
        categories: { teams: [], athletes: athletes.map((id) => ({ id, name: `Athlete ${id}` })), leagues: [] },
        createdAt: now, updatedAt: now,
      });
    await story("Gibbs takes more snaps in camp", 1, [100]);
    await story("Fantasy sleepers, busts and breakouts", 1, [100, 101, 102, 1, 2, 3, 4, 5]);
    await story("Nacua limited in practice with an ankle", 12, [101]);
    await story("Something from July", 60, [100]);

    return { leagueId };
  });
}

describe("getMockDraftDataForAI", () => {
  it("builds the pool by ADP with ranks, status and the week's headline, reads the league type, and adds last year's tendencies", async () => {
    const t = convexTest(schema, modules);
    const { leagueId } = await seed(t);
    const data = await t.query(internal.aiQueries.getMockDraftDataForAI, { leagueId });

    expect(data.draftType).toBe("Snake");
    expect(data.leagueType).toBe("Keeper"); // keeperCount 2, read before any pick exists
    expect(data.totalTeams).toBe(2);
    expect(data.draftOrder.map((d: { teamName: string }) => d.teamName)).toEqual(["Bruisers", "Ava's Avalanche"]);

    const pool = data.availablePlayers as Array<Record<string, unknown>>;
    expect(pool.map((p) => p.playerName)).toEqual(["Jahmyr Gibbs", "Puka Nacua", "Amon-Ra St. Brown"]);
    expect(pool[0]).toMatchObject({ adp: 1.3, adpRank: 1, adpPositionRank: 1 });
    expect(pool[0].injuryStatus).toBeUndefined();
    expect(pool[0].seasonOutlook).toContain("engine of the Detroit offense");
    expect(pool[0].recentNews).toEqual([{ headline: "Gibbs takes more snaps in camp", published: expect.any(String) }]);
    expect(pool[1]).toMatchObject({ adpPositionRank: 1, injuryStatus: "QUESTIONABLE" });
    expect(pool[2]).toMatchObject({ adpPositionRank: 2 });

    expect(data.injuryWatch).toEqual([
      expect.objectContaining({ playerName: "Puka Nacua", injuryStatus: "QUESTIONABLE", latestHeadline: expect.objectContaining({ headline: "Nacua limited in practice with an ankle" }) }),
    ]);

    expect(data.previousSeason).toBe(PREV);
    const tendencies = data.draftTendencies as Array<Record<string, unknown>>;
    expect(tendencies.map((x) => x.teamName)).toEqual(["Bruisers", "Ava's Avalanche"]); // this year's names and slots
    const ava = tendencies[1];
    expect(ava).toMatchObject({ manager: "Ava Drafter", draftSlot: 2, lastSeasonRecord: "9-5", lastSeasonRank: 1, positionalStart: "RB-QB", firstQbRound: 2 });
    expect(ava.bestValue).toMatchObject({ player: "Josh Allen", pick: 4, adp: 1.5, delta: -2.5 });
    expect(ava.biggestReach).toMatchObject({ player: "Jahmyr Gibbs", pick: 1, adp: 4, delta: 3 });
    const bruisers = tendencies[0];
    expect(bruisers.biggestReach).toMatchObject({ player: "Alvin Kamara", pick: 3, adp: 62, delta: 59 });
  });
});
