import { describe, expect, it } from "vitest";
import {
  cardNames,
  cardNumbers,
  extractNumbers,
  formatCount,
  renderCard,
  stripReporterAttribution,
  validateFactCard,
} from "../src/lib/ai/wire/card";
import { MAX_POST_CHARS, type WireFactCard } from "../src/lib/ai/wire/types";

const burrow: WireFactCard = {
  kind: "injury_status",
  observedAt: 1_800_000_000_000,
  players: [{ espnId: "3915511", name: "Joe Burrow", position: "QB", nflTeam: "CIN", percentOwned: 99.4, adpPositionRank: 3 }],
  nflTeam: "CIN",
  statusFrom: "Questionable",
  statusTo: "Out",
  note: "Burrow (toe) will miss 6–8 weeks after surgery, Adam Schefter of ESPN reports.",
  timetable: "6–8 weeks",
  source: { type: "espn_injuries", id: "636276", fetchedAt: 1_800_000_000_000 },
};

describe("validateFactCard", () => {
  it("accepts a well-formed card and drops unknown keys", () => {
    const parsed = validateFactCard({ ...burrow, extra: "ignored" });
    expect(parsed).toEqual(burrow);
    expect("extra" in parsed).toBe(false);
  });

  it("throws a readable message naming the bad field", () => {
    expect(() => validateFactCard({ ...burrow, players: [] })).toThrow(/players: a card needs at least one player/);
    expect(() => validateFactCard({ ...burrow, kind: "trade" })).toThrow(/kind/);
    expect(() => validateFactCard({ ...burrow, note: "x".repeat(401) })).toThrow(/note must be at most 400/);
    expect(() => validateFactCard({ ...burrow, source: { type: "twitter", fetchedAt: 1 } })).toThrow(/source\.type/);
    expect(() => validateFactCard(null)).toThrow(/Invalid wire fact card/);
  });
});

describe("stripReporterAttribution", () => {
  it("removes a trailing reporter credit and re-terminates the sentence", () => {
    expect(stripReporterAttribution("The Cardinals placed Carter (knee) on injured reserve Sunday, Darren Urban of the team's official site reports.")).toBe(
      "The Cardinals placed Carter (knee) on injured reserve Sunday."
    );
    expect(stripReporterAttribution("Rodriguez (undisclosed) is considered day-to-day, Joe Schad of The Palm Beach Post reported Friday.")).toBe(
      "Rodriguez (undisclosed) is considered day-to-day."
    );
    expect(stripReporterAttribution('Coach Mike LaFleur said Thursday that Love (ankle) is "progressing," Howard Balzer of Cards Wire reports.')).toBe(
      'Coach Mike LaFleur said Thursday that Love (ankle) is "progressing."'
    );
    expect(stripReporterAttribution("Burrow is out, per Adam Schefter.")).toBe("Burrow is out.");
  });

  it("leaves a note without a credit alone", () => {
    expect(stripReporterAttribution("Wright (hip) was put on injured reserve by the Saints on Monday.")).toBe(
      "Wright (hip) was put on injured reserve by the Saints on Monday."
    );
  });
});

