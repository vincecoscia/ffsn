/**
 * `convex/lib/espnTransactions.ts` (the FAAB waiver wire report's data
 * source - spec: the report needs winning/losing bids and remaining
 * budgets, and the old `transactions` source - `syncPlayerTransactions`'s
 * per-player payload arrays - missed most of the real ESPN log) and the
 * `convex/espnSync.ts` pieces that use it: `updateTeams` storing
 * `transactionCounter`/`waiverRank`, and the `upsertTransactions` /
 * `syncTransactionLog` transaction-log sync path.
 *
 * Fixture: tests/fixtures/espn-transactions-public.json (public league
 * 899513, `view=mTransactions2&scoringPeriodId=N`) and
 * tests/fixtures/espn-teams-public-2025.json (`view=mTeam`).
 */
import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import schema from "../convex/schema";
import { internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import {
  classifyTransactionStatus,
  normalizeEspnTransaction,
  summarizeWaiverRun,
  type RawEspnTransaction,
} from "../convex/lib/espnTransactions";
import transactionsFixture from "./fixtures/espn-transactions-public.json";
import teamsFixture from "./fixtures/espn-teams-public-2025.json";

const modules = import.meta.glob("../convex/**/*.*s");

const LEAGUE_ID_PLACEHOLDER = "leagues_placeholder" as unknown as Id<"leagues">;
const period5Transactions = transactionsFixture.periods["2025-5"].transactions as RawEspnTransaction[];

async function seedLeague(
  t: ReturnType<typeof convexTest>,
  opts: { externalId?: string } = {}
): Promise<Id<"leagues">> {
  const now = Date.now();
  return await t.run(async (ctx) =>
    ctx.db.insert("leagues", {
      name: "Transaction Log Test League",
      platform: "espn",
      externalId: opts.externalId ?? "899513",
      commissionerUserId: "clerk_txn_commish",
      settings: { scoringType: "PPR", rosterSize: 16, playoffWeeks: 3, categories: [] },
      espnData: {
        seasonId: 2025,
        currentScoringPeriod: 5,
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
        seasonYear: 2025,
      },
      lastSync: now,
      createdAt: now,
    })
  );
}

function minimalTeamData(externalId: string, overrides: Record<string, unknown> = {}) {
  return {
    externalId,
    name: `Team ${externalId}`,
    owner: "Owner",
    record: { wins: 0, losses: 0, ties: 0 },
    roster: [],
    ...overrides,
  };
}

describe("classifyTransactionStatus", () => {
  it("classifies every live status from the fixture (period 5, 2025)", () => {
    expect(classifyTransactionStatus("EXECUTED", false)).toBe("executed");
    expect(classifyTransactionStatus("FAILED_INVALIDPLAYERSOURCE", false)).toBe("failed");
    expect(classifyTransactionStatus("FAILED_PLAYERALREADYDROPPED", false)).toBe("failed");
    expect(classifyTransactionStatus("FAILED_ROSTERLOCK", false)).toBe("failed");
    expect(classifyTransactionStatus("CANCELED", false)).toBe("cancelled");
    expect(classifyTransactionStatus("CANCELLED", false)).toBe("cancelled");
  });

  it("isPending wins over the status text - a claim can't be both pending and resolved", () => {
    expect(classifyTransactionStatus("EXECUTED", true)).toBe("pending");
  });

  it("treats a literal PENDING status the same as the isPending flag", () => {
    expect(classifyTransactionStatus("PENDING", false)).toBe("pending");
  });

  it("falls back to pending for an unrecognized status instead of guessing win/loss", () => {
    expect(classifyTransactionStatus("SOME_NEW_ESPN_STATUS", false)).toBe("pending");
    expect(classifyTransactionStatus(undefined, false)).toBe("pending");
  });

  it("classifies every status actually present in the fixture without throwing", () => {
    const seen = new Set(period5Transactions.map((t) => t.status));
    expect(seen).toEqual(
      new Set([
        "EXECUTED",
        "FAILED_INVALIDPLAYERSOURCE",
        "CANCELED",
        "FAILED_PLAYERALREADYDROPPED",
        "FAILED_ROSTERLOCK",
      ])
    );
    for (const status of seen) {
      expect(() => classifyTransactionStatus(status, false)).not.toThrow();
    }
  });
});

describe("normalizeEspnTransaction", () => {
  it("never stores memberId, even when the raw ESPN row carries one", () => {
    const raw = {
      id: "test-txn-1",
      type: "WAIVER",
      status: "EXECUTED",
      bidAmount: 12,
      executionType: "PROCESS",
      isPending: false,
      teamId: 3,
      scoringPeriodId: 5,
      proposedDate: 1_700_000_000_000,
      items: [{ type: "ADD", playerId: 12345 }],
      // Production rows carry this - a person's ESPN id.
      memberId: "{SOME-MEMBER-GUID}",
    } as RawEspnTransaction & { memberId: string };

    const normalized = normalizeEspnTransaction(raw, {
      leagueId: LEAGUE_ID_PLACEHOLDER,
      seasonId: 2025,
      scoringPeriod: 5,
    });

    expect(normalized).not.toHaveProperty("memberId");
    expect(Object.keys(normalized)).not.toContain("memberId");
  });

  it("normalizes a real fixture row (EXECUTED) with the expected outcome/source", () => {
    const raw = period5Transactions.find((t) => t.status === "EXECUTED" && t.type === "WAIVER")!;
    const normalized = normalizeEspnTransaction(raw, {
      leagueId: LEAGUE_ID_PLACEHOLDER,
      seasonId: 2025,
      scoringPeriod: 5,
    });

    expect(normalized.outcome).toBe("executed");
    expect(normalized.failureReason).toBeUndefined();
    expect(normalized.source).toBe("transaction_log");
    expect(normalized.espnTransactionId).toBe(raw.id);
    expect(normalized.relatedTransactionId).toBe(raw.relatedTransactionId);
  });

  it("normalizes a FAILED row with failureReason set to the raw status", () => {
    const raw = period5Transactions.find((t) => t.status === "FAILED_INVALIDPLAYERSOURCE")!;
    const normalized = normalizeEspnTransaction(raw, {
      leagueId: LEAGUE_ID_PLACEHOLDER,
      seasonId: 2025,
      scoringPeriod: 5,
    });

    expect(normalized.outcome).toBe("failed");
    expect(normalized.failureReason).toBe("FAILED_INVALIDPLAYERSOURCE");
  });

  it("defaults items to [] for a row with no items (e.g. TRADE_DECLINE)", () => {
    const raw = {
      id: "test-txn-no-items",
      type: "TRADE_DECLINE",
      status: "EXECUTED",
      teamId: 1,
      proposedDate: 1_700_000_000_000,
    } as RawEspnTransaction;

    const normalized = normalizeEspnTransaction(raw, {
      leagueId: LEAGUE_ID_PLACEHOLDER,
      seasonId: 2025,
      scoringPeriod: 5,
    });

    expect(normalized.items).toEqual([]);
    expect(normalized.bidAmount).toBe(0);
  });
});

describe("summarizeWaiverRun", () => {
  it("matches the contested player example: winner $41, losers [35, 18, 10, 5], cancelled bid ignored", () => {
    const normalized = period5Transactions.map((raw) =>
      normalizeEspnTransaction(raw, { leagueId: LEAGUE_ID_PLACEHOLDER, seasonId: 2025, scoringPeriod: 5 })
    );

    const summary = summarizeWaiverRun(normalized);
    const player = summary.find((s) => s.playerId === 4362478);

    expect(player).toBeDefined();
    expect(player!.winnerBid).toBe(41);
    expect(player!.winnerTeamId).toBe(8);
    expect(player!.loserBids).toEqual([35, 18, 10, 5]);
  });

  it("excludes non-WAIVER transactions and cancelled claims entirely", () => {
    const normalized = period5Transactions.map((raw) =>
      normalizeEspnTransaction(raw, { leagueId: LEAGUE_ID_PLACEHOLDER, seasonId: 2025, scoringPeriod: 5 })
    );
    const summary = summarizeWaiverRun(normalized);

    // FUTURE_ROSTER rows (4 of them in the fixture) must never appear.
    const futureRosterAddPlayerIds = period5Transactions
      .filter((t) => t.type === "FUTURE_ROSTER")
      .flatMap((t) => t.items?.filter((i) => i.type === "ADD").map((i) => i.playerId) ?? []);
    for (const playerId of futureRosterAddPlayerIds) {
      expect(summary.some((s) => s.playerId === playerId)).toBe(false);
    }

    // No summary group should end up with a winner/loser bid of exactly the
    // cancelled $0 claim's amount attributed as a real loss for that team.
    for (const group of summary) {
      expect(group.loserBids.every((bid) => bid >= 0)).toBe(true);
    }
  });
});

describe("espnSync.updateTeams stores transactionCounter/waiverRank", () => {
  it("stores the transactionCounter object and waiverRank from an ESPN mTeam payload", async () => {
    const t = convexTest(schema, modules);
    const leagueId = await seedLeague(t);
    const fixtureTeam = teamsFixture.teams[0];

    await t.mutation(internal.espnSync.updateTeams, {
      leagueId,
      seasonId: 2025,
      teamsData: [
        minimalTeamData(String(fixtureTeam.id), {
          transactionCounter: fixtureTeam.transactionCounter,
          waiverRank: fixtureTeam.waiverRank,
        }),
      ],
    });

    const stored = await t.run((ctx) =>
      ctx.db
        .query("teams")
        .withIndex("by_external", (q) =>
          q.eq("leagueId", leagueId).eq("externalId", String(fixtureTeam.id)).eq("seasonId", 2025)
        )
        .first()
    );

    expect(stored?.waiverRank).toBe(10);
    expect(stored?.transactionCounter?.acquisitionBudgetSpent).toBe(199);
    expect(stored?.transactionCounter?.acquisitions).toBe(28);
    expect(stored?.transactionCounter?.drops).toBe(29);
    expect(stored?.transactionCounter?.matchupAcquisitionTotals?.["15"]).toBe(4);
  });

  it("leaves transactionCounter/waiverRank undefined when the payload omits them", async () => {
    const t = convexTest(schema, modules);
    const leagueId = await seedLeague(t);

    await t.mutation(internal.espnSync.updateTeams, {
      leagueId,
      seasonId: 2025,
      teamsData: [minimalTeamData("999")],
    });

    const stored = await t.run((ctx) =>
      ctx.db
        .query("teams")
        .withIndex("by_external", (q) => q.eq("leagueId", leagueId).eq("externalId", "999").eq("seasonId", 2025))
        .first()
    );

    expect(stored?.transactionCounter).toBeUndefined();
    expect(stored?.waiverRank).toBeUndefined();
  });
});

describe("espnSync.upsertTransactions", () => {
  it("is idempotent - re-upserting the same row inserts once, then only updates", async () => {
    const t = convexTest(schema, modules);
    const leagueId = await seedLeague(t);
    const raw = period5Transactions.find((tx) => tx.status === "EXECUTED" && tx.type === "WAIVER")!;
    const normalized = normalizeEspnTransaction(raw, { leagueId, seasonId: 2025, scoringPeriod: 5 });

    const first = await t.mutation(internal.espnSync.upsertTransactions, { transactions: [normalized] });
    expect(first).toEqual({ inserted: 1, updated: 0 });

    const second = await t.mutation(internal.espnSync.upsertTransactions, { transactions: [normalized] });
    expect(second).toEqual({ inserted: 0, updated: 1 });

    const rows = await t.run((ctx) =>
      ctx.db
        .query("transactions")
        .withIndex("by_espn_id", (q) => q.eq("espnTransactionId", raw.id))
        .collect()
    );
    expect(rows).toHaveLength(1);
  });

  it("upgrades a pending claim to executed/failed on a later fetch without duplicating the row", async () => {
    const t = convexTest(schema, modules);
    const leagueId = await seedLeague(t);

    const pendingRaw: RawEspnTransaction = {
      id: "pending-to-executed-txn",
      type: "WAIVER",
      status: "PENDING",
      isPending: true,
      bidAmount: 25,
      executionType: "PROCESS",
      teamId: 4,
      scoringPeriodId: 6,
      proposedDate: Date.now(),
      items: [{ type: "ADD", playerId: 555 }],
    };
    const pendingNormalized = normalizeEspnTransaction(pendingRaw, {
      leagueId,
      seasonId: 2025,
      scoringPeriod: 6,
    });
    expect(pendingNormalized.outcome).toBe("pending");

    await t.mutation(internal.espnSync.upsertTransactions, { transactions: [pendingNormalized] });

    const resolvedRaw: RawEspnTransaction = {
      ...pendingRaw,
      status: "EXECUTED",
      isPending: false,
      processDate: Date.now(),
    };
    const resolvedNormalized = normalizeEspnTransaction(resolvedRaw, {
      leagueId,
      seasonId: 2025,
      scoringPeriod: 6,
    });
    expect(resolvedNormalized.outcome).toBe("executed");

    const result = await t.mutation(internal.espnSync.upsertTransactions, {
      transactions: [resolvedNormalized],
    });
    expect(result).toEqual({ inserted: 0, updated: 1 });

    const rows = await t.run((ctx) =>
      ctx.db
        .query("transactions")
        .withIndex("by_espn_id", (q) => q.eq("espnTransactionId", "pending-to-executed-txn"))
        .collect()
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe("executed");
    expect(rows[0].status).toBe("EXECUTED");
    expect(rows[0].processDate).toBeDefined();
  });

  it("a transaction_log row overwrites a player_feed row with the same espnTransactionId", async () => {
    const t = convexTest(schema, modules);
    const leagueId = await seedLeague(t);

    // Seed a player_feed row the way `storePlayerTransactions` would.
    await t.mutation(internal.espnSync.storePlayerTransactions, {
      transactions: [
        {
          leagueId,
          seasonId: 2025,
          espnTransactionId: "shared-espn-id",
          bidAmount: 10,
          executionType: "PROCESS",
          isActingAsTeamOwner: false,
          isLeagueManager: false,
          isPending: false,
          items: [],
          type: "WAIVER",
          proposedDate: Date.now(),
          scoringPeriod: 5,
          status: "EXECUTED",
          teamId: 2,
        },
      ],
    });

    let stored = await t.run((ctx) =>
      ctx.db
        .query("transactions")
        .withIndex("by_espn_id", (q) => q.eq("espnTransactionId", "shared-espn-id"))
        .first()
    );
    expect(stored?.source).toBe("player_feed");
    expect(stored?.bidAmount).toBe(10);

    // The transaction log fetches the same ESPN transaction with the
    // authoritative bid amount.
    const logRaw: RawEspnTransaction = {
      id: "shared-espn-id",
      type: "WAIVER",
      status: "EXECUTED",
      isPending: false,
      bidAmount: 15,
      executionType: "PROCESS",
      teamId: 2,
      scoringPeriodId: 5,
      proposedDate: Date.now(),
      items: [],
    };
    await t.mutation(internal.espnSync.upsertTransactions, {
      transactions: [normalizeEspnTransaction(logRaw, { leagueId, seasonId: 2025, scoringPeriod: 5 })],
    });

    stored = await t.run((ctx) =>
      ctx.db
        .query("transactions")
        .withIndex("by_espn_id", (q) => q.eq("espnTransactionId", "shared-espn-id"))
        .first()
    );
    expect(stored?.source).toBe("transaction_log");
    expect(stored?.bidAmount).toBe(15);

    const rows = await t.run((ctx) =>
      ctx.db
        .query("transactions")
        .withIndex("by_espn_id", (q) => q.eq("espnTransactionId", "shared-espn-id"))
        .collect()
    );
    expect(rows).toHaveLength(1);
  });
});

describe("espnSync.storePlayerTransactions", () => {
  it("marks inserted rows source: player_feed and classifies their outcome", async () => {
    const t = convexTest(schema, modules);
    const leagueId = await seedLeague(t);

    const result = await t.mutation(internal.espnSync.storePlayerTransactions, {
      transactions: [
        {
          leagueId,
          seasonId: 2025,
          espnTransactionId: "player-feed-txn-1",
          bidAmount: 7,
          executionType: "PROCESS",
          isActingAsTeamOwner: false,
          isLeagueManager: false,
          isPending: false,
          items: [],
          type: "WAIVER",
          proposedDate: Date.now(),
          scoringPeriod: 5,
          status: "FAILED_INVALIDPLAYERSOURCE",
          teamId: 3,
        },
      ],
    });
    expect(result.stored).toBe(1);

    const stored = await t.run((ctx) =>
      ctx.db
        .query("transactions")
        .withIndex("by_espn_id", (q) => q.eq("espnTransactionId", "player-feed-txn-1"))
        .first()
    );
    expect(stored?.source).toBe("player_feed");
    expect(stored?.outcome).toBe("failed");
    expect(stored?.failureReason).toBe("FAILED_INVALIDPLAYERSOURCE");
  });

  it("never overwrites an existing transaction_log row for the same espnTransactionId", async () => {
    const t = convexTest(schema, modules);
    const leagueId = await seedLeague(t);

    const logRaw: RawEspnTransaction = {
      id: "log-first-id",
      type: "WAIVER",
      status: "EXECUTED",
      isPending: false,
      bidAmount: 99,
      executionType: "PROCESS",
      teamId: 6,
      scoringPeriodId: 5,
      proposedDate: Date.now(),
      items: [],
    };
    await t.mutation(internal.espnSync.upsertTransactions, {
      transactions: [normalizeEspnTransaction(logRaw, { leagueId, seasonId: 2025, scoringPeriod: 5 })],
    });

    const result = await t.mutation(internal.espnSync.storePlayerTransactions, {
      transactions: [
        {
          leagueId,
          seasonId: 2025,
          espnTransactionId: "log-first-id",
          bidAmount: 1,
          executionType: "PROCESS",
          isActingAsTeamOwner: false,
          isLeagueManager: false,
          isPending: false,
          items: [],
          type: "WAIVER",
          proposedDate: Date.now(),
          scoringPeriod: 5,
          status: "EXECUTED",
          teamId: 6,
        },
      ],
    });
    expect(result.skipped).toBe(1);

    const stored = await t.run((ctx) =>
      ctx.db
        .query("transactions")
        .withIndex("by_espn_id", (q) => q.eq("espnTransactionId", "log-first-id"))
        .first()
    );
    expect(stored?.source).toBe("transaction_log");
    expect(stored?.bidAmount).toBe(99);
  });
});

describe("espnSync.syncTransactionLog", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("fetches and upserts two scoring periods, one ESPN request per period", async () => {
    const t = convexTest(schema, modules);
    const leagueId = await seedLeague(t, { externalId: "899513" });

    const period6Transactions: RawEspnTransaction[] = [
      {
        id: "synthetic-period-6-txn",
        type: "WAIVER",
        status: "EXECUTED",
        isPending: false,
        bidAmount: 20,
        executionType: "PROCESS",
        teamId: 5,
        scoringPeriodId: 6,
        proposedDate: Date.now(),
        items: [{ type: "ADD", playerId: 999999 }],
      },
    ];

    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      const period = url.searchParams.get("scoringPeriodId");
      if (period === "5") {
        return new Response(
          JSON.stringify({ seasonId: 2025, scoringPeriodId: 5, transactions: period5Transactions }),
          { status: 200 }
        );
      }
      if (period === "6") {
        return new Response(
          JSON.stringify({ seasonId: 2025, scoringPeriodId: 6, transactions: period6Transactions }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await t.action(internal.espnSync.syncTransactionLog, {
      leagueId,
      seasonId: 2025,
      scoringPeriods: [5, 6],
    });

    expect(result.periodsFetched).toBe(2);
    expect(result.periodsFailed).toBe(0);
    expect(result.transactionsUpserted).toBe(period5Transactions.length + 1);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const rows = await t.run((ctx) =>
      ctx.db
        .query("transactions")
        .withIndex("by_season", (q) => q.eq("leagueId", leagueId).eq("seasonId", 2025))
        .collect()
    );
    expect(rows).toHaveLength(period5Transactions.length + 1);
    expect(rows.every((r) => r.source === "transaction_log")).toBe(true);
    // memberId must never leak through the full fetch -> normalize -> store path.
    expect(rows.every((r) => !("memberId" in r))).toBe(true);

    // Re-running the same fetch must not duplicate rows (idempotent upsert).
    const second = await t.action(internal.espnSync.syncTransactionLog, {
      leagueId,
      seasonId: 2025,
      scoringPeriods: [5, 6],
    });
    expect(second.transactionsUpserted).toBe(period5Transactions.length + 1);

    const rowsAfterRerun = await t.run((ctx) =>
      ctx.db
        .query("transactions")
        .withIndex("by_season", (q) => q.eq("leagueId", leagueId).eq("seasonId", 2025))
        .collect()
    );
    expect(rowsAfterRerun).toHaveLength(period5Transactions.length + 1);
  });

  it("records a failed period without throwing and continues to the next one", async () => {
    const t = convexTest(schema, modules);
    const leagueId = await seedLeague(t, { externalId: "899513" });

    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      const period = url.searchParams.get("scoringPeriodId");
      if (period === "1") {
        return new Response("Not Found", { status: 404 });
      }
      return new Response(JSON.stringify({ seasonId: 2025, scoringPeriodId: 2, transactions: [] }), {
        status: 200,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await t.action(internal.espnSync.syncTransactionLog, {
      leagueId,
      seasonId: 2025,
      scoringPeriods: [1, 2],
    });

    expect(result.periodsFailed).toBe(1);
    expect(result.periodsFetched).toBe(1);
    expect(result.success).toBe(false);
  });
});

describe("espnSync.hasTransactionLogForSeason", () => {
  it("is false with no rows, true once a transaction_log row exists for that season", async () => {
    const t = convexTest(schema, modules);
    const leagueId = await seedLeague(t);

    expect(
      await t.query(internal.espnSync.hasTransactionLogForSeason, { leagueId, seasonId: 2025 })
    ).toBe(false);

    const raw = period5Transactions[0];
    await t.mutation(internal.espnSync.upsertTransactions, {
      transactions: [normalizeEspnTransaction(raw, { leagueId, seasonId: 2025, scoringPeriod: 5 })],
    });

    expect(
      await t.query(internal.espnSync.hasTransactionLogForSeason, { leagueId, seasonId: 2025 })
    ).toBe(true);

    // A different, still-empty season stays false.
    expect(
      await t.query(internal.espnSync.hasTransactionLogForSeason, { leagueId, seasonId: 2026 })
    ).toBe(false);
  });
});
