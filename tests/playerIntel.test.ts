import { describe, expect, it } from "vitest";
import { buildFactsBlock, serializeFacts } from "../src/lib/ai/facts";
import { verifyArticle } from "../src/lib/ai/fact-verifier";
import { PromptBuilder } from "../src/lib/ai/prompt-builder";
import type { LeagueDataContext, PromptBuilderOptions } from "../src/lib/ai/prompt-builder";
import type { GeneratedArticleT } from "../src/lib/ai/content-generation-service";
import { mergeIntelIntoPool, type InjuryWatchEntry, type PoolPlayer } from "../convex/lib/mockDraftIntel";

/**
 * The player-intel layer at the prompt boundary (2026-09-05): the feeds' injury / practice / news
 * per player arrive on the payload as `playerIntel`, become the INTEL facts (dated, keyed by the
 * roster's P<espnId>, with the fantasy team), print as PLAYER INTEL in the prompt, and give the
 * verifier the list of who is actually hurt so an invented injury is flagged. Also the mock-draft
 * FACTS frame (draft order, last year's habits) the editor reads, and the pool merge.
 */

const NOW = Date.parse("2026-09-04T15:00:00Z");
const DAY = 24 * 3_600_000;

function roster(teamId: string, players: Array<[string, string, string, string?]>) {
  return players.map(([id, name, pos, injuryStatus]) => ({
    playerId: id,
    espnId: id,
    playerName: name,
    fullName: name,
    position: pos,
    team: "SF",
    nflTeam: "SF",
    fantasyTeamId: teamId,
    injuryStatus,
    acquisitionType: "DRAFT",
    lineupSlotId: 0,
  }));
}

function leagueData(overrides: Partial<LeagueDataContext> = {}): LeagueDataContext {
  return {
    leagueName: "Test League",
    currentWeek: 3,
    currentSeason: 2026,
    teams: [
      {
        id: "t1",
        externalId: "1",
        name: "Halyard Bay",
        owner: "Hal Jones",
        manager: "Hal",
        record: { wins: 2, losses: 0, ties: 0 },
        roster: roster("1", [["4040715", "Jalen Hurts", "QB"], ["4426515", "Puka Nacua", "WR", "QUESTIONABLE"]]),
      },
      {
        id: "t2",
        externalId: "2",
        name: "Ridge Runners",
        owner: "Rita Park",
        manager: "Rita",
        record: { wins: 0, losses: 2, ties: 0 },
        roster: roster("2", [["3116406", "Tyreek Hill", "WR"], ["4262921", "Justin Jefferson", "WR"]]),
      },
    ],
    standings: [],
    recentMatchups: [],
    upcomingMatchups: [],
    trades: [],
    transactions: [],
    ...overrides,
  } as unknown as LeagueDataContext;
}

const INTEL: NonNullable<LeagueDataContext["playerIntel"]> = [
  {
    espnId: "3116406",
    name: "Tyreek Hill",
    injury: {
      status: "Questionable",
      bodyPart: "Hamstring",
      practice: "Limited Participation in Practice",
      since: NOW - 2 * DAY,
      source: "sleeper",
      fetchedAt: NOW - 3_600_000,
      espnStatus: "ACTIVE",
    },
    news: [{ headline: "Tyreek Hill limited Wednesday with hamstring tightness", publishedAt: new Date(NOW - DAY).toISOString() }],
  },
  {
    espnId: "4262921",
    name: "Justin Jefferson",
    news: [{ headline: "Jefferson named NFC offensive player of the week", publishedAt: new Date(NOW - 2 * DAY).toISOString() }],
  },
  // Nothing to say: must not become an INTEL entry.
  { espnId: "4040715", name: "Jalen Hurts", news: [] },
];

function options(data: LeagueDataContext, contentType = "power_rankings"): PromptBuilderOptions {
  return { contentType, persona: "mel-diaper", leagueData: data } as PromptBuilderOptions;
}

function article(sections: Array<[string, string]>): GeneratedArticleT {
  return {
    title: "Preview",
    sections: sections.map(([name, content]) => ({ name, content })),
    facts: [],
    quotesUsed: [],
  } as unknown as GeneratedArticleT;
}

