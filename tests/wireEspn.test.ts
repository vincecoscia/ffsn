import { describe, expect, it } from "vitest";
import injuriesFixture from "./fixtures/wire/espn-injuries-sample.json";
import newsFixture from "./fixtures/wire/espn-news-sample.json";
import { validateFactCard } from "../src/lib/ai/wire/card";
import {
  espnAthleteIdFromLinks,
  injuryEntryToCard,
  newsArticleToCard,
  newsRelevance,
  parseEspnInjuriesPayload,
  parseEspnInjuryEntry,
  parseEspnNewsArticle,
  parseEspnNewsPayload,
  timetableAbout,
  type EspnNewsArticle,
} from "../src/lib/ai/wire/espn";
import { MAX_NOTE_CHARS } from "../src/lib/ai/wire/types";

const FETCHED_AT = 1_800_000_000_000;

describe("espnAthleteIdFromLinks", () => {
  it("reads the id out of the player-card href", () => {
    expect(espnAthleteIdFromLinks([{ href: "https://www.espn.com/nfl/player/_/id/2578570/jacoby-brissett" }])).toBe("2578570");
    expect(espnAthleteIdFromLinks([{ href: "sportscenter://x-callback-url/showClubhouse?uid=s:20~l:28~a:2578570" }, { href: "https://www.espn.com/nfl/player/stats/_/id/2578570/jacoby-brissett" }])).toBe("2578570");
    expect(espnAthleteIdFromLinks([])).toBeUndefined();
    expect(espnAthleteIdFromLinks(undefined)).toBeUndefined();
  });
});

describe("injuries fixture", () => {
  const entries = parseEspnInjuriesPayload(injuriesFixture);

  it("parses two teams' worth of entries, each with an athlete id from links[].href", () => {
    expect(entries.length).toBeGreaterThanOrEqual(40);
    expect(entries.length).toBeLessThanOrEqual(50);
    expect(new Set(entries.map(({ teamName }) => teamName)).size).toBe(2);
    for (const { entry } of entries) {
      expect(entry.athlete.espnId).toMatch(/^\d+$/);
      expect(entry.athlete.name.length).toBeGreaterThan(0);
      expect(entry.status.length).toBeGreaterThan(0);
    }
  });

  it("treats a first sighting of a non-Active entry as a status change from Active, and an Active one as a note", () => {
    const ir = entries.find(({ entry }) => entry.status === "Injured Reserve")!;
    const card = injuryEntryToCard(ir.entry, { fetchedAt: FETCHED_AT });
    expect(card.kind).toBe("injury_status");
    expect(card.statusFrom).toBe("Active");
    expect(card.statusTo).toBe("Injured Reserve");
    expect(card.players[0]).toMatchObject({ espnId: ir.entry.athlete.espnId, name: ir.entry.athlete.name });
    expect(card.source).toEqual({ type: "espn_injuries", id: ir.entry.id, fetchedAt: FETCHED_AT });
    expect(card.observedAt).toBe(Date.parse(ir.entry.date!));

    const active = entries.find(({ entry }) => entry.status === "Active")!;
    const note = injuryEntryToCard(active.entry, { fetchedAt: FETCHED_AT });
    expect(note.kind).toBe("injury_note");
    expect(note.statusFrom).toBeUndefined();
    expect(note.statusTo).toBe("Active");
  });

  it("uses the poller's last-seen status when it has one", () => {
    const q = entries.find(({ entry }) => entry.status === "Questionable")!;
    expect(injuryEntryToCard(q.entry, { fetchedAt: FETCHED_AT, statusFrom: "Questionable" }).kind).toBe("injury_note");
    expect(injuryEntryToCard(q.entry, { fetchedAt: FETCHED_AT, statusFrom: "Out" })).toMatchObject({ kind: "injury_status", statusFrom: "Out", statusTo: "Questionable" });
  });

  it("produces cards that validate, with notes trimmed to the limit", () => {
    for (const { entry } of entries) {
      const card = validateFactCard(injuryEntryToCard(entry, { fetchedAt: FETCHED_AT }));
      expect((card.note ?? "").length).toBeLessThanOrEqual(MAX_NOTE_CHARS);
    }
  });

  it("only lifts a timetable from a sentence that names the player", () => {
    const byName = (name: string) => entries.find(({ entry }) => entry.athlete.name === name)!.entry;
    // Chandler's long comment: "Chandler suffered a season-ending knee injury…" — about him.
    expect(injuryEntryToCard(byName("Ty Chandler"), { fetchedAt: FETCHED_AT }).timetable).toBe("season-ending");
    // Wright's: "The cornerback suffered a hip injury … season-ending surgery." — never names him.
    expect(injuryEntryToCard(byName("Rejzohn Wright"), { fetchedAt: FETCHED_AT }).timetable).toBeUndefined();
    // Stroud's long comment says a teammate is out for the season.
    expect(injuryEntryToCard(byName("C.J. Stroud"), { fetchedAt: FETCHED_AT }).timetable).toBeUndefined();
  });

  it("rejects an entry without an id, status or athlete id", () => {
    expect(parseEspnInjuryEntry({ status: "Out", athlete: { displayName: "X", links: [] } })).toBeUndefined();
    expect(parseEspnInjuryEntry({ id: "1", athlete: { displayName: "X", links: [{ href: "https://www.espn.com/nfl/player/_/id/9/x" }] } })).toBeUndefined();
    expect(parseEspnInjuryEntry({ id: "1", status: "Out", athlete: { displayName: "X", links: [] } })).toBeUndefined();
    expect(parseEspnInjuryEntry(null)).toBeUndefined();
  });
});

