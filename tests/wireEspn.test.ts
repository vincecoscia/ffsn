import { describe, expect, it } from "vitest";
import injuriesFixture from "./fixtures/wire/espn-injuries-sample.json";
import newsFixture from "./fixtures/wire/espn-news-sample.json";
import { validateFactCard } from "../src/lib/ai/wire/card";
import {
  espnAthleteIdFromLinks,
  injuryEntryToCard,
  newsArticleToCard,
  parseEspnInjuriesPayload,
  parseEspnInjuryEntry,
  parseEspnNewsPayload,
  timetableAbout,
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

  it("builds a news card for stories about up to three players and skips listicles and untagged pieces", () => {
    const cards = articles.map(article => newsArticleToCard(article, { fetchedAt: FETCHED_AT }));
    const kept = cards.filter((card): card is NonNullable<typeof card> => card !== undefined);
    expect(kept.length).toBeGreaterThan(3);
    for (const card of kept) {
      validateFactCard(card);
      expect(card.kind).toBe("news");
      expect(card.players.length).toBeLessThanOrEqual(3);
      expect(card.headline ?? "").not.toBe("");
      expect(card.source.type).toBe("espn_news");
      expect(card.source.url).toMatch(/^https?:\/\//);
    }
    const listicle = articles.find(article => article.athletes.length > 3);
    if (listicle) expect(newsArticleToCard(listicle, { fetchedAt: FETCHED_AT })).toBeUndefined();
    const untagged = articles.find(article => article.athletes.length === 0)!;
    expect(newsArticleToCard(untagged, { fetchedAt: FETCHED_AT })).toBeUndefined();
  });
});