describe("INTEL facts", () => {
  it("keys each entry by the roster's P<espnId>, dates it to the day, resolves the fantasy team and drops empty entries", () => {
    const facts = buildFactsBlock({ contentType: "power_rankings", leagueData: leagueData({ playerIntel: INTEL }) });
    expect(facts.intel?.map(entry => entry.id)).toEqual(["P3116406", "P4262921"]);
    const hill = facts.intel?.[0];
    expect(hill?.fantasyTeamId).toBe(facts.teams.find(team => team.name === "Ridge Runners")?.id);
    expect(hill?.pos).toBe("WR");
    expect(hill?.injury).toMatchObject({
      status: "Questionable",
      bodyPart: "Hamstring",
      since: "2026-09-02",
      asOf: "2026-09-04",
      source: "sleeper",
      espnStatus: "ACTIVE",
    });
    expect(hill?.news[0]?.published).toBe("2026-09-03");
    expect(facts.missing.some(line => line.startsWith("intel"))).toBe(false);
  });

  it("carries the roster's own injuryStatus and says intel is missing when no feed had anything", () => {
    const facts = buildFactsBlock({ contentType: "power_rankings", leagueData: leagueData() });
    expect(facts.intel).toBeUndefined();
    const nacua = facts.rosters?.flatMap(r => r.players).find(p => p.name === "Puka Nacua");
    expect(nacua?.injuryStatus).toBe("QUESTIONABLE");
    const hurts = facts.rosters?.flatMap(r => r.players).find(p => p.name === "Jalen Hurts");
    expect(hurts?.injuryStatus).toBeUndefined();
    expect(facts.missing.some(line => line.startsWith("intel"))).toBe(true);
  });
});

describe("PLAYER INTEL in the prompt", () => {
  it("prints the dated injury line with the fantasy team, the ESPN disagreement and the headline", () => {
    const { userPrompt } = new PromptBuilder(options(leagueData({ playerIntel: INTEL }))).build();
    expect(userPrompt).toContain("PLAYER INTEL (fresh feeds");
    expect(userPrompt).toContain("Tyreek Hill (WR, SF) on Ridge Runners: QUESTIONABLE (Hamstring) since 2026-09-02, practice: Limited Participation in Practice - sleeper as of 2026-09-04 (ESPN still lists ACTIVE)");
    expect(userPrompt).toContain('news: "Tyreek Hill limited Wednesday with hamstring tightness" (2026-09-03)');
    expect(userPrompt).toContain("Justin Jefferson (WR, SF) on Ridge Runners: news:");
    expect(userPrompt).not.toContain("Jalen Hurts (QB");
    // The rule the writer works under.
    expect(userPrompt).toContain("No return timelines");
  });

  it("prints nothing when there is no intel, and the FACTS say so", () => {
    const { userPrompt } = new PromptBuilder(options(leagueData())).build();
    expect(userPrompt).not.toContain("PLAYER INTEL (fresh feeds");
    expect(userPrompt).toContain("intel — no fresh injury, practice or news feed today");
  });
});

describe("unsupported_injury", () => {
  it("warns on an injury claim about a player nothing in FACTS says is hurt, and not on the ones it does", () => {
    const opts = options(leagueData({ playerIntel: INTEL }));
    const facts = buildFactsBlock(opts);
    const violations = verifyArticle(
      article([
        ["Games", "Justin Jefferson is nursing a knee injury and could miss Sunday. Tyreek Hill is questionable with the hamstring. Puka Nacua is questionable too, and Jalen Hurts is fine."],
      ]),
      facts
    );
    const injuries = violations.filter(v => v.kind === "unsupported_injury");
    expect(injuries).toHaveLength(1);
    expect(injuries[0]?.detail).toContain("justin jefferson");
    expect(injuries[0]?.severity).toBe("warn");
  });

  it("does not fire on a sentence with no player in it", () => {
    const facts = buildFactsBlock(options(leagueData()));
    const violations = verifyArticle(article([["Games", "Injuries are piling up around the league this week."]]), facts);
    expect(violations.filter(v => v.kind === "unsupported_injury")).toHaveLength(0);
  });
});