describe("timetableAbout", () => {
  it("reads sentence by sentence and matches on the last name", () => {
    const text = "The Texans traded for Boutte after Jayden Higgins tore his ACL, knocking him out for the season. Stroud is looking to bounce back and could miss 2 weeks.";
    expect(timetableAbout(text, ["C.J. Stroud"])).toBe("2 weeks");
    expect(timetableAbout(text, ["Jayden Higgins"])).toBe("out for the season");
    expect(timetableAbout(text, ["Nico Collins"])).toBeUndefined();
    expect(timetableAbout("Etienne Jr. is week-to-week.", ["Travis Etienne Jr."])).toBe("week-to-week");
    expect(timetableAbout("C.J. Stroud is day-to-day. Tank Dell is out for the season.", ["C.J. Stroud"])).toBe("day-to-day");
    expect(timetableAbout("C.J. Stroud is day-to-day. Tank Dell is out for the season.", ["Tank Dell"])).toBe("out for the season");
    expect(timetableAbout(undefined, ["X"])).toBeUndefined();
  });
});

describe("news fixture", () => {
  const articles = parseEspnNewsPayload(newsFixture);

  it("parses every article with its tagged athletes", () => {
    expect(articles.length).toBe(20);
    const tagged = articles.filter(article => article.athletes.length > 0);
    expect(tagged.length).toBeGreaterThan(5);
    for (const article of tagged) for (const athlete of article.athletes) expect(athlete.espnId).toMatch(/^\d+$/);
  });

  it("builds a news card for relevant, up-to-three-player stories and skips listicles, untagged and irrelevant pieces", () => {
    const cards = articles.map(article => newsArticleToCard(article, { fetchedAt: FETCHED_AT }));
    const kept = cards.filter((card): card is NonNullable<typeof card> => card !== undefined);
    // Most of this fixture is exactly the kind of tagged-but-not-newsworthy feature copy the
    // relevance gate exists for (spec update 2026-09-06) - only the two HeadlineNews items survive.
    expect(kept.length).toBeGreaterThanOrEqual(2);
    for (const card of kept) {
      validateFactCard(card);
      expect(card.kind).toBe("news");
      expect(card.players.length).toBeLessThanOrEqual(3);
      expect(card.headline ?? "").not.toBe("");
      expect(card.source.type).toBe("espn_news");
      expect(card.source.url).toMatch(/^https?:\/\//);
    }
    // Athlete count alone is no longer the relevance bar (spec update 2026-09-06) - this 5-athlete
    // rankings-style piece stays out because it isn't RELEVANT, not because of its athlete count.
    const broadlyTagged = articles.find(article => article.athletes.length > 3);
    if (broadlyTagged) expect(newsArticleToCard(broadlyTagged, { fetchedAt: FETCHED_AT })).toBeUndefined();
    const untagged = articles.find(article => article.athletes.length === 0)!;
    expect(newsArticleToCard(untagged, { fetchedAt: FETCHED_AT })).toBeUndefined();
  });

  it("preserves the article's type (HeadlineNews vs. Story) through parsing", () => {
    const headlineNews = articles.find(article => article.type === "HeadlineNews");
    expect(headlineNews).toBeDefined();
    expect(articles.some(article => article.type === "Story")).toBe(true);
    expect(parseEspnNewsArticle({ id: 1, headline: "X" })?.type).toBeUndefined();
  });
});

describe("newsRelevance (spec update 2026-09-06: athlete count is the wrong relevance proxy)", () => {
  const byHeadline = (headline: string): EspnNewsArticle =>
    parseEspnNewsPayload(newsFixture).find(article => article.headline === headline)!;

  const henderson: EspnNewsArticle = {
    id: "dev-henderson",
    type: "Story",
    headline: "What will Patriots do if RB TreVeyon Henderson is out Week 1?",
    description: "New England may lean on a committee if Henderson can't go, with three other backs in the mix.",
    athletes: [
      { espnId: "1", name: "Rhamondre Stevenson" },
      { espnId: "2", name: "Antonio Gibson" },
      { espnId: "3", name: "TreVeyon Henderson" },
      { espnId: "4", name: "Terrell Jennings" },
    ],
  };

  const smithDeal: EspnNewsArticle = {
    id: "dev-smith",
    type: "Story",
    headline: "Vikings safety Smith agrees to deal, back for 15th season",
    description: "The two sides finalized a new one-year contract that keeps Smith with Minnesota.",
    athletes: [{ espnId: "5", name: "Harrison Smith" }],
  };

  const fieldBlessing: EspnNewsArticle = {
    id: "dev-blessing",
    type: "Story",
    headline: "The story behind Steelers' viral field blessing: 'God doesn't pick sides'",
    description: "Before every home game, a local pastor blesses the Acrisure Stadium turf, a ritual players on both sidelines have come to expect.",
    athletes: [{ espnId: "6", name: "Aaron Rodgers" }],
  };

  it("treats a question about a player's status as relevant, even tagged to four athletes", () => {
    expect(newsRelevance(henderson)).toEqual({ relevant: true, signal: "status" });
  });

  it("treats ESPN's own HeadlineNews wire items as relevant on their own", () => {
    const jacobs = byHeadline("Josh Jacobs' court appearance moved up to Sept. 10");
    expect(jacobs.type).toBe("HeadlineNews");
    expect(newsRelevance(jacobs)).toEqual({ relevant: true, signal: "headline_news" });
  });

  it("treats a transaction headline as relevant", () => {
    expect(newsRelevance(smithDeal)).toEqual({ relevant: true, signal: "transaction" });
  });

  it("treats a personality/feature story with no injury, role or transaction signal as not relevant", () => {
    for (const article of [
      fieldBlessing,
      byHeadline("Will Kyler Murray end the Vikings' tragicomic QB history?"),
      byHeadline("Chase Brown won't be overlooked in Bengals' offense"),
      byHeadline("Does OBJ still got it? Fans and teammates seem to think so"),
      byHeadline("Panthers' Tetairoa McMillan says he's stronger, but is he more versatile, too?"),
    ]) {
      expect(newsRelevance(article), article.headline).toEqual({ relevant: false });
      expect(newsArticleToCard(article, { fetchedAt: FETCHED_AT })).toBeUndefined();
    }
  });

  it("never reads a word inside a longer word as a signal (outlooks, is not 'out')", () => {
    expect(newsRelevance({ id: "x", type: "Story", headline: "Prop bets, outlooks and projections for 2026", athletes: [] })).toEqual({
      relevant: false,
    });
  });

  it("builds a card for the 4-athlete Henderson story, capped at 3 players with Henderson first", () => {
    const card = newsArticleToCard(henderson, { fetchedAt: FETCHED_AT });
    expect(card).toBeDefined();
    expect(card!.players).toHaveLength(3);
    expect(card!.players[0].name).toBe("TreVeyon Henderson");
    expect(card!.players.map(p => p.name)).not.toContain("Terrell Jennings");
  });
});

describe("newsRelevance: signal words only in their roster sense, never the idiom", () => {
  const story = (headline: string, description?: string) => ({ id: "x", type: "Story", headline, description, athletes: [] });

  it("ignores 'out', 'starting' and 'cut' used as idioms", () => {
    for (const article of [
      story("Rookie WR stands out in camp", "He figured out the playbook and came out of the gate fast."),
      story("Bengals offense is starting to click", "The unit is starting to look like last year's."),
      story("Chiefs cut it close in preseason finale", "Kansas City cut back on reps for the veterans."),
    ]) {
      expect(newsRelevance(article), article.headline).toEqual({ relevant: false });
    }
  });

  it("still reads the same words as a status, a role or a transaction", () => {
    expect(newsRelevance(story("Henderson is out Week 1, coach confirms"))).toEqual({ relevant: true, signal: "status" });
    expect(newsRelevance(story("Rookie RB out for the season after knee surgery"))).toEqual({ relevant: true, signal: "status" });
    expect(newsRelevance(story("Rodriguez named the starter in Jacksonville"))).toEqual({ relevant: true, signal: "role" });
    expect(newsRelevance(story("Douglas takes the starting job at WR"))).toEqual({ relevant: true, signal: "role" });
    expect(newsRelevance(story("Veteran RB was cut by the Jaguars on Tuesday"))).toEqual({ relevant: true, signal: "transaction" });
    expect(newsRelevance(story("Jaguars cut RB after one season"))).toEqual({ relevant: true, signal: "transaction" });
  });
});
