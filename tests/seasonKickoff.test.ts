import { describe, expect, it } from "vitest";
import { emptyAlmanac, type AlmanacManager, type LeagueAlmanac } from "../src/lib/ai/almanac";
import { sampleAlmanac, SAMPLE_MANAGERS, SAMPLE_TEAMS } from "../src/lib/ai/__fixtures__/almanac-sample";
import { factsRequestFor, fixturesByName } from "../src/lib/ai/__fixtures__";
import {
  ALMANAC_FACTS_BUDGET,
  buildFactsBlock,
  computeMissingRequiredData,
  serializedLength,
  serializeFacts,
} from "../src/lib/ai/facts";
import type { FactsBlock } from "../src/lib/ai/facts";
import {
  countReceipts,
  findRecordsInKickoff,
  findRepeatedReceipts,
  verifyArticle,
} from "../src/lib/ai/fact-verifier";
import { PromptBuilder } from "../src/lib/ai/prompt-builder";
import type { LeagueDataContext } from "../src/lib/ai/prompt-builder";
import { contentTemplates } from "../src/lib/ai/content-templates";
import type { GeneratedArticleT } from "../src/lib/ai/content-generation-service";
import {
  buildInterviewFactBlock,
  buildKickoffInterviewRule,
  conversationService,
  type ConversationContext,
} from "../src/lib/ai/conversation-service";

/**
 * The Season Kickoff rebuild (owner, 2026-09-06): the prompt layer's half. A finished League
 * Almanac in (`src/lib/ai/almanac.ts` types; built by hand here, since the Convex side computes
 * the real one), and out come the ALMANAC facts, the Banner Night prompt, the kickoff interview
 * context, and the verifier's two new checks - a receipt used once, and no this-season record
 * before a snap is played.
 */

const SEASON = 2026;

/** A preseason payload: N teams from the shared sample roster, blank records, optional almanac. */
function preseason(teamCount: number, overrides: Partial<LeagueDataContext> & Record<string, unknown> = {}): LeagueDataContext {
  const teams = Array.from({ length: teamCount }, (_, i) => ({
    id: `team_${String(i + 1).padStart(2, "0")}`,
    externalId: String(i + 1),
    name: SAMPLE_TEAMS[i],
    manager: SAMPLE_MANAGERS[i],
    record: { wins: 0, losses: 0, ties: 0, pointsFor: 0, pointsAgainst: 0 },
    pointsFor: 0,
    pointsAgainst: 0,
    roster: [],
  }));
  return {
    leagueName: "Ironclad Fantasy Conference",
    currentWeek: 0,
    currentSeason: SEASON,
    scoringType: "PPR",
    totalTeams: teamCount,
    teams,
    standings: teams.map((team, index) => ({
      rank: index + 1,
      team: team.name,
      teamId: team.externalId,
      wins: 0,
      losses: 0,
      ties: 0,
      pointsFor: 0,
      pointsAgainst: 0,
    })),
    ...overrides,
  } as unknown as LeagueDataContext;
}

function kickoffFacts(leagueData: LeagueDataContext, contentType = "season_welcome"): FactsBlock {
  return buildFactsBlock({ contentType, leagueData });
}

function build(leagueData: LeagueDataContext, persona = "mel-diaper", contentType = "season_welcome") {
  return new PromptBuilder({ leagueId: "lg_kickoff", contentType, persona, leagueData }).build();
}

/** The user prompt after the FACTS block: the readable rendering the writer actually reads. */
function prose(userPrompt: string): string {
  return userPrompt.slice(userPrompt.indexOf("</FACTS>") + "</FACTS>".length);
}

function article(sections: Array<[string, string]>, extra: Partial<GeneratedArticleT> = {}): GeneratedArticleT {
  return {
    title: "Banner Night",
    summary: "The ledger, read aloud.",
    sections: sections.map(([name, content]) => ({ name, content, wordCount: content.split(/\s+/).length })),
    featuredTeams: [],
    featuredPlayers: [],
    quotes: [],
    managerMentions: [],
    claims: [],
    tone: "dramatic",
    ...extra,
  };
}

const kickoffFixture = fixturesByName["season-kickoff"];

/* -------------------------------------------------------------------------- */
/* A. FACTS                                                                    */
/* -------------------------------------------------------------------------- */

