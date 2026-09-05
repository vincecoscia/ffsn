import { describe, expect, it } from "vitest";
import {
  adpIsUsable,
  attachNewsAndInjuryWatch,
  buildDraftPool,
  buildDraftTendencies,
  indexNewsByPlayer,
  leagueTypeFromDraftSettings,
  looksLikeInjuryNews,
  OUTLOOK_DEPTH,
  type PoolSource,
  type PriorPick,
} from "../convex/lib/mockDraftIntel";

const NOW = Date.parse("2026-09-05T18:00:00Z");
const DAY = 24 * 3_600_000;

function source(overrides: Partial<PoolSource> & { espnId: string; fullName: string; adp: number }): PoolSource {
  return { defaultPosition: "RB", proTeamAbbrev: "DET", injuryStatus: "ACTIVE", seasonOutlook: "", projected: null, ...overrides };
}

describe("buildDraftPool", () => {
  it("sorts by ADP, ranks within position, flags non-active status, and keeps the full outlook for the top of the pool", () => {
    const long = "Sentence one is about volume. Sentence two is about age. Sentence three is about the offensive line and it runs long enough to matter for the truncation rule. Sentence four.";
    const pool = buildDraftPool([
      source({ espnId: "2", fullName: "Second Back", adp: 2.4 }),
      source({ espnId: "1", fullName: "First Back", adp: 1.3, seasonOutlook: long }),
      source({ espnId: "3", fullName: "First Wide", adp: 4.3, defaultPosition: "WR", injuryStatus: "QUESTIONABLE" }),
      source({ espnId: "0", fullName: "No Adp", adp: 0 }),
    ]);
    expect(pool.map((p) => p.playerName)).toEqual(["First Back", "Second Back", "First Wide"]);
    expect(pool[0]).toMatchObject({ adpRank: 1, adpPositionRank: 1, position: "RB", injuryStatus: undefined });
    expect(pool[1]).toMatchObject({ adpRank: 2, adpPositionRank: 2 });
    expect(pool[2]).toMatchObject({ adpRank: 3, adpPositionRank: 1, position: "WR", injuryStatus: "QUESTIONABLE" });
    expect(pool[0].seasonOutlook).toBe(long);
  });

  it("shortens the outlook past the outlook depth and caps the pool", () => {
    const many = Array.from({ length: OUTLOOK_DEPTH + 5 }, (_, i) =>
      source({ espnId: String(i + 1), fullName: `Player ${i + 1}`, adp: i + 1, seasonOutlook: "First sentence here. Second sentence is much longer and should be dropped from the short form of the outlook entirely." })
    );
    const pool = buildDraftPool(many, OUTLOOK_DEPTH + 2);
    expect(pool).toHaveLength(OUTLOOK_DEPTH + 2);
    expect(pool[OUTLOOK_DEPTH - 1].seasonOutlook).toContain("Second sentence");
    expect(pool[OUTLOOK_DEPTH].seasonOutlook).toBe("First sentence here.");
  });
});

describe("draft tendencies", () => {
  const picks: PriorPick[] = [
    { teamName: "Old Name A", pickNumber: 1, roundNumber: 1, roundPickNumber: 1, playerName: "Jahmyr Gibbs", playerPosition: "RB", playerADP: 1.5 },
    { teamName: "Old Name A", pickNumber: 20, roundNumber: 2, roundPickNumber: 10, playerName: "Ashton Jeanty", playerPosition: "RB", playerADP: 12 },
    { teamName: "Old Name A", pickNumber: 21, roundNumber: 3, roundPickNumber: 1, playerName: "Alvin Kamara", playerPosition: "RB", playerADP: 62 },
    { teamName: "Old Name A", pickNumber: 40, roundNumber: 4, roundPickNumber: 10, playerName: "Josh Allen", playerPosition: "QB", playerADP: 18 },
    { teamName: "Old Name A", pickNumber: 41, roundNumber: 5, roundPickNumber: 1, playerName: "Sam LaPorta", playerPosition: "TE", playerADP: 45 },
    { teamName: "Team B", pickNumber: 2, roundNumber: 1, roundPickNumber: 2, playerName: "Bijan Robinson", playerPosition: "RB", playerADP: 2.4 },
    { teamName: "Team B", pickNumber: 19, roundNumber: 2, roundPickNumber: 9, playerName: "Puka Nacua", playerPosition: "WR", playerADP: 5.3 },
    { teamName: "Team B", pickNumber: 22, roundNumber: 3, roundPickNumber: 2, playerName: "Trey McBride", playerPosition: "TE", playerADP: 30 },
  ];
  const priorTeamIdByName = new Map([["Old Name A", "1"], ["Team B", "2"]]);
  const currentTeams = [
    { externalId: "2", name: "Team B", manager: "Bea", draftSlot: 1 },
    { externalId: "1", name: "New Name A", manager: "Al", draftSlot: 7 },
  ];

  it("resolves last year's picks to this year's team and manager, with the reach and the value", () => {
    const tendencies = buildDraftTendencies({ picks, priorTeamIdByName, currentTeams, lastSeason: new Map([["1", { record: "4-10", rank: 9 }]]) });
    expect(tendencies.map((t) => t.teamName)).toEqual(["Team B", "New Name A"]); // sorted by this year's slot
    const a = tendencies[1];
    expect(a).toMatchObject({ manager: "Al", draftSlot: 7, lastSeasonRecord: "4-10", lastSeasonRank: 9, positionalStart: "RB-RB-RB", firstQbRound: 4, firstTeRound: 5 });
    expect(a.firstThree[0]).toBe("1.01 Jahmyr Gibbs (RB)");
    expect(a.biggestReach).toMatchObject({ player: "Alvin Kamara", pick: 21, adp: 62, delta: 41 });
    expect(a.bestValue).toMatchObject({ player: "Josh Allen", pick: 40, adp: 18, delta: -22 });
    expect(a.positionCounts).toEqual({ RB: 3, QB: 1, TE: 1 });
  });

  it("drops reach and value when ESPN's ADP column is a placeholder", () => {
    const flat = picks.map((p) => ({ ...p, playerADP: 169 }));
    expect(adpIsUsable(flat)).toBe(false);
    const tendencies = buildDraftTendencies({ picks: flat, priorTeamIdByName, currentTeams });
    expect(tendencies.every((t) => t.biggestReach === undefined && t.bestValue === undefined)).toBe(true);
    expect(tendencies[1].firstThree).toHaveLength(3);
  });
});

