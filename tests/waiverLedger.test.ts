/**
 * `convex/aiQueries.ts#buildWaiverLedger` (owner goal, 2026-09-02: the waiver wire report must take
 * FAAB spend into account - winning bids, losing bids, each team's remaining budget, season
 * highlights, and Sam's interview questions should all use these numbers).
 *
 * Seeds real rows from the live ESPN fixture (tests/fixtures/espn-transactions-public.json, public
 * league 899513, `view=mTransactions2&scoringPeriodId=5`) through the same `normalizeEspnTransaction`
 * the sync path uses, so this test exercises the exact contested-claim example verified there:
 * player 4362478, scoring period 5 - winner $41 (team 8, EXECUTED/PROCESS), losing bids
 * [35, 18, 10, 5] (teams 3, 5, 1, 11, all FAILED_INVALIDPLAYERSOURCE/PROCESS), and a $0 CANCELED bid
 * from team 8 itself that must never appear as a competing bid.
 */
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import schema from "../convex/schema";
import { internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { normalizeEspnTransaction, type RawEspnTransaction } from "../convex/lib/espnTransactions";
import transactionsFixture from "./fixtures/espn-transactions-public.json";

const modules = import.meta.glob("../convex/**/*.*s");

const SEASON = 2025;
const PERIOD = 5;
const PLAYER_ID = 4362478;

const period5Transactions = transactionsFixture.periods["2025-5"].transactions as RawEspnTransaction[];
/** The 6 real rows involving the contested player: 1 CANCELED, 4 FAILED, 1 EXECUTED. */
const contestedRows = period5Transactions.filter((row) =>
  (row.items ?? []).some((item) => item.playerId === PLAYER_ID)
);

async function seedLeague(
  t: ReturnType<typeof convexTest>,
  overrides: { waiverType?: "faab" | "waivers" | "free_agency" } = {}
): Promise<Id<"leagues">> {
  const now = Date.now();
  const waiverType = overrides.waiverType ?? "faab";
  return await t.run(async (ctx) =>
    ctx.db.insert("leagues", {
      name: "Waiver Ledger Test League",
      platform: "espn",
      externalId: "899513",
      commissionerUserId: "clerk_waiver_commish",
      settings: {
        scoringType: "PPR",
        rosterSize: 16,
        playoffWeeks: 3,
        categories: [],
        waiverType,
        // A non-FAAB league has no FAAB budget in the first place.
        faabBudget: waiverType === "faab" ? 100 : undefined,
      },
      espnData: {
        seasonId: SEASON,
        currentScoringPeriod: PERIOD,
        size: 12,
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

async function seedTeam(
  t: ReturnType<typeof convexTest>,
  leagueId: Id<"leagues">,
  externalId: string,
  overrides: Record<string, unknown> = {}
): Promise<Id<"teams">> {
  const now = Date.now();
  return await t.run(async (ctx) =>
    ctx.db.insert("teams", {
      leagueId,
      externalId,
      name: `Team ${externalId}`,
      owner: `Owner ${externalId}`,
      record: { wins: 0, losses: 0, ties: 0 },
      roster: [],
      seasonId: SEASON,
      createdAt: now,
      updatedAt: now,
      ...overrides,
    })
  );
}

async function seedContestedPeriodTransactions(t: ReturnType<typeof convexTest>, leagueId: Id<"leagues">) {
  const now = Date.now();
  for (const raw of contestedRows) {
    const normalized = normalizeEspnTransaction(raw, { leagueId, seasonId: SEASON, scoringPeriod: PERIOD });
    await t.run(async (ctx) => ctx.db.insert("transactions", { ...normalized, createdAt: now }));
  }
}

describe("buildWaiverLedger (via internal.aiQueries.getWaiverLedgerForAI)", () => {
  it("matches the contested-claim example: winner $41, losing bids [35, 18, 10, 5], cancelled bid excluded", async () => {
    const t = convexTest(schema, modules);
    const leagueId = await seedLeague(t);
    const team8 = await seedTeam(t, leagueId, "8", { name: "Winner Squad", owner: "Gabe" });
    await seedTeam(t, leagueId, "3", { name: "Team Three" });
    await seedTeam(t, leagueId, "5", { name: "Team Five" });
    await seedTeam(t, leagueId, "1", { name: "Team One" });
    await seedTeam(t, leagueId, "11", { name: "Team Eleven" });
    await seedContestedPeriodTransactions(t, leagueId);

    const ledger = await t.query(internal.aiQueries.getWaiverLedgerForAI, {
      leagueId,
      seasonId: SEASON,
      throughScoringPeriod: PERIOD,
    });

    expect(ledger.waiverType).toBe("faab");
    expect(ledger.budget).toBe(100);
    expect(ledger.latestRun?.scoringPeriod).toBe(PERIOD);
    expect(ledger.latestRun?.claims).toHaveLength(1);

    const claim = ledger.latestRun!.claims[0];
    expect(claim.teamId).toBe(team8);
    expect(claim.bid).toBe(41);
    // Descending, and the $0 CANCELED bid (also team 8) never appears as competition.
    expect(claim.competingBids.map((bid) => bid.bid)).toEqual([35, 18, 10, 5]);
    expect(claim.competingBids.every((bid) => bid.bid !== 0)).toBe(true);
  });

  it("falls back to a scan-derived per-team budget when teams.transactionCounter is absent", async () => {
    const t = convexTest(schema, modules);
    const leagueId = await seedLeague(t);
    const team8 = await seedTeam(t, leagueId, "8");
    await seedTeam(t, leagueId, "3");
    await seedTeam(t, leagueId, "5");
    await seedTeam(t, leagueId, "1");
    await seedTeam(t, leagueId, "11");
    await seedContestedPeriodTransactions(t, leagueId);

    const ledger = await t.query(internal.aiQueries.getWaiverLedgerForAI, {
      leagueId,
      seasonId: SEASON,
      throughScoringPeriod: PERIOD,
    });

    const winnerBudget = ledger.budgets.find((b) => b.teamId === team8)!;
    expect(winnerBudget.spent).toBe(41);
    expect(winnerBudget.remaining).toBe(59);
    expect(winnerBudget.acquisitions).toBe(1);

    // A team whose only bid this period FAILED spent nothing and won nothing.
    const loserTeam = await t.run((ctx) =>
      ctx.db.query("teams").withIndex("by_external", (q) => q.eq("leagueId", leagueId).eq("externalId", "3").eq("seasonId", SEASON)).first()
    );
    const loserBudget = ledger.budgets.find((b) => b.teamId === loserTeam!._id)!;
    expect(loserBudget.spent).toBe(0);
    expect(loserBudget.remaining).toBe(100);

    expect(ledger.season.totalSpent).toBe(41);
    expect(ledger.season.averageWinningBid).toBe(41);
    expect(ledger.season.biggestBid?.bid).toBe(41);
    expect(ledger.season.mostActive?.teamId).toBe(team8);
  });

  it("prefers teams.transactionCounter (ESPN's authoritative season total) over the scan when every team has one", async () => {
    const t = convexTest(schema, modules);
    const leagueId = await seedLeague(t);
    // Verified shape against tests/fixtures/espn-teams-public-2025.json's transactionCounter object.
    const team8 = await seedTeam(t, leagueId, "8", {
      transactionCounter: { acquisitionBudgetSpent: 199, acquisitions: 28, drops: 29 },
    });
    await seedTeam(t, leagueId, "3", { transactionCounter: { acquisitionBudgetSpent: 35, acquisitions: 1 } });
    await seedTeam(t, leagueId, "5", { transactionCounter: { acquisitionBudgetSpent: 0, acquisitions: 0 } });
    await seedTeam(t, leagueId, "1", { transactionCounter: { acquisitionBudgetSpent: 0, acquisitions: 0 } });
    await seedTeam(t, leagueId, "11", { transactionCounter: { acquisitionBudgetSpent: 0, acquisitions: 0 } });
    await seedContestedPeriodTransactions(t, leagueId);

    const ledger = await t.query(internal.aiQueries.getWaiverLedgerForAI, {
      leagueId,
      seasonId: SEASON,
      throughScoringPeriod: PERIOD,
    });

    // 199, not the 41 the bounded scan of THIS period alone would produce - proves the counter wins.
    const winnerBudget = ledger.budgets.find((b) => b.teamId === team8)!;
    expect(winnerBudget.spent).toBe(199);
    expect(winnerBudget.acquisitions).toBe(28);
    expect(winnerBudget.remaining).toBe(0); // budget 100, spent 199 -> clamped at 0, never negative.
    expect(ledger.season.totalSpent).toBe(199 + 35);
  });

  it("non-FAAB league: waiverType/budget are undefined and every team's remaining is undefined", async () => {
    const t = convexTest(schema, modules);
    const leagueId = await seedLeague(t, { waiverType: "waivers" });
    await seedTeam(t, leagueId, "8");

    const ledger = await t.query(internal.aiQueries.getWaiverLedgerForAI, {
      leagueId,
      seasonId: SEASON,
      throughScoringPeriod: PERIOD,
    });

    expect(ledger.waiverType).toBe("waivers");
    expect(ledger.budget).toBeUndefined();
    expect(ledger.budgets.every((b) => b.remaining === undefined)).toBe(true);
  });

  it("a league with no waiver activity yet returns no latest run rather than throwing", async () => {
    const t = convexTest(schema, modules);
    const leagueId = await seedLeague(t);
    await seedTeam(t, leagueId, "1");

    const ledger = await t.query(internal.aiQueries.getWaiverLedgerForAI, {
      leagueId,
      seasonId: SEASON,
      throughScoringPeriod: PERIOD,
    });

    expect(ledger.latestRun).toBeUndefined();
    expect(ledger.season.biggestBid).toBeUndefined();
  });
});