describe("mockDraft facts", () => {
  it("carries the format, the draft order and last year's habits so the editor can settle them", () => {
    const data = leagueData({
      draftType: "Snake",
      leagueType: "Redraft",
      draftOrder: [
        { position: 1, teamId: "1", teamName: "Halyard Bay", manager: "Hal" },
        { position: 2, teamId: "2", teamName: "Ridge Runners", manager: "Rita" },
      ],
      draftTendencies: [
        {
          teamId: "2",
          teamName: "Ridge Runners",
          manager: "Rita",
          draftSlot: 2,
          lastSeasonRecord: "4-10",
          lastSeasonRank: 9,
          firstThree: ["Bijan Robinson (RB, pick 2)", "Josh Allen (QB, pick 19)", "Mark Andrews (TE, pick 22)"],
          positionalStart: "RB-QB-TE",
          firstQbRound: 2,
          firstTeRound: 3,
          biggestReach: { player: "Mark Andrews", pos: "TE", pick: 22, adp: 40.5, delta: 18.5 },
          bestValue: { player: "Josh Allen", pos: "QB", pick: 19, adp: 12.0, delta: -7 },
          positionCounts: { RB: 6, WR: 5, QB: 2, TE: 2 },
        },
      ],
      previousSeason: 2025,
      injuryWatch: [
        { playerId: "4426515", playerName: "Puka Nacua", position: "WR", proTeam: "LAR", adp: 5.3, injuryStatus: "QUESTIONABLE", latestHeadline: { headline: "Nacua limited", published: "2026-09-02" } },
      ],
      availablePlayers: [],
    } as Partial<LeagueDataContext>);
    const facts = buildFactsBlock({ contentType: "mock_draft", leagueData: data });
    expect(facts.mockDraft?.draftType).toBe("Snake");
    expect(facts.mockDraft?.teamCount).toBe(2);
    expect(facts.mockDraft?.previousSeason).toBe(2025);
    expect(facts.mockDraft?.order.map(pick => pick.team)).toEqual(["Halyard Bay", "Ridge Runners"]);
    const ridge = facts.teams.find(team => team.name === "Ridge Runners")?.id;
    expect(facts.mockDraft?.order[1]?.teamId).toBe(ridge);
    expect(facts.mockDraft?.lastYear[0]).toMatchObject({
      teamId: ridge,
      record: "4-10",
      firstQbRound: 2,
      biggestReach: { player: "Mark Andrews", spotsEarly: 18.5 },
      bestValue: { player: "Josh Allen", spotsLate: 7 },
    });
    expect(facts.mockDraft?.injuryWatch[0]).toMatchObject({ id: "P4426515", name: "Puka Nacua", injuryStatus: "QUESTIONABLE", latestHeadline: "Nacua limited" });
    expect(serializeFacts(facts)).toContain('"mockDraft"');
  });
});

describe("mergeIntelIntoPool", () => {
  const pool: PoolPlayer[] = [
    { playerId: "1", playerName: "Bijan Robinson", position: "RB", proTeam: "ATL", adp: 2.4, adpPositionRank: 1, adpRank: 1, seasonOutlook: "", projectedStats: null, ownership: { averageDraftPosition: 2.4 } },
    { playerId: "2", playerName: "Puka Nacua", position: "WR", proTeam: "LAR", adp: 5.3, adpPositionRank: 1, adpRank: 2, injuryStatus: "QUESTIONABLE", seasonOutlook: "", projectedStats: null, ownership: { averageDraftPosition: 5.3 } },
    { playerId: "3", playerName: "Deep Sleeper", position: "WR", proTeam: "NYJ", adp: 180, adpPositionRank: 70, adpRank: 3, seasonOutlook: "", projectedStats: null, ownership: { averageDraftPosition: 180 } },
  ];
  const watch: InjuryWatchEntry[] = [
    { playerId: "2", playerName: "Puka Nacua", position: "WR", proTeam: "LAR", adp: 5.3, injuryStatus: "QUESTIONABLE" },
  ];

  it("takes a feed status over ESPN's ACTIVE, adds the FFC ADP and trending, and grows the watch for high-profile players only", () => {
    const merged = mergeIntelIntoPool(pool, watch, [
      { espnId: "1", injury: { status: "Questionable", bodyPart: "Ankle", source: "sleeper", fetchedAt: NOW }, market: { ffcAdp: 1.8, trendingAdds: 120 }, news: [{ headline: "Robinson tweaks ankle", publishedAt: "2026-09-03T12:00:00Z" }] },
      { espnId: "2", injury: { status: "Out", source: "nflverse", fetchedAt: NOW }, news: [] },
      { espnId: "3", injury: { status: "Questionable", source: "sleeper", fetchedAt: NOW }, news: [] },
    ]);
    const bijan = merged.pool[0]!;
    expect(bijan.injuryStatus).toBe("QUESTIONABLE");
    expect(bijan.intelInjury).toMatchObject({ status: "Questionable", bodyPart: "Ankle", source: "sleeper", asOf: NOW });
    expect(bijan.ffcAdp).toBe(1.8);
    expect(bijan.trendingAdds).toBe(120);
    // ESPN's own status is kept when it has one; the feed line rides alongside.
    expect(merged.pool[1]?.injuryStatus).toBe("QUESTIONABLE");
    expect(merged.pool[1]?.intelInjury?.status).toBe("Out");
    expect(merged.injuryWatch.map(entry => entry.playerId)).toEqual(["1", "2"]);
    expect(merged.injuryWatch[0]?.latestHeadline?.headline).toBe("Robinson tweaks ankle");
  });

  it("leaves the pool alone when the feed has nothing", () => {
    const merged = mergeIntelIntoPool(pool, watch, []);
    expect(merged.pool).toEqual(pool);
    expect(merged.injuryWatch).toEqual(watch);
  });
});