describe("news and the injury watch", () => {
  const news = [
    { headline: "Chase Brown won't be overlooked", published: new Date(NOW - 1 * DAY).toISOString(), athleteIds: ["cb", "jc"] },
    { headline: "Older camp note", published: new Date(NOW - 12 * DAY).toISOString(), athleteIds: ["jc"] },
    { headline: "Way too old", published: new Date(NOW - 40 * DAY).toISOString(), athleteIds: ["jc", "cmc"] },
    { headline: "Fantasy football sleepers, busts and breakouts for 2026", published: new Date(NOW - 1 * DAY).toISOString(), athleteIds: ["cmc", "jc", "a", "b", "c", "d", "e", "f"] },
    { headline: "McCaffrey limited in practice", published: new Date(NOW - 20 * DAY).toISOString(), athleteIds: ["cmc"] },
  ];

  it("keeps the week's headline per player and ignores listicles tagged to everyone", () => {
    const byPlayer = indexNewsByPlayer(news, NOW, 7);
    expect(byPlayer.get("jc")?.map((n) => n.headline)).toEqual(["Chase Brown won't be overlooked"]);
    expect(byPlayer.get("cmc")).toBeUndefined();
  });

  it("only calls a headline injury news when it names the player and reads like an injury", () => {
    expect(looksLikeInjuryNews("McCaffrey limited in practice", "Christian McCaffrey")).toBe(true);
    expect(looksLikeInjuryNews("Fantasy football sleepers, busts and breakouts for 2026", "Christian McCaffrey")).toBe(false);
    expect(looksLikeInjuryNews("Chase Brown won't be overlooked", "Ja'Marr Chase")).toBe(false);
  });

  it("attaches headlines to the pool and builds the injury watch with a 30-day headline", () => {
    const pool = buildDraftPool([
      source({ espnId: "cmc", fullName: "Christian McCaffrey", adp: 7.7, injuryStatus: "QUESTIONABLE" }),
      source({ espnId: "jc", fullName: "Ja'Marr Chase", adp: 4.3, defaultPosition: "WR" }),
      source({ espnId: "deep", fullName: "Deep Sleeper", adp: 180, injuryStatus: "OUT" }),
    ]);
    const { pool: withNews, injuryWatch } = attachNewsAndInjuryWatch(pool, news, NOW);
    expect(withNews.find((p) => p.playerId === "jc")?.recentNews).toEqual([{ headline: "Chase Brown won't be overlooked", published: new Date(NOW - DAY).toISOString().slice(0, 10) }]);
    expect(withNews.find((p) => p.playerId === "cmc")?.recentNews).toBeUndefined();
    expect(injuryWatch).toHaveLength(1); // the ADP-180 player is outside the watch
    expect(injuryWatch[0]).toMatchObject({ playerName: "Christian McCaffrey", injuryStatus: "QUESTIONABLE" });
    expect(injuryWatch[0].latestHeadline?.headline).toBe("McCaffrey limited in practice");
  });
});

describe("leagueTypeFromDraftSettings", () => {
  it("reads keeper and dynasty from ESPN's settings before any pick exists", () => {
    expect(leagueTypeFromDraftSettings({ keeperCount: 0, leagueSubType: "NONE" })).toBe("Redraft");
    expect(leagueTypeFromDraftSettings({ keeperCount: 3 })).toBe("Keeper");
    expect(leagueTypeFromDraftSettings({ keeperCount: 0, leagueSubType: "DYNASTY" })).toBe("Dynasty");
    expect(leagueTypeFromDraftSettings(undefined)).toBe("Redraft");
  });
});
