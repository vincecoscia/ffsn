/**
 * `convex/lib/tradesFromTransactions.ts` (ESPN refresh audit, Sept 2026, item 4.10: `trades`
 * derived from `TRADE_ACCEPT` transaction-log rows instead of the dead `espnSync.ts` message
 * parser). Shapes below mirror what's actually been seen in prod transaction rows (see
 * `brief-J-trades-status.md`): a clean 2-team trade (2025, teamId 10, three-for-three), a row
 * whose team set includes ESPN's "no team" placeholder `0` for a traded pick (2022, `[0,4,6]`),
 * and a negative D/ST playerId (`-16006`).
 */
import { describe, expect, it } from "vitest";
import {
  tradesFromTransactions,
  type TransactionLike,
  type TradeTeamRef,
  type TradePlayerRef,
} from "../convex/lib/tradesFromTransactions";
import type { Id } from "../convex/_generated/dataModel";

const LEAGUE_ID = "leagues_placeholder" as unknown as Id<"leagues">;

function baseRow(overrides: Partial<TransactionLike>): TransactionLike {
  return {
    leagueId: LEAGUE_ID,
    seasonId: 2025,
    espnTransactionId: "tx-default",
    type: "TRADE_ACCEPT",
    status: "EXECUTED",
    teamId: 1,
    items: [],
    proposedDate: 1_700_000_000_000,
    scoringPeriod: 5,
    ...overrides,
  };
}