describe("mergeIntelIntoPool - feed cleared", () => {
  const pool: PoolPlayer[] = [
    { playerId: "10", playerName: "Ja'Marr Chase", position: "WR", proTeam: "CIN", adp: 4.3, adpPositionRank: 1, adpRank: 1, injuryStatus: "QUESTIONABLE", seasonOutlook: "", projectedStats: null, ownership: { averageDraftPosition: 4.3 } },
    { playerId: "11", playerName: "Tee Higgins", position: "WR", proTeam: "CIN", adp: 51.3, adpPositionRank: 20, adpRank: 2, injuryStatus: "QUESTIONABLE", seasonOutlook: "", projectedStats: null, ownership: { averageDraftPosition: 51.3 } },
    { playerId: "12", playerName: "Josh Jacobs", position: "RB", proTeam: "GB", adp: 79.3, adpPositionRank: 25, adpRank: 3, injuryStatus: "DAY_TO_DAY", seasonOutlook: "", projectedStats: null, ownership: { averageDraftPosition: 79.3 } },
    { playerId: "13", playerName: "Hard Case", position: "RB", proTeam: "NYJ", adp: 90, adpPositionRank: 30, adpRank: 4, injuryStatus: "INJURY_RESERVE", seasonOutlook: "", projectedStats: null, ownership: { averageDraftPosition: 90 } },
  ];
  const watch: InjuryWatchEntry[] = pool.map(p => ({ playerId: p.playerId, playerName: p.playerName, position: p.position, proTeam: p.proTeam, adp: p.adp, injuryStatus: p.injuryStatus!, latestHeadline: p.playerId === "11" ? { headline: "Higgins limited with hamstring", published: "2026-09-03" } : undefined }));

  it("marks a soft ESPN tag the fresh feed does not carry, drops it from the watch unless a headline or a hard status backs it, and labels NA", () => {
    const merged = mergeIntelIntoPool(pool, watch, [
      { espnId: "10", cleared: { source: "sleeper", fetchedAt: NOW }, news: [] },
      { espnId: "11", cleared: { source: "sleeper", fetchedAt: NOW }, news: [] },
      { espnId: "12", injury: { status: "NA", bodyPart: "Groin", source: "sleeper", fetchedAt: NOW }, news: [] },
      { espnId: "13", cleared: { source: "sleeper", fetchedAt: NOW }, news: [] },
    ]);
    const chase = merged.pool[0]!;
    expect(chase.injuryStatus).toBe("QUESTIONABLE");
    expect(chase.feedCleared).toEqual({ source: "sleeper", asOf: NOW });
    // Jacobs keeps ESPN's tag; the feed line rides alongside with the readable token.
    expect(merged.pool[2]?.injuryStatus).toBe("DAY_TO_DAY");
    expect(merged.pool[2]?.intelInjury?.status).toBe("NA");
    expect(merged.injuryWatch.map(entry => entry.playerId)).toEqual(["11", "12", "13"]);
    expect(merged.injuryWatch.find(entry => entry.playerId === "11")?.feedCleared).toEqual({ source: "sleeper", asOf: NOW });
  });

  it("prints the feed's word next to ESPN's tag on the pool line, the watch line and in FACTS", () => {
    const merged = mergeIntelIntoPool(pool, watch, [
      { espnId: "10", cleared: { source: "sleeper", fetchedAt: NOW }, news: [] },
      { espnId: "12", injury: { status: "NA", bodyPart: "Groin", source: "sleeper", fetchedAt: NOW }, news: [] },
    ]);
    const data = leagueData({
      draftType: "Snake",
      leagueType: "Redraft",
      draftOrder: [{ position: 1, teamId: "1", teamName: "Halyard Bay", manager: "Hal" }, { position: 2, teamId: "2", teamName: "Ridge Runners", manager: "Rita" }],
      availablePlayers: merged.pool as unknown as LeagueDataContext["availablePlayers"],
      injuryWatch: merged.injuryWatch,
    } as Partial<LeagueDataContext>);
    const { userPrompt, facts } = new PromptBuilder(options(data, "mock_draft")).build();
    expect(userPrompt).toContain("Ja'Marr Chase (CIN) · STATUS: QUESTIONABLE · sleeper as of 2026-09-04: no injury listed");
    expect(userPrompt).toContain("Josh Jacobs (GB) · STATUS: DAY TO DAY · sleeper as of 2026-09-04: NOT ACTIVE (Groin)");
    expect(userPrompt).toContain("no injury listed\" as of the feed's date means the tag is stale");
    expect(facts.draftPool?.find(p => p.name === "Ja'Marr Chase")?.feed).toEqual({ status: "no injury listed", source: "sleeper", asOf: "2026-09-04" });
    expect(facts.draftPool?.find(p => p.name === "Josh Jacobs")?.feed).toMatchObject({ status: "NA", bodyPart: "Groin", asOf: "2026-09-04" });
  });
});