describe("renderCard", () => {
  it("renders an injury status change as a ticker line with the ESPN note and a REPORTED tag", () => {
    const { text, tags } = renderCard(burrow);
    expect(text).toBe('Joe Burrow (CIN · QB): Questionable → Out. ESPN: "Burrow (toe) will miss 6–8 weeks after surgery."');
    expect(tags).toEqual(["REPORTED"]);
    expect(text).not.toContain("Schefter");
  });

  it("truncates a long note on a word with an ellipsis and stays within the limit", () => {
    const long = { ...burrow, note: `${"Burrow is dealing with a lingering toe issue that the staff is monitoring closely ".repeat(6)}and more.` };
    const { text } = renderCard(long);
    expect(text.length).toBeLessThanOrEqual(MAX_POST_CHARS);
    expect(text).toMatch(/…"$/);
    expect(text.startsWith("Joe Burrow (CIN · QB): Questionable → Out. ESPN: \"")).toBe(true);
  });

  it("degrades when team, position, previous status or note are unknown", () => {
    const thin: WireFactCard = { ...burrow, players: [{ espnId: "1", name: "Joe Burrow" }], nflTeam: undefined, statusFrom: undefined, note: undefined };
    expect(renderCard(thin).text).toBe("Joe Burrow: Out.");
  });

  it("renders a note as the quoted ESPN text", () => {
    const note: WireFactCard = { ...burrow, kind: "injury_note", statusFrom: undefined, statusTo: "Questionable" };
    expect(renderCard(note).text).toBe('Joe Burrow (CIN · QB) — ESPN: "Burrow (toe) will miss 6–8 weeks after surgery."');
  });

  it("renders news as the headline plus the source", () => {
    const news: WireFactCard = {
      kind: "news",
      observedAt: 0,
      players: [{ espnId: "3915511", name: "Joe Burrow" }],
      headline: "Chase Brown won't be overlooked in Bengals' offense",
      note: "Some description.",
      source: { type: "espn_news", id: "1", url: "https://www.espn.com/x", fetchedAt: 0 },
    };
    expect(renderCard(news)).toEqual({ text: "Chase Brown won't be overlooked in Bengals' offense (ESPN)", tags: ["REPORTED"] });
  });

  it("renders a depth-chart move and a trending spike with their sources", () => {
    const depth: WireFactCard = {
      kind: "depth_chart",
      observedAt: 0,
      players: [{ espnId: "4", name: "Jaleel McLaughlin", position: "RB", nflTeam: "DEN" }],
      depthOrderFrom: 2,
      depthOrderTo: 1,
      depthPosition: "RB",
      source: { type: "sleeper", fetchedAt: 0 },
    };
    expect(renderCard(depth).text).toBe("Jaleel McLaughlin moves from RB2 to RB1 on the DEN depth chart (Sleeper).");
    expect(renderCard({ ...depth, depthOrderFrom: undefined }).text).toBe("Jaleel McLaughlin moves to RB1 on the DEN depth chart (Sleeper).");

    const trending: WireFactCard = {
      kind: "trending",
      observedAt: 0,
      players: [{ espnId: "4", name: "Jaleel McLaughlin", position: "RB", nflTeam: "DEN" }],
      trendingAdds: 1240,
      source: { type: "sleeper", fetchedAt: 0 },
    };
    expect(renderCard(trending).text).toBe("Jaleel McLaughlin added in 1,240 Sleeper leagues in the last 24 h.");
  });

  it("renders a P2 kind generically with the right tag", () => {
    const final: WireFactCard = { ...burrow, kind: "game_final", headline: "Bengals 27, Browns 20", note: undefined, statusFrom: undefined, statusTo: undefined };
    expect(renderCard(final)).toEqual({ text: "Joe Burrow: Bengals 27, Browns 20 (ESPN)", tags: ["FINAL"] });
  });

  it("stays within the limit for absurd inputs", () => {
    const huge: WireFactCard = { ...burrow, players: [{ espnId: "1", name: "N".repeat(300) }] };
    expect(renderCard(huge).text.length).toBeLessThanOrEqual(MAX_POST_CHARS);
  });

  it("renders an ownership swing (spec §18) by its sign and size, tagged REPORTED", () => {
    const swing: WireFactCard = {
      kind: "ownership_swing",
      observedAt: 0,
      players: [{ espnId: "3915511", name: "Joe Burrow", position: "QB", nflTeam: "CIN", percentOwned: 63.2 }],
      ownershipChange: -12.4,
      source: { type: "espn_fantasy", fetchedAt: 0 },
    };
    expect(renderCard(swing)).toEqual({ text: "Joe Burrow was dropped in 12% of ESPN leagues overnight.", tags: ["REPORTED"] });
    expect(renderCard({ ...swing, ownershipChange: 8.6 }).text).toBe("Joe Burrow was added in 9% of ESPN leagues overnight.");
    expect(renderCard({ ...swing, ownershipChange: 0.4 }).text).toBe("Joe Burrow was added in 0.4% of ESPN leagues overnight.");
    expect(renderCard({ ...swing, ownershipChange: undefined }).text).toBe("Joe Burrow: ESPN roster percentage moved overnight.");
    expect(renderCard({ ...swing, ownershipChange: 0 }).text).toBe("Joe Burrow: ESPN roster percentage moved overnight.");
  });
});

describe("ownership_swing validation and numbers", () => {
  const swing = {
    kind: "ownership_swing",
    observedAt: 0,
    players: [{ espnId: "3915511", name: "Joe Burrow", percentOwned: 63.2 }],
    ownershipChange: -12.4,
    source: { type: "espn_fantasy", fetchedAt: 0 },
  };

  it("validateFactCard accepts the kind and keeps the signed change", () => {
    const parsed = validateFactCard(swing);
    expect(parsed.kind).toBe("ownership_swing");
    expect(parsed.ownershipChange).toBe(-12.4);
    expect(() => validateFactCard({ ...swing, ownershipChange: "12" })).toThrow(/ownershipChange/);
    expect(() => validateFactCard({ ...swing, ownershipChange: Number.POSITIVE_INFINITY })).toThrow(/ownershipChange/);
  });

  it("cardNumbers holds the swing as the reader sees it, unsigned", () => {
    const numbers = cardNumbers(validateFactCard(swing));
    expect(numbers).toEqual(expect.arrayContaining(["12", "12.4", "63.2", "63"]));
    expect(numbers).not.toContain("-12");
  });
});

describe("numbers and names", () => {
  it("extracts prose numbers in normalised form", () => {
    expect(extractNumbers("$31 left, 1,240 adds, 142.8 points, 6–8 weeks, RB1, 3rd, 2026-09-04")).toEqual(
      expect.arrayContaining(["31", "1240", "142.8", "6-8", "6", "8"])
    );
    expect(extractNumbers("RB1 and 3rd")).toEqual([]);
  });

  it("formats counts without ICU", () => {
    expect(formatCount(1240)).toBe("1,240");
    expect(formatCount(999)).toBe("999");
    expect(formatCount(1234567)).toBe("1,234,567");
  });

  it("cardNumbers holds the timetable, the note's figures and the card's counts", () => {
    const numbers = cardNumbers(burrow);
    expect(numbers).toEqual(expect.arrayContaining(["6-8", "6", "8", "99.4", "99", "3"]));
    expect(numbers).not.toContain("3915511");
    expect(numbers).not.toContain("636276");

    const trending: WireFactCard = { ...burrow, kind: "trending", trendingAdds: 1240, note: undefined, timetable: undefined };
    expect(cardNumbers(trending)).toEqual(expect.arrayContaining(["1240", "24"]));
  });

  it("cardNames holds players, teams, statuses and the note's people — but not the reporter", () => {
    const names = cardNames({
      ...burrow,
      note: 'Coach Mike LaFleur said Thursday that Burrow (toe) is "progressing," Howard Balzer of Cards Wire reports.',
    });
    expect(names).toEqual(expect.arrayContaining(["Joe Burrow", "CIN", "Questionable", "Out", "Coach Mike LaFleur", "ESPN"]));
    expect(names).not.toContain("Howard Balzer");
    expect(names.join(" ")).not.toContain("Cards Wire");
    expect(names.join(" ")).not.toContain("Coach Mike La ");
  });
});