describe("tradesFromTransactions", () => {
  it("derives a clean two-team trade (prod shape: 2025, teamId 10, 3-for-3)", () => {
    const row = baseRow({
      espnTransactionId: "tx-2025-1",
      teamId: 10,
      proposedDate: 1_735_000_000_000,
      processDate: 1_735_000_100_000,
      items: [
        { fromTeamId: 10, toTeamId: 1, playerId: 101, type: "TRADE" },
        { fromTeamId: 10, toTeamId: 1, playerId: 102, type: "TRADE" },
        { fromTeamId: 10, toTeamId: 1, playerId: 103, type: "TRADE" },
        { fromTeamId: 1, toTeamId: 10, playerId: 201, type: "TRADE" },
        { fromTeamId: 1, toTeamId: 10, playerId: 202, type: "TRADE" },
        { fromTeamId: 1, toTeamId: 10, playerId: 203, type: "TRADE" },
      ],
    });
    const teams: TradeTeamRef[] = [
      { externalId: "10", name: "Ten Team", owner: "Alice" },
      { externalId: "1", name: "One Team", owner: "Bob" },
    ];

    const trades = tradesFromTransactions([row], teams);

    expect(trades).toHaveLength(1);
    const [trade] = trades;
    expect(trade.espnTransactionId).toBe("tx-2025-1");
    expect(trade.status).toBe("completed");
    expect(trade.week).toBe(5);
    expect(trade.tradeDate).toBe(1_735_000_100_000); // processDate preferred over proposedDate
    expect(trade.teamA).toEqual({ teamId: "10", teamName: "Ten Team", manager: "Alice" });
    expect(trade.teamB).toEqual({ teamId: "1", teamName: "One Team", manager: "Bob" });
    expect(trade.playersFromTeamA.map((p) => p.playerId)).toEqual(["101", "102", "103"]);
    expect(trade.playersFromTeamB.map((p) => p.playerId)).toEqual(["201", "202", "203"]);
    expect(trade.picks).toEqual([]);
  });

  it("treats a fromTeamId-0 item as a pick, not a third team (prod shape: 2022, teams [0,4,6])", () => {
    const row = baseRow({
      seasonId: 2022,
      espnTransactionId: "tx-2022-1",
      teamId: 6,
      scoringPeriod: 12,
      items: [
        { fromTeamId: 4, toTeamId: 6, playerId: 301, type: "TRADE" },
        { fromTeamId: 6, toTeamId: 4, playerId: 401, type: "TRADE" },
        { fromTeamId: 0, toTeamId: 4, playerId: 0, type: "TRADE" },
      ],
    });
    const teams: TradeTeamRef[] = [
      { externalId: "4", name: "Four Team", owner: "Cara" },
      { externalId: "6", name: "Six Team", owner: "Dan" },
    ];

    const trades = tradesFromTransactions([row], teams);

    expect(trades).toHaveLength(1); // still one trade, not three teams
    const [trade] = trades;
    expect(trade.teamA.teamId).toBe("6"); // row.teamId wins when it's a participant
    expect(trade.teamB.teamId).toBe("4");
    expect(trade.playersFromTeamA.map((p) => p.playerId)).toEqual(["401"]);
    expect(trade.playersFromTeamB.map((p) => p.playerId)).toEqual(["301"]);
    expect(trade.picks).toEqual([{ toTeamId: "4", description: "Future draft pick" }]);
  });

  it("names a negative (D/ST) playerId generically when it's not in the players map", () => {
    const row = baseRow({
      espnTransactionId: "tx-dst-1",
      teamId: 1,
      items: [
        { fromTeamId: 1, toTeamId: 2, playerId: -16006, type: "TRADE" },
        { fromTeamId: 2, toTeamId: 1, playerId: 501, type: "TRADE" },
      ],
    });
    const teams: TradeTeamRef[] = [
      { externalId: "1", name: "One Team", owner: "Alice" },
      { externalId: "2", name: "Two Team", owner: "Bob" },
    ];

    const trades = tradesFromTransactions([row], teams);

    expect(trades[0].playersFromTeamA).toEqual([
      { playerId: "-16006", playerName: "Team Defense", position: "D/ST", team: "" },
    ]);
  });

  it("resolves a negative (D/ST) playerId's name from the players map when present", () => {
    const row = baseRow({
      espnTransactionId: "tx-dst-2",
      teamId: 1,
      items: [{ fromTeamId: 1, toTeamId: 2, playerId: -16006, type: "TRADE" }],
    });
    const teams: TradeTeamRef[] = [
      { externalId: "1", name: "One Team", owner: "Alice" },
      { externalId: "2", name: "Two Team", owner: "Bob" },
    ];
    const players = new Map<string, TradePlayerRef>([
      ["-16006", { name: "Bills D/ST", position: "D/ST", proTeam: "BUF" }],
    ]);

    const trades = tradesFromTransactions([row], teams, players);

    expect(trades[0].playersFromTeamA).toEqual([
      { playerId: "-16006", playerName: "Bills D/ST", position: "D/ST", team: "BUF" },
    ]);
  });

  it("ignores rows that aren't an executed TRADE_ACCEPT", () => {
    const pendingTrade = baseRow({
      espnTransactionId: "tx-pending",
      items: [{ fromTeamId: 1, toTeamId: 2, playerId: 1, type: "TRADE" }],
      status: "PENDING",
    });
    const declinedTrade = baseRow({
      espnTransactionId: "tx-declined",
      type: "TRADE_DECLINE",
      items: [{ fromTeamId: 1, toTeamId: 2, playerId: 1, type: "TRADE" }],
    });
    const waiverClaim = baseRow({
      espnTransactionId: "tx-waiver",
      type: "WAIVER",
      items: [{ fromTeamId: 0, toTeamId: 1, playerId: 1, type: "ADD" }],
    });

    expect(tradesFromTransactions([pendingTrade, declinedTrade, waiverClaim], [])).toEqual([]);
  });

  it("splits a genuine 3-team trade into one derived trade per pair that exchanged a player", () => {
    const row = baseRow({
      espnTransactionId: "tx-3team",
      teamId: 1,
      items: [
        { fromTeamId: 1, toTeamId: 2, playerId: 11, type: "TRADE" },
        { fromTeamId: 2, toTeamId: 3, playerId: 22, type: "TRADE" },
        { fromTeamId: 3, toTeamId: 1, playerId: 33, type: "TRADE" },
      ],
    });
    const teams: TradeTeamRef[] = [
      { externalId: "1", name: "One", owner: "A" },
      { externalId: "2", name: "Two", owner: "B" },
      { externalId: "3", name: "Three", owner: "C" },
    ];

    const trades = tradesFromTransactions([row], teams);

    expect(trades).toHaveLength(3);
    expect(trades.every((t) => t.espnTransactionId === "tx-3team")).toBe(true);

    const pairs = trades.map((t) => [t.teamA.teamId, t.teamB.teamId, t.playersFromTeamA[0]?.playerId, t.playersFromTeamB[0]?.playerId]);
    expect(pairs).toContainEqual(["1", "2", "11", undefined]);
    expect(pairs).toContainEqual(["2", "3", "22", undefined]);
    expect(pairs).toContainEqual(["1", "3", undefined, "33"]);
  });
});