describe("INTEL facts - cleared", () => {
  it("carries the disagreement into FACTS and PLAYER INTEL", () => {
    const data = leagueData({
      playerIntel: [{ espnId: "4426515", name: "Puka Nacua", cleared: { source: "sleeper", fetchedAt: NOW, espnStatus: "QUESTIONABLE" }, news: [] }],
    });
    const { userPrompt, facts } = new PromptBuilder(options(data)).build();
    expect(facts.intel?.[0]?.cleared).toEqual({ source: "sleeper", asOf: "2026-09-04", espnStatus: "QUESTIONABLE" });
    expect(userPrompt).toContain("Puka Nacua (WR, SF) on Halyard Bay: ESPN lists QUESTIONABLE; sleeper as of 2026-09-04 lists no injury");
  });
});

describe("verifier - pool players cited in the structured fields", () => {
  it("resolves a draft-pool id and accepts a predicted drafting team", () => {
    const pool: PoolPlayer[] = [
      { playerId: "4429795", playerName: "Jahmyr Gibbs", position: "RB", proTeam: "DET", adp: 1.3, adpPositionRank: 1, adpRank: 1, seasonOutlook: "", projectedStats: null, ownership: { averageDraftPosition: 1.3 } },
    ];
    const data = leagueData({
      draftType: "Snake",
      draftOrder: [{ position: 1, teamId: "1", teamName: "Halyard Bay", manager: "Hal" }],
      availablePlayers: pool as unknown as LeagueDataContext["availablePlayers"],
      playerIntel: [{ espnId: "3117251", name: "Christian McCaffrey", injury: { status: "Questionable", source: "sleeper", fetchedAt: NOW }, news: [] }],
    } as Partial<LeagueDataContext>);
    const facts = buildFactsBlock({ contentType: "mock_draft", leagueData: data });
    const halyard = facts.teams.find(team => team.name === "Halyard Bay")!.id;
    const piece = {
      ...article([["Round one", "Gibbs goes first."]]),
      featuredPlayers: [
        { playerId: "P4429795", playerName: "Jahmyr Gibbs", fantasyTeamId: halyard },
        { playerId: "P3117251", playerName: "Christian McCaffrey", fantasyTeamId: halyard },
      ],
    } as unknown as GeneratedArticleT;
    const violations = verifyArticle(piece, facts);
    expect(violations.filter(v => v.kind === "unknown_player" || v.kind === "wrong_fantasy_team")).toEqual([]);
    // A player nobody knows is still blocked.
    const ghost = { ...piece, featuredPlayers: [{ playerId: "P1", playerName: "Nobody Real", fantasyTeamId: halyard }] } as unknown as GeneratedArticleT;
    expect(verifyArticle(ghost, facts).some(v => v.kind === "unknown_player" && v.severity === "block")).toBe(true);
  });
});