describe("ALMANAC facts", () => {
  it("carries a seven-season, ten-team almanac; over the budget it drops the per-season lines and says so", () => {
    const almanac = sampleAlmanac({ seasons: 7, teams: 10, currentSeason: SEASON });
    const facts = kickoffFacts(preseason(10, { almanac }));

    expect(facts.almanac).toBeDefined();
    const block = facts.almanac!;
    expect(block.seasonsCovered).toEqual([2019, 2020, 2021, 2022, 2023, 2024, 2025]);
    expect(block.seasons).toHaveLength(7);
    // Ten current managers plus the one who left after 2021.
    expect(block.managers).toHaveLength(11);
    expect(block.managers.filter((manager) => manager.currentTeamId === undefined).map((manager) => manager.manager)).toEqual(["Felix Marrow"]);
    expect(block.records.backToBack.length).toBeGreaterThan(0);
    expect(block.drafts.map((draft) => draft.season)).toEqual([2024, 2025]);

    // Compact shape (coordinator, 2026-09-06): ids, names and every cited figure, nothing derived.
    // Measured for this worst-case sample (every optional field filled): 62.6k verbatim; compact
    // 49.7k with lines and 31.5k without. The 24,000 budget is not reached even without lines, so
    // the ladder runs (lines dropped, with a note) and the size below is the measured ceiling,
    // pinned so growth is a deliberate change.
    const withLines = { ...block, managers: block.managers.map((manager) => ({ ...manager, lines: almanac.managers.find((raw) => raw.manager === manager.manager)?.lines })) };
    expect(serializedLength(withLines)).toBeGreaterThan(ALMANAC_FACTS_BUDGET);
    expect(block.managers.every((manager) => manager.lines === undefined)).toBe(true);
    expect(block.notes.at(-1)).toMatch(/^per-season lines are omitted here for size/);
    const size = serializedLength(block);
    expect(size).toBeGreaterThan(ALMANAC_FACTS_BUDGET);
    expect(size).toBeLessThan(34_000);
    expect(serializeFacts(facts).length).toBeLessThan(44_000);

    // The compact shape, field by field.
    const current = block.managers.find((manager) => manager.manager === "Dana Whitlock")!;
    expect(Object.keys(current).sort()).toEqual(
      ["bestSeason", "currentTeam", "currentTeamId", "lastPlaceFinishes", "manager", "playoffAppearances", "playoffStreak", "pointsFor", "pointsPerGame", "record", "regularSeasonTitles", "runnerUps", "seasons", "teamNames", "titles", "worstSeason", "yearsSinceTitle"]
    );
    expect(Object.keys(current.bestSeason!)).toEqual(["season", "team", "record", "pointsFor"]);
    const departed = block.managers.find((manager) => manager.manager === "Felix Marrow")!;
    expect(Object.keys(departed).sort()).toEqual(["manager", "record", "runnerUps", "seasons", "teamNames", "titles"]);
    const season = block.seasons[0];
    expect(Object.keys(season.champion!)).toEqual(["teamId", "team", "manager", "record", "pointsFor", "seed"]);
    expect(season.runnerUp?.seed).toBeUndefined();
    expect(Object.keys(season.final!)).toEqual(["winnerTeamId", "loserTeamId", "winnerScore", "loserScore", "margin", "week"]);
    expect(season.final?.winnerTeamId).toBe(season.champion?.teamId);
    const pick = block.drafts[0].firstRound[0];
    expect(Object.keys(pick)).toEqual(["pick", "teamId", "team", "manager", "player", "pos", "seasonPoints", "firstRoundRank", "finish"]);
    expect(pick.finish).toMatch(/^\d+-\d+$/);
    expect(typeof pick.seasonPoints).toBe("number");
    expect(typeof current.pointsFor).toBe("number");
  });

  it("keeps the per-season lines when the block fits its budget", () => {
    const manager: AlmanacManager = {
      key: "m0",
      manager: SAMPLE_MANAGERS[0],
      currentTeamId: "T1",
      currentTeam: SAMPLE_TEAMS[0],
      seasons: 1,
      firstSeason: 2025,
      lastSeason: 2025,
      wins: 9,
      losses: 5,
      ties: 0,
      record: "9-5",
      winPct: 0.643,
      pointsFor: 1612.3,
      pointsPerGame: 115.2,
      titles: [2025],
      runnerUps: [],
      regularSeasonTitles: [],
      playoffAppearances: 1,
      playoffStreak: 1,
      lastPlaceFinishes: [],
      yearsSinceTitle: 0,
      teamNames: [SAMPLE_TEAMS[0]],
      lines: [{ season: 2025, team: SAMPLE_TEAMS[0], record: "9-5", pointsFor: 1612.3, finish: 2, madePlayoffs: true, champion: true, runnerUp: false }],
    };
    const almanac: LeagueAlmanac = { ...emptyAlmanac(SEASON), seasonsCovered: [2025], managers: [manager], notes: [] };
    const facts = kickoffFacts(preseason(4, { almanac }));

    expect(serializedLength(facts.almanac)).toBeLessThan(ALMANAC_FACTS_BUDGET);
    expect(facts.almanac?.managers[0].lines).toHaveLength(1);
    expect(facts.almanac?.notes).toEqual([]);
    expect("key" in (facts.almanac?.managers[0] ?? {})).toBe(false);
    expect("winPct" in (facts.almanac?.managers[0] ?? {})).toBe(false);

    // The three-season, four-team fixture fits too, lines and all (20.1k of the 24k budget).
    const fixture = buildFactsBlock(factsRequestFor(kickoffFixture, "season_welcome")).almanac!;
    expect(serializedLength(fixture)).toBeLessThan(ALMANAC_FACTS_BUDGET);
    expect(fixture.managers.every((manager) => (manager.lines ?? []).length === 3)).toBe(true);
  });

  it("re-resolves currentTeamId through the team index and drops the internal keys", () => {
    const almanac = sampleAlmanac({ seasons: 3, teams: 4, currentSeason: SEASON });
    // One manager's id does not match any current team; one rivalry side is a departed manager.
    almanac.managers[1].currentTeamId = "T99";
    almanac.managers[1].currentTeam = undefined;
    const facts = kickoffFacts(preseason(4, { almanac }));

    const byName = new Map(facts.almanac!.managers.map((manager) => [manager.manager, manager]));
    expect(byName.get(SAMPLE_MANAGERS[0])?.currentTeamId).toBe("T1");
    expect(byName.get(almanac.managers[1].manager)?.currentTeamId).toBe("T99");
    for (const rivalry of facts.almanac!.rivalries) {
      expect(Object.keys(rivalry.a)).toEqual(["manager", "currentTeamId"]);
    }
    for (const season of facts.almanac!.seasons) {
      expect("managerKey" in (season.champion ?? {})).toBe(false);
    }
    expect(facts.almanac!.seasons[0].final?.margin).toBe(42.7);
  });

  it("season_welcome: no standings, every record preseason, no intel, and none of the in-season gap lines", () => {
    const almanac = sampleAlmanac({ seasons: 3, teams: 4, currentSeason: SEASON });
    const leagueData = preseason(4, {
      almanac,
      playerIntel: [],
      playerBoard: { basis: "upcoming_projection", throughWeek: 0, entries: [] },
    });
    const facts = kickoffFacts(leagueData);

    expect(facts.standings).toEqual([]);
    expect(facts.intel).toBeUndefined();
    expect(facts.almanac).toBeDefined();
    for (const team of facts.teams) {
      expect(team.record).toBe("preseason");
      expect(team.pointsFor).toBeUndefined();
      expect(team.rank).toBeUndefined();
    }
    expect(facts.missing.some((line) => line.startsWith("intel —"))).toBe(false);
    expect(facts.missing.some((line) => line.startsWith("no games played yet"))).toBe(false);
    expect(facts.missing.some((line) => line.startsWith("almanac —"))).toBe(false);

    // Every other type sees the ordinary preseason payload: the blank table and its 0-0-0 records.
    const recap = kickoffFacts(leagueData, "power_rankings");
    expect(recap.standings).toHaveLength(4);
    expect(recap.teams[0].record).toBe("0-0-0");
    expect(recap.almanac).toBeUndefined();
    expect(recap.missing.some((line) => line.startsWith("intel —"))).toBe(true);
    expect(recap.missing.some((line) => line.startsWith("no games played yet"))).toBe(true);
  });

  it("names the almanac gap for a league in its first season, and only then", () => {
    const first = "almanac — no completed seasons on record; this is the league's first season: write the kickoff from the teams, the managers and the draft, not from history";
    expect(computeMissingRequiredData("season_welcome", preseason(4))).toEqual([first]);
    expect(computeMissingRequiredData("season_welcome", preseason(4, { almanac: emptyAlmanac(SEASON) }))).toEqual([first]);
    expect(computeMissingRequiredData("season_welcome", preseason(4, { almanac: sampleAlmanac({ seasons: 1, teams: 4 }) }))).toEqual([]);
    // The key is the kickoff's alone.
    expect(computeMissingRequiredData("weekly_recap", preseason(4)).some((line) => line.startsWith("almanac"))).toBe(false);
  });

  it("template: Banner Night's five sections, in order, all required, under 2,300 words", () => {
    const template = contentTemplates.season_welcome;
    expect(template.name).toBe("Season Kickoff");
    expect(template.estimatedWords).toBe(2300);
    expect(template.creditCost).toBe(25);
    expect(template.requiredData).toEqual(["almanac"]);
    expect(template.optionalData).toEqual(["draft_receipts", "quotes"]);
    expect(template.sections.map((section) => [section.name, section.required, section.wordCount])).toEqual([
      ["banner_night", true, 450],
      ["curse_board", true, 350],
      ["ten_verdicts", true, 1100],
      ["carryover_grudge", true, 250],
      ["the_number", true, 150],
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* D. Verifier                                                                 */
/* -------------------------------------------------------------------------- */

describe("verifier on a kickoff piece", () => {
  const facts = buildFactsBlock(factsRequestFor(kickoffFixture, "season_welcome"));
  const template = contentTemplates.season_welcome;

  it("knows every almanac name and every almanac number", () => {
    const piece = article([
      ["banner_night", "Whitlock's Wreckers won it in 2024 and Gravel Pit Gravy fell to 6-8 in 2025. Bo Larkin went first overall to Dana Whitlock both years."],
      ["curse_board", "Priya Nandi has 5023.1 PF and no ring; Trevor Ashby took the 2025 final by 40.1."],
      ["ten_verdicts", "Cedar Falls Cormorants finished 2023 with 1,703.3 PF as the top scorer."],
      ["carryover_grudge", "The 2023 final went to the Gravel Pit Grinders by 42.7, 139.4-96.7 over Marcus Bly's side."],
      ["the_number", "Ninth Street Nightjars win 10 games. Book it."],
    ]);
    const violations = verifyArticle(piece, facts, { template });
    expect(violations.filter((violation) => violation.kind === "unknown_player")).toEqual([]);
    expect(violations.filter((violation) => violation.kind === "unverified_number")).toEqual([]);
    expect(violations.filter((violation) => violation.kind === "records_before_kickoff")).toEqual([]);
    expect(violations.filter((violation) => violation.kind === "repeated_receipt")).toEqual([]);
  });

  it("still flags a name and a decimal the almanac does not carry", () => {
    const piece = article([
      ["banner_night", "Ghost Manager took a title nobody recorded, by 9999.9."],
    ]);
    const violations = verifyArticle(piece, facts, { template });
    expect(violations.map((violation) => `${violation.kind}/${violation.detail}`)).toEqual(
      expect.arrayContaining(["unknown_player/Ghost Manager", "unverified_number/9999.9"])
    );
  });

  it("reads a thousands separator as part of the number", () => {
    const piece = article([["banner_night", "Dana Whitlock has 5,128.3 PF all-time; the imaginary 1,999.9 is not on any ledger."]]);
    const numbers = verifyArticle(piece, facts, { template }).filter((violation) => violation.kind === "unverified_number");
    expect(numbers.map((violation) => violation.detail)).toEqual(["1,999.9"]);
  });

  it("repeated_receipt: a number in more than two sections blocks the third on; a pile-up in one warns; years never count", () => {
    const sections: Array<[string, string]> = [
      ["banner_night", "The 2023 final was decided by 42.7 points, and 2025 was the year of the Nightjars."],
      ["curse_board", "That 42.7 still stings in 2025."],
      ["ten_verdicts", "Everyone remembers 42.7 and the 1,775.0 PF that came with it."],
      ["carryover_grudge", "Again: 42.7. And again: 42.7. Then 42.7 once more, and 42.7 to close, 2025 style."],
      ["the_number", "The number is 42.7 and the total is 1775.0."],
    ];
    const violations = findRepeatedReceipts(sections.map(([name, content]) => ({ name, content })), new Set(["2026"]));
    // The grudge section leans on 42.7 four times, so it is the receipt's home; every other
    // section is rewritten without it (home-section rule, 2026-09-06).
    const blocks = violations.filter((violation) => violation.severity === "block");
    expect(blocks.map((violation) => violation.section)).toEqual(["banner_night", "curse_board", "ten_verdicts", "the_number"]);
    expect(blocks[0]).toMatchObject({
      kind: "repeated_receipt",
      detail: '42.7 is cited in 5 sections; it belongs in "carryover_grudge" - drop it here and keep this section\'s own receipts',
    });
    const warns = violations.filter((violation) => violation.severity === "warn");
    expect(warns).toEqual([
      { kind: "repeated_receipt", detail: "42.7 is cited 4 times in one section; a receipt is used once", section: "carryover_grudge", severity: "warn" },
    ]);
    // "1,775.0" and "1775.0" are one token, in two sections: fine.
    expect(violations.some((violation) => violation.detail.startsWith("1775"))).toBe(false);
    // 2023 / 2025 appear everywhere and are years, not receipts.
    expect(violations.some((violation) => violation.detail.startsWith("20"))).toBe(false);

    // Through verifyArticle, on any content type, with the season excluded by name.
    const weekly = buildFactsBlock(factsRequestFor(fixturesByName["rich-week"], "weekly_recap"));
    const repeated = verifyArticle(article(sections), weekly).filter((violation) => violation.kind === "repeated_receipt");
    expect(repeated.filter((violation) => violation.severity === "block")).toHaveLength(4);
  });

  it("countReceipts: three-digit integers, thousands, decimals; never a record, a week, a year or the season", () => {
    const counts = countReceipts("Went 12-2 in week 14 of 2025 with 1,612.3 PF, 139 to 96.7 in the final, 1492 words, $100 left.", new Set(["2026"]));
    expect([...counts.entries()]).toEqual([
      ["1612.3", 1],
      ["139", 1],
      ["96.7", 1],
      ["1492", 1],
      ["100", 1],
    ]);
  });

  it("records_before_kickoff: a this-season record beside a team is caught, a past one that names its season or says all-time is not", () => {
    const names = facts.teams.map((team) => team.name);
    expect(findRecordsInKickoff("Gravel Pit Grinders are 25-17 all-time.", names)).toEqual([]);
    expect(findRecordsInKickoff("Gravel Pit Grinders went 11-3 in 2023 and never looked back.", names)).toEqual([]);
    expect(findRecordsInKickoff("Across three seasons the Quarry Road Quakers are 20-22.", names)).toEqual([]);
    expect(findRecordsInKickoff("Gravel Pit Grinders are sitting at 0-0-0 heading into week 1.", names)).toEqual([
      { phrase: "0-0-0", sentence: "Gravel Pit Grinders are sitting at 0-0-0 heading into week 1." },
    ]);

    const piece = article([
      ["banner_night", "Gravel Pit Grinders are 25-17 all-time. Gravel Pit Grinders are sitting at 0-0-0 with zero points for."],
    ]);
    const hits = verifyArticle(piece, facts, { template }).filter((violation) => violation.kind === "records_before_kickoff");
    expect(hits.map((violation) => [violation.severity, violation.section])).toEqual([
      ["warn", "banner_night"],
      ["warn", "banner_night"],
    ]);
    expect(hits[0].detail).toContain('"0-0-0" beside a team in a kickoff piece');
    expect(hits[1].detail).toContain('"points for"');

    // A weekly recap says 0-0-0 beside a team without comment from this check.
    const weekly = buildFactsBlock(factsRequestFor(fixturesByName["rich-week"], "weekly_recap"));
    expect(verifyArticle(article([["introduction", "Gravel Pit Grinders are sitting at 0-0-0."]]), weekly).filter((violation) => violation.kind === "records_before_kickoff")).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* C. Prompt                                                                   */
/* -------------------------------------------------------------------------- */

describe("Banner Night prompt", () => {
  it("renders the ledger, the all-time lines, the curse board, the record book, the rivalries, the draft receipts, this season and the rules", () => {
    const built = build(kickoffFixture.leagueData);
    const text = prose(built.userPrompt);

    expect(text).toContain("BANNER NIGHT — THE 2026 SEASON KICKOFF, Ironclad Fantasy Conference");
    expect(text).toContain("LEAGUE LEDGER — 3 completed seasons, founded 2023:");
    expect(text).toContain("- 2023: Gravel Pit Grinders (Dana Whitlock, 11-3, 1775.0 PF) took the title, beating Cedar Falls Cormorants (Marcus Bly, 8-6) by 42.7 in the week 17 final, 139.4-96.7. Also the regular-season champ.");
    expect(text).toContain("ALL-TIME BY MANAGER (current managers first");
    expect(text).toContain("- Dana Whitlock, Gravel Pit Grinders (T1): 25-17 all-time (.595) over 3 seasons, 5128.3 PF, 122.1 a game; 2 titles (2023 and 2024)");
    expect(text).toContain("3 team names (Gravel Pit Grinders, Whitlock's Wreckers, Gravel Pit Gravy)");
    expect(text).toContain("Season by season: 2023 11-3 as Gravel Pit Grinders (1st, champion)");
    expect(text).toContain("the defending champion");
    expect(text).toContain("THE CURSE BOARD:");
    expect(text).toContain("- Most career points without a title: Priya Nandi, Quarry Road Quakers — 5023.1 PF over 3 seasons");
    expect(text).toContain("RECORD BOOK:");
    expect(text).toContain("- Back-to-back: Dana Whitlock (2023 and 2024).");
    expect(text).toContain("RIVALRIES (all-time, current managers):");
    expect(text).toContain("DRAFT RECEIPTS — 2025 first round");
    expect(text).toContain("- Pick 1: Bo Larkin (RB) to Gravel Pit Gravy (Dana Whitlock) — 330.3 points, 1st of the round; team finished 6-8, missed the playoffs.");
    expect(text).toContain("NOTES (respect every one):");
    expect(text).toContain("THIS SEASON'S TEAMS (2026; 4 teams, in this order for the verdicts):");
    expect(text).toContain("1. Gravel Pit Grinders (T1) — Dana Whitlock: 25-17 all-time, 2 titles (2023 and 2024), 2 playoff trips in 3 seasons, 1 season since the last one.");
    expect(text).toContain("2. Cedar Falls Cormorants (T2) — Marcus Bly: 17-25 all-time, no title, 1 playoff trip in 3 seasons.");
    expect(text).toContain("The draft was held on Sat, Aug 29.");
    expect(text).toContain("Week 1 kicks off Thu, Sep 10, 8:20 PM EDT.");
    expect(text).toContain("SEASON KICKOFF RULES:");
    expect(text).toContain("Last season's final margin belongs to carryover_grudge alone.");
    expect(text).toContain("phrased as written — 4 teams, 4 claims.");
    expect(text).toContain("this is Banner Night, the loudest night of the year");

    // Nothing from the in-season builders, and no this-season record anywhere in the prose.
    expect(text).not.toContain("PLAYER INTEL (fresh feeds");
    expect(text).not.toContain("IN-GAME INJURIES (");
    expect(text).not.toContain("RECENT CHAMPIONS:");
    expect(text).not.toContain("STANDINGS");
    expect(text).not.toContain("0-0-0");
    expect(built.systemPrompt).not.toContain("LOOK-AHEAD");
    expect(built.systemPrompt).not.toContain("no games played yet");
    expect(built.systemPrompt).not.toContain("intel — no fresh injury");
    expect(built.systemPrompt).toContain("TEMPLATE — Season Kickoff");
    expect(built.systemPrompt).toContain("- banner_night (");
    expect(built.systemPrompt).toContain("- the_number (");
    expect(built.userPrompt.startsWith("<FACTS>")).toBe(true);
    expect(built.facts.almanac).toBeDefined();
  });

  it("prints every number the way FACTS prints it, so the sweep and the receipts agree", () => {
    const built = build(kickoffFixture.leagueData);
    // Points per game is printed for the writer but deliberately not carried in FACTS (compact
    // almanac); a writer who cites it draws an unverified_number warn, nothing more.
    const text = prose(built.userPrompt).replace(/\d+\.\d a game/g, "");
    expect(prose(built.userPrompt)).toContain("122.1 a game");
    const known = new Set<string>();
    const walk = (value: unknown) => {
      if (typeof value === "number") {
        known.add(String(value));
        known.add(value.toFixed(1));
      } else if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === "object") Object.values(value).forEach(walk);
    };
    walk(built.facts);
    for (const decimal of text.match(/(?<![\w.,])\d+(?:,\d{3})*\.\d(?!\d)/g) ?? []) {
      expect(known.has(decimal.replace(/,/g, "")), decimal).toBe(true);
    }
    expect(text).not.toMatch(/\d,\d{3}\.\d/);
  });

  it("counts down to a draft that has not been held, and names the departed under NO LONGER IN THE LEAGUE", () => {
    const almanac = sampleAlmanac({ seasons: 7, teams: 10, currentSeason: SEASON });
    const nineDays = Date.now() + 9 * 86_400_000 - 60_000;
    const text = prose(build(preseason(10, { almanac, seasonKickoff: { draftDone: false, draftDate: nineDays } })).userPrompt);
    expect(text).toMatch(/The draft is 9 days away \(/);
    expect(text).not.toContain("Week 1 kicks off");
    expect(text).toContain("NO LONGER IN THE LEAGUE:");
    expect(text).toMatch(/- Felix Marrow \(2019-2021\): /);
    expect(text).toContain("phrased as written — 10 teams, 10 claims.");

    const undated = prose(build(preseason(10, { almanac, seasonKickoff: { draftDone: false } })).userPrompt);
    expect(undated).toContain("The draft has not been held yet.");
    expect(prose(build(preseason(10, { almanac })).userPrompt)).not.toContain("draft has");
  });

  it("writes a first season from the teams, the managers and the draft", () => {
    const built = build(preseason(4, { almanac: emptyAlmanac(SEASON) }));
    const text = prose(built.userPrompt);
    expect(text).toContain("this is the league's first season");
    expect(text).not.toContain("LEAGUE LEDGER");
    expect(text).not.toContain("THE CURSE BOARD:");
    expect(text).not.toContain("RECORD BOOK:");
    expect(text).toContain("1. Gravel Pit Grinders (T1) — Dana Whitlock: first season in the league, no ledger line yet.");
    expect(text).toContain("SEASON KICKOFF RULES:");
    expect(built.systemPrompt).toContain("MISSING DATA");
    expect(built.systemPrompt).toContain("almanac — no completed seasons on record");
  });

  it("falls back to the pre-almanac body only when the payload carries no almanac", () => {
    const legacy = preseason(4, {
      leagueHistory: {
        foundedYear: 2023,
        totalSeasons: 3,
        seasons: [{ year: 2025, champion: { teamId: "4", teamName: "Ninth Street Nightjars", owner: "Trevor Ashby" } }],
      },
    });
    const text = prose(build(legacy).userPrompt);
    expect(text).toContain("WELCOME TO THE 2026 SEASON!");
    expect(text).toContain("RECENT CHAMPIONS:");
    expect(text).not.toContain("BANNER NIGHT —");
  });

  it("builds for every writer on the kickoff fixture, FACTS first", () => {
    for (const persona of ["mel-diaper", "curtis-vaughn", "reggie-banks", "nina-sharpe"]) {
      const built = build(kickoffFixture.leagueData, persona);
      expect(built.userPrompt.startsWith("<FACTS>"), persona).toBe(true);
      expect(built.systemPrompt.indexOf("GROUNDING CONTRACT"), persona).toBe(0);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* E. Interviews                                                               */
/* -------------------------------------------------------------------------- */

describe("kickoff interview", () => {
  function context(overrides: Partial<ConversationContext> = {}): ConversationContext {
    return {
      userId: "user_dana",
      leagueId: "lg_kickoff",
      scheduledContentId: undefined,
      contentType: "season_welcome",
      week: 0,
      seasonId: SEASON,
      leagueName: "Ironclad Fantasy Conference",
      managerName: "Dana Whitlock",
      teamName: "Gravel Pit Grinders",
      interviewerPersona: "sam-ortega",
      writerPersona: "mel-diaper",
      almanacLine: "25-17 all-time over three seasons, two titles (2023 and 2024), best 11-3 in 2023 as Gravel Pit Grinders",
      kickoff: {
        lastChampion: "Ninth Street Nightjars",
        lastChampionManager: "Trevor Ashby",
        draftDone: true,
        draftDate: Date.UTC(2026, 7, 29, 23, 0),
        daysToKickoff: 12,
      },
      teamPerformance: { teamId: "T1", teamName: "Gravel Pit Grinders", score: 0, won: false, underperformers: [], overperformers: [] },
      leagueContext: {
        standings: [
          { teamId: "T1", teamName: "Gravel Pit Grinders", rank: 1, record: "0-0" },
          { teamId: "T4", teamName: "Ninth Street Nightjars", rank: 2, record: "0-0" },
        ],
      },
      conversationHistory: [],
      ...overrides,
    };
  }

  it("CONTEXT carries the all-time line and the preseason facts, and no standing or result", () => {
    const block = buildInterviewFactBlock(context());
    expect(block).toContain("Story: season welcome - 2026 season, Ironclad Fantasy Conference");
    expect(block).toContain("ALL-TIME LINE: 25-17 all-time over three seasons, two titles (2023 and 2024), best 11-3 in 2023 as Gravel Pit Grinders");
    expect(block).toContain("Defending champion: Ninth Street Nightjars (Trevor Ashby)");
    expect(block).toContain("Draft: held on Sat, Aug 29");
    expect(block).toContain("Week 1: in 12 days (nothing played yet)");
    expect(block).not.toContain("Standing:");
    expect(block).not.toContain("result:");
    expect(block).not.toContain("Week 0");

    const pending = buildInterviewFactBlock(context({ kickoff: { draftDone: false, draftDate: Date.UTC(2026, 7, 29, 23, 0) } }));
    expect(pending).toContain("Draft: Sat, Aug 29 (not held yet)");
    expect(buildInterviewFactBlock(context({ kickoff: { draftDone: false } }))).toContain("Draft: not held yet");
    expect(buildInterviewFactBlock(context({ almanacLine: undefined, kickoff: undefined }))).not.toContain("ALL-TIME LINE");
  });

  it("the opener leads with the all-time line, then the defending champion; the rule names the two things to get", () => {
    const service = conversationService as unknown as { buildUserPrompt(context: ConversationContext, isInitial: boolean): string };
    const opener = service.buildUserPrompt(context(), true);
    expect(opener).toContain("Lead with their all-time line (25-17 all-time over three seasons");
    expect(opener).toContain("SEASON KICKOFF RULE");
    expect(opener).toContain("one bold prediction with a number in it");
    expect(opener).toContain("the team to beat - or the rival they most want to beat");

    const noLine = service.buildUserPrompt(context({ almanacLine: undefined }), true);
    expect(noLine).toContain("Lead with Ninth Street Nightjars (Trevor Ashby) going in as the defending champion");

    expect(buildKickoffInterviewRule(context())).toContain("there is no matchup, no result and no record this week");
    expect(buildKickoffInterviewRule(context({ contentType: "weekly_recap" }))).toBeNull();
    expect(service.buildUserPrompt(context({ contentType: "weekly_recap" }), true)).not.toContain("SEASON KICKOFF RULE");
  });
});

/* -------------------------------------------------------------------------- */
/* G. Eval fixture                                                             */
/* -------------------------------------------------------------------------- */

describe("season-kickoff fixture", () => {
  it("carries the almanac into FACTS for the kickoff and an empty table, and nothing of it for any other type", () => {
    const kickoff = buildFactsBlock(factsRequestFor(kickoffFixture, "season_welcome"));
    expect(kickoff.almanac).toBeDefined();
    expect(kickoff.almanac?.seasonsCovered).toEqual([2023, 2024, 2025]);
    expect(kickoff.almanac?.managers.map((manager) => manager.currentTeamId).sort()).toEqual(["T1", "T2", "T3", "T4"]);
    expect(kickoff.standings).toEqual([]);
    expect(kickoff.teams.map((team) => team.record)).toEqual(["preseason", "preseason", "preseason", "preseason"]);
    expect(kickoff.missing).toEqual([]);

    const recap = buildFactsBlock(factsRequestFor(kickoffFixture, "weekly_recap"));
    expect(recap.almanac).toBeUndefined();
    expect(recap.standings).toHaveLength(4);
    expect(recap.teams[0].record).toBe("0-0-0");
  });
});
