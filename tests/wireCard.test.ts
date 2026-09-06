import { describe, expect, it } from "vitest";
import {
  bigLineMetrics,
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

  it("renders a live kind without its structured fields generically, with the right tag", () => {
    const final: WireFactCard = { ...burrow, kind: "game_final", headline: "Bengals 27, Browns 20", note: undefined, statusFrom: undefined, statusTo: undefined };
    expect(renderCard(final)).toEqual({ text: "Joe Burrow: Bengals 27, Browns 20 (ESPN)", tags: ["FINAL"] });
    expect(renderCard({ ...final, kind: "weather", headline: undefined }).text).toBe("Joe Burrow: weather (ESPN)");
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

describe("live cards (spec §19)", () => {
  const NOW = 1_800_000_000_000;
  const game = { eventId: "401671", home: "CIN", away: "KC", homeScore: 14, awayScore: 10, period: 2, clock: "4:12", kickoffAt: NOW - 60 * 60 * 1000 };
  const chase = { espnId: "4362628", name: "Ja'Marr Chase", position: "WR", nflTeam: "CIN", percentOwned: 100, adpPositionRank: 1 };
  const source = { type: "espn_summary" as const, id: "401671", fetchedAt: NOW };
  const live = (overrides: Partial<WireFactCard>): WireFactCard => ({ kind: "scoring_play", observedAt: NOW, players: [chase], nflTeam: "CIN", game, source, ...overrides });

  it("renders kickoff and final from the scoreboard, tagged LIVE and FINAL", () => {
    expect(renderCard(live({ kind: "game_started", players: [{ espnId: "1", name: "Bengals" }] }))).toEqual({ text: "Kickoff: KC at CIN. Let's go to the board.", tags: ["LIVE"] });
    expect(renderCard(live({ kind: "game_final", game: { ...game, homeScore: 27, awayScore: 20, period: 4, clock: "0:00" } }))).toEqual({
      text: "Final: CIN 27, KC 20.",
      tags: ["FINAL"],
    });
  });

  it("renders a scoring play with the score and clock, and does not repeat a player ESPN's text already names", () => {
    const named = live({ play: { text: "Ja'Marr Chase 12 Yd pass from Joe Burrow (Evan McPherson Kick)", yards: 12, tdCountToday: 1, scoreValue: 6 } });
    expect(renderCard(named)).toEqual({ text: "Ja'Marr Chase 12 Yd pass from Joe Burrow (Evan McPherson Kick) — KC 10, CIN 14, Q2 4:12.", tags: ["LIVE"] });

    const unnamed = live({ play: { text: "12 Yd pass from Joe Burrow (Evan McPherson Kick).", yards: 12 } });
    expect(renderCard(unnamed).text).toBe("Ja'Marr Chase (CIN): 12 Yd pass from Joe Burrow (Evan McPherson Kick) — KC 10, CIN 14, Q2 4:12.");

    expect(renderCard(live({ play: { text: "Ja'Marr Chase 12 Yd pass" }, game: { ...game, period: undefined, clock: undefined } })).text).toBe("Ja'Marr Chase 12 Yd pass — KC 10, CIN 14.");
    expect(renderCard(live({ play: { text: "Ja'Marr Chase 12 Yd pass" }, game: { ...game, clock: undefined } })).text).toBe("Ja'Marr Chase 12 Yd pass — KC 10, CIN 14, Q2.");
    expect(renderCard(live({ play: { text: "Ja'Marr Chase 12 Yd pass" }, game: undefined })).text).toBe("Ja'Marr Chase 12 Yd pass.");
  });

  it("cuts a long play text on a word with an ellipsis and keeps the score and clock intact", () => {
    const long = live({ play: { text: `Ja'Marr Chase ${"ran a route and kept running ".repeat(14)}for the score` } });
    const { text } = renderCard(long);
    expect(text.length).toBeLessThanOrEqual(MAX_POST_CHARS);
    expect(text).toMatch(/… — KC 10, CIN 14, Q2 4:12\.$/);
    expect(text.startsWith("Ja'Marr Chase ran a route")).toBe(true);
  });

  it("renders a big line with only the metrics that crossed a threshold", () => {
    const henry = { espnId: "3043078", name: "Derrick Henry", position: "RB", nflTeam: "BAL", percentOwned: 100 };
    const line = (fields: NonNullable<WireFactCard["line"]>) => renderCard(live({ kind: "big_line", players: [henry], nflTeam: "BAL", line: fields }));
    expect(line({ rushYds: 112, recYds: 23, td: 3, fantasyPoints: 29.5 })).toEqual({ text: "Derrick Henry (BAL · RB): 112 rushing yards, 3 TD and counting.", tags: ["LIVE"] });
    expect(line({ rushYds: 112 }).text).toBe("Derrick Henry (BAL · RB): 112 rushing yards and counting.");
    expect(line({ recYds: 131, td: 1 }).text).toBe("Derrick Henry (BAL · RB): 131 receiving yards and counting.");
    expect(line({ passYds: 312, td: 2 }).text).toBe("Derrick Henry (BAL · RB): 312 passing yards and counting.");
    expect(line({ passYds: 299, td: 2 }).text).toBe("Derrick Henry: big line (ESPN)");
    expect(bigLineMetrics(undefined)).toEqual([]);
  });

  it("renders a bust watch from the positional ADP rank and the final fantasy points, tagged FINAL", () => {
    const waddle = { espnId: "4372016", name: "Jaylen Waddle", position: "WR", nflTeam: "MIA", percentOwned: 98, adpPositionRank: 9 };
    const bust = (players: WireFactCard["players"], fields?: NonNullable<WireFactCard["line"]>) => renderCard(live({ kind: "bust_watch", players, nflTeam: "MIA", line: fields }));
    expect(bust([waddle], { fantasyPoints: 3.4 })).toEqual({ text: "Jaylen Waddle (ADP WR9) finished with 3.4 fantasy points.", tags: ["FINAL"] });
    expect(bust([waddle], { fantasyPoints: 2 }).text).toBe("Jaylen Waddle (ADP WR9) finished with 2 fantasy points.");
    expect(bust([{ ...waddle, adpPositionRank: undefined }], { fantasyPoints: 3.4 }).text).toBe("Jaylen Waddle finished with 3.4 fantasy points.");
    expect(bust([waddle]).text).toBe("Jaylen Waddle (ADP WR9) finished under 5 fantasy points.");
  });

  it("never credits a reporter or repeats the source label inside the line", () => {
    const cards = [
      live({ kind: "game_started" }),
      live({ kind: "game_final" }),
      live({ play: { text: "Ja'Marr Chase 12 Yd pass from Joe Burrow, Adam Schefter of ESPN reports." } }),
      live({ kind: "big_line", line: { recYds: 131 } }),
      live({ kind: "bust_watch", line: { fantasyPoints: 3.4 } }),
    ];
    for (const card of cards) {
      const { text } = renderCard(card);
      expect(text, text).not.toMatch(/\(ESPN\)/);
      expect(text, text).not.toMatch(/Schefter|reports/);
      expect(text.length).toBeLessThanOrEqual(MAX_POST_CHARS);
    }
  });

  it("validates the structured live fields", () => {
    const card = live({ play: { text: "Ja'Marr Chase 12 Yd pass from Joe Burrow", yards: 12, tdCountToday: 1, scoreValue: 6 }, line: { recYds: 44, td: 1, fantasyPoints: 16.4 } });
    expect(validateFactCard(card)).toEqual(card);
    expect(() => validateFactCard({ ...card, game: { ...game, homeScore: "14" } })).toThrow(/game\.homeScore/);
    expect(() => validateFactCard({ ...card, play: { yards: 12 } })).toThrow(/play\.text/);
    expect(() => validateFactCard({ ...card, line: { td: 1.5 } })).toThrow(/line\.td/);
  });

  it("cardNumbers holds every figure the live line renders; cardNames holds both teams and the people in the play", () => {
    const card = live({ play: { text: "Ja'Marr Chase 64 Yd pass from Joe Burrow (Evan McPherson Kick)", yards: 64, tdCountToday: 3, scoreValue: 6 }, line: { recYds: 131, td: 3, fantasyPoints: 31.1 } });
    expect(cardNumbers(card)).toEqual(expect.arrayContaining(["10", "14", "2", "4", "12", "64", "3", "6", "131", "31.1", "31"]));
    expect(cardNumbers(card)).not.toContain("401671");
    expect(cardNames(card)).toEqual(expect.arrayContaining(["Ja'Marr Chase", "CIN", "KC", "Joe Burrow", "ESPN"]));
    // The kicker rides along inside the parenthetical, which the noun pattern reads as one run.
    expect(cardNames(card).join(" | ")).toContain("Evan McPherson");
    const credited = live({ play: { text: "Ja'Marr Chase 64 Yd pass from Joe Burrow, Adam Schefter of ESPN reports." } });
    expect(cardNames(credited).join(" | ")).not.toContain("Schefter");
    expect(cardNumbers(live({ kind: "bust_watch", line: { fantasyPoints: 3.4 } }))).toEqual(expect.arrayContaining(["3.4", "5"]));
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
