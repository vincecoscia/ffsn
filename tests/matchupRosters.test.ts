/**
 * `convex/matchupRosters.ts`'s `fetchMatchupRosters`, focused on the
 * pre-draft-redraft path added alongside `convex/lib/matchupSummary.ts`'s
 * `isPreDraftRedraft` (see that module's header comment, finding 3): before
 * a redraft league's draft, ESPN's `rosterForCurrentScoringPeriod` still
 * carries the previous season's FINAL lineup. Storing that would sum
 * projections for a team that won't exist post-draft, so this path must
 * clear (not store) both rosters for that period - including clearing a
 * stale carried-over roster a prior step of the same sync already wrote.
 *
 * Fetch-mocking follows the pattern in `tests/espnTransactions.test.ts`
 * (`vi.stubGlobal("fetch", ...)` against `espnSync.syncTransactionLog`).
 */
import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import schema from "../convex/schema";
import { internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";

const modules = import.meta.glob("../convex/**/*.*s");

const SEASON = 2026;
const MATCHUP_PERIOD = 1;

async function seedLeague(t: ReturnType<typeof convexTest>): Promise<Id<"leagues">> {
  const now = Date.now();
  return await t.run(async (ctx) =>
    ctx.db.insert("leagues", {
      name: "Roster Fetch Test League",
      platform: "espn",
      externalId: "predraft-league-1",
      commissionerUserId: "clerk_roster_commish",
      settings: { scoringType: "PPR", rosterSize: 16, playoffWeeks: 3, categories: [] },
      espnData: {
        seasonId: SEASON,
        currentScoringPeriod: 1,
        size: 2,
        lastSyncedAt: now,
        isPrivate: false,
      },
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
    })
  );
}

/**
 * Simulates a matchup row as `espnSync.ts`'s `updateMatchups` would have
 * already written it earlier in the same sync - including a stale
 * carried-over roster (the thing `fetchMatchupRosters`'s pre-draft path
 * must clear).
 */
async function seedMatchupWithStaleRoster(
  t: ReturnType<typeof convexTest>,
  leagueId: Id<"leagues">
): Promise<Id<"matchups">> {
  const now = Date.now();
  const staleRoster = {
    appliedStatTotal: 88.8,
    players: [
      {
        lineupSlotId: 0,
        espnId: 555,
        fullName: "Carried Over QB",
        position: "QB",
        points: 0,
        projectedPoints: 88.8,
      },
    ],
  };
  return await t.run((ctx) =>
    ctx.db.insert("matchups", {
      leagueId,
      seasonId: SEASON,
      matchupPeriod: MATCHUP_PERIOD,
      scoringPeriod: MATCHUP_PERIOD,
      homeTeamId: "1",
      awayTeamId: "2",
      homeScore: 0,
      awayScore: 0,
      homeRoster: staleRoster,
      awayRoster: staleRoster,
      createdAt: now,
    })
  );
}

/** A `rosterForCurrentScoringPeriod` blob shaped like ESPN's `mRoster` response - one starter. */
function espnRoster(espnId: number, appliedTotal: number) {
  return {
    appliedStatTotal: 0,
    entries: [
      {
        lineupSlotId: 0,
        playerPoolEntry: {
          appliedStatTotal: 0,
          player: {
            id: espnId,
            firstName: "New",
            lastName: "Player",
            fullName: "New Player",
            defaultPositionId: 1,
            stats: [{ statSourceId: 1, seasonId: SEASON, scoringPeriodId: MATCHUP_PERIOD, appliedTotal }],
          },
        },
      },
    ],
  };
}

function mockEspnResponse(draftSettings: { keeperCount: number; keeperCountFuture: number }) {
  return vi.fn(async (_input: string | URL) =>
    new Response(
      JSON.stringify({
        schedule: [
          {
            matchupPeriodId: MATCHUP_PERIOD,
            id: MATCHUP_PERIOD,
            home: { teamId: 1, rosterForCurrentScoringPeriod: espnRoster(101, 30.5) },
            away: { teamId: 2, rosterForCurrentScoringPeriod: espnRoster(102, 22.1) },
          },
        ],
        // Live 2026 shape verified against ESPN's prod endpoint (spec):
        // drafted:false, scoringPeriodId 0, but rosterForCurrentScoringPeriod
        // still populated with carried-over lineups.
        draftDetail: { drafted: false, inProgress: false },
        settings: { draftSettings },
      }),
      { status: 200 }
    )
  );
}

describe("matchupRosters.fetchMatchupRosters - pre-draft redraft", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("clears (does not store) carried-over rosters for a redraft league before its draft", async () => {
    const t = convexTest(schema, modules);
    const leagueId = await seedLeague(t);
    const matchupId = await seedMatchupWithStaleRoster(t, leagueId);

    const fetchMock = mockEspnResponse({ keeperCount: 0, keeperCountFuture: 0 });
    vi.stubGlobal("fetch", fetchMock);

    const result = await t.action(internal.matchupRosters.fetchMatchupRosters, {
      leagueId,
      seasonId: SEASON,
      matchupPeriods: [MATCHUP_PERIOD],
    });

    expect(result.results).toEqual([
      { matchupPeriod: MATCHUP_PERIOD, success: true, preDraft: true, rostersCleared: 1 },
    ]);

    const stored = await t.run((ctx) => ctx.db.get(matchupId));
    expect(stored).not.toBeNull();
    // Convex `patch` with an `undefined` field value removes it - the stale
    // carried-over roster from before this fetch must be gone, not just
    // left alone.
    expect(stored).not.toHaveProperty("homeRoster");
    expect(stored).not.toHaveProperty("awayRoster");
  });

  it("stores the fetched rosters normally for a keeper league (keeperCount > 0) before its draft", async () => {
    const t = convexTest(schema, modules);
    const leagueId = await seedLeague(t);
    const matchupId = await seedMatchupWithStaleRoster(t, leagueId);

    const fetchMock = mockEspnResponse({ keeperCount: 1, keeperCountFuture: 0 });
    vi.stubGlobal("fetch", fetchMock);

    const result = await t.action(internal.matchupRosters.fetchMatchupRosters, {
      leagueId,
      seasonId: SEASON,
      matchupPeriods: [MATCHUP_PERIOD],
    });

    expect(result.results).toEqual([
      { matchupPeriod: MATCHUP_PERIOD, success: true, matchupsCount: 1, rostersFound: 1 },
    ]);

    const stored = await t.run((ctx) => ctx.db.get(matchupId));
    expect(stored?.homeRoster).toBeDefined();
    expect(stored?.homeRoster?.players[0]?.espnId).toBe(101);
    expect(stored?.awayRoster).toBeDefined();
    expect(stored?.awayRoster?.players[0]?.espnId).toBe(102);
  });

  it("requests view=mDraftDetail alongside the existing views", async () => {
    const t = convexTest(schema, modules);
    const leagueId = await seedLeague(t);
    await seedMatchupWithStaleRoster(t, leagueId);

    const fetchMock = mockEspnResponse({ keeperCount: 0, keeperCountFuture: 0 });
    vi.stubGlobal("fetch", fetchMock);

    await t.action(internal.matchupRosters.fetchMatchupRosters, {
      leagueId,
      seasonId: SEASON,
      matchupPeriods: [MATCHUP_PERIOD],
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requestedUrl = new URL(String(fetchMock.mock.calls[0][0]));
    expect(requestedUrl.searchParams.getAll("view")).toContain("mDraftDetail");
  });
});
