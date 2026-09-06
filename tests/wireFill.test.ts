import { describe, expect, it } from "vitest";
import { defaultVariants, fillVariant, ownershipSwingSlots, splitTemplateSentences, templateTokens, timetableShape } from "../src/lib/ai/wire/fill";
import { sampleSlotsFor } from "../src/lib/ai/wire/stock-lines";
import { GLOBAL_EVENT_KINDS, MAX_POST_CHARS, SLOT_TOKENS, type WireFactCard, type WireSlots } from "../src/lib/ai/wire/types";

const SLOTS: WireSlots = {
  team: "Kittle Me This",
  ownerTeam: "Moisty Loins",
  player: "Joe Burrow",
  pos: "QB",
  status: "Out",
  timetable: "6-8 weeks",
  faab: "$31",
  bestFA: "Jake Browning",
  backup: "Jake Browning",
  trendingAdds: "1,240",
};

describe("templateTokens / splitTemplateSentences", () => {
  it("lists unique tokens in order, unknown ones included", () => {
    expect(templateTokens("{team} loses {player}. {team} has {faab}. {bogus}!")).toEqual(["team", "player", "faab", "bogus"]);
  });

  it("splits on sentence punctuation, allowing a closing quote or paren", () => {
    expect(splitTemplateSentences('He said "Go." Next: {team}. Done? Yes! (Really.) End')).toEqual([
      'He said "Go."',
      "Next: {team}.",
      "Done?",
      "Yes!",
      "(Really.)",
      "End",
    ]);
  });
});

describe("fillVariant", () => {
  it("fills every token", () => {
    const result = fillVariant("{team} loses {player} for {timetable}. {faab} FAAB left.", SLOTS);
    expect(result).toEqual({ ok: true, text: "Kittle Me This loses Joe Burrow for 6-8 weeks. $31 FAAB left." });
  });

  it("refuses an unknown token outright", () => {
    expect(fillVariant("{team} adds {dropped}.", SLOTS)).toEqual({ ok: false, unresolved: ["dropped"] });
  });

  it("drops the sentence whose slot is missing and keeps the rest", () => {
    const result = fillVariant("{team} loses {player} for {timetable}. {faab} FAAB left. {bestFA} is the best {pos} on waivers.", {
      ...SLOTS,
      faab: undefined,
    });
    expect(result).toEqual({
      ok: true,
      text: "Kittle Me This loses Joe Burrow for 6-8 weeks. Jake Browning is the best QB on waivers.",
      dropped: ["faab"],
    });
  });

  it("treats an empty string as missing", () => {
    expect(fillVariant("{faab} FAAB left. {team} is fine.", { ...SLOTS, faab: "  " })).toEqual({
      ok: true,
      text: "Kittle Me This is fine.",
      dropped: ["faab"],
    });
  });

  it("fails when nothing survives, naming what was missing", () => {
    expect(fillVariant("{faab} FAAB left. {bestFA} is the add.", { team: "X" })).toEqual({ ok: false, unresolved: ["faab", "bestFA"] });
  });

  it("collapses double spaces", () => {
    expect(fillVariant("{team}   loses  {player}.", SLOTS)).toEqual({ ok: true, text: "Kittle Me This loses Joe Burrow." });
  });

  it("keeps the result under the post limit by dropping trailing sentences", () => {
    const long = "L".repeat(150);
    const result = fillVariant("{team} one. {player} two. {pos} three.", { team: long, player: long, pos: "QB" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text.length).toBeLessThanOrEqual(MAX_POST_CHARS);
      expect(result.text).toBe(`${long} one.`);
    }
  });

  it("cuts a single over-long sentence with an ellipsis", () => {
    const result = fillVariant("{team} wins.", { team: "W".repeat(400) });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text.length).toBe(MAX_POST_CHARS);
      expect(result.text.endsWith("…")).toBe(true);
    }
  });
});

describe("defaultVariants", () => {
  const base: WireFactCard = {
    kind: "injury_status",
    observedAt: 0,
    players: [{ espnId: "3915511", name: "Joe Burrow", position: "QB", nflTeam: "CIN" }],
    nflTeam: "CIN",
    statusFrom: "Questionable",
    statusTo: "Out",
    timetable: "6-8 weeks",
    source: { type: "espn_injuries", fetchedAt: 0 },
  };

  const cards: WireFactCard[] = [
    base,
    { ...base, timetable: undefined },
    { ...base, statusTo: "Injured Reserve", timetable: "season-ending" },
    { ...base, statusTo: "Injured Reserve", timetable: "rest of the season" },
    { ...base, timetable: "week-to-week" },
    { ...base, timetable: "indefinitely" },
    { ...base, kind: "injury_note", statusFrom: undefined, statusTo: "Questionable", timetable: "season-ending" },
    { ...base, kind: "injury_note", statusFrom: undefined, statusTo: "Questionable", timetable: "remainder of the season" },
    { ...base, kind: "injury_note", statusFrom: undefined, statusTo: "Questionable", timetable: "day-to-day" },
    { ...base, kind: "injury_note", statusFrom: undefined, statusTo: "Questionable", timetable: "indefinitely" },
    { ...base, statusTo: "Injured Reserve", timetable: undefined },
    { ...base, statusTo: "Questionable", timetable: undefined },
    { ...base, statusFrom: "Out", statusTo: "Active", timetable: undefined },
    { ...base, kind: "injury_note", statusFrom: undefined, statusTo: "Questionable" },
    { ...base, kind: "injury_note", statusFrom: undefined, statusTo: "Questionable", timetable: undefined },
    { ...base, kind: "news", headline: "Burrow back at practice", statusFrom: undefined, statusTo: undefined, timetable: undefined },
    { ...base, kind: "depth_chart", depthOrderFrom: 2, depthOrderTo: 1, depthPosition: "QB", statusFrom: undefined, statusTo: undefined, timetable: undefined },
    { ...base, kind: "trending", trendingAdds: 1240, statusFrom: undefined, statusTo: undefined, timetable: undefined },
    ...GLOBAL_EVENT_KINDS.filter(kind => !["injury_status", "injury_note", "news", "depth_chart", "trending"].includes(kind)).map(
      kind => ({ ...base, kind, statusFrom: undefined, statusTo: undefined, timetable: undefined }) as WireFactCard
    ),
  ];

  it("uses only known slot tokens and fills to a post-length line for every kind and tier", () => {
    for (const card of cards) {
      const variants = defaultVariants(card);
      const slots = { ...sampleSlotsFor(card.kind), status: card.statusTo ?? "Out", timetable: card.timetable ?? "6-8 weeks" };
      for (const [name, template] of Object.entries(variants)) {
        for (const token of templateTokens(template)) expect(SLOT_TOKENS, `${card.kind}/${name} token {${token}}`).toContain(token);
        const filled = fillVariant(template, slots);
        expect(filled.ok, `${card.kind}/${name}: ${JSON.stringify(filled)}`).toBe(true);
        if (filled.ok) {
          expect(filled.dropped ?? [], `${card.kind}/${name} dropped`).toEqual([]);
          expect(filled.text.length).toBeLessThanOrEqual(MAX_POST_CHARS);
          expect(filled.text).not.toMatch(/\{[A-Za-z]+\}/);
        }
      }
    }
  });

  it("carries the timetable in the owner line when the card has one, and drops FAAB cleanly when a league has none", () => {
    const owner = defaultVariants(base).owner;
    expect(owner).toContain("{timetable}");
    const noFaab = fillVariant(owner, { ...SLOTS, faab: undefined });
    expect(noFaab.ok).toBe(true);
    if (noFaab.ok) {
      expect(noFaab.text).toContain("loses Joe Burrow for 6-8 weeks");
      expect(noFaab.text).not.toContain("FAAB");
      expect(noFaab.text).toContain("Jake Browning is the best QB on waivers");
    }
  });

  it("classifies timetable phrases by how they read in a sentence", () => {
    expect(timetableShape("6-8 weeks")).toBe("duration");
    expect(timetableShape("multiple weeks")).toBe("duration");
    expect(timetableShape("rest of the season")).toBe("duration_the");
    expect(timetableShape("season-ending")).toBe("season");
    expect(timetableShape("Out for the season")).toBe("season");
    expect(timetableShape("week-to-week")).toBe("designation");
    expect(timetableShape("day-to-day")).toBe("designation");
    expect(timetableShape("indefinitely")).toBe("open");
  });

  it("phrases the owner lead so every timetable shape scans", () => {
    const lead = (card: WireFactCard) => {
      const filled = fillVariant(defaultVariants(card).owner, { ...SLOTS, status: card.statusTo, timetable: card.timetable, faab: undefined, bestFA: undefined });
      return filled.ok ? filled.text : JSON.stringify(filled);
    };
    expect(lead(base)).toBe("Kittle Me This loses Joe Burrow for 6-8 weeks.");
    expect(lead({ ...base, statusTo: "Injured Reserve", timetable: "season-ending" })).toBe("Kittle Me This loses Joe Burrow: season-ending.");
    expect(lead({ ...base, statusTo: "Injured Reserve", timetable: "rest of the season" })).toBe("Kittle Me This loses Joe Burrow for the rest of the season.");
    expect(lead({ ...base, timetable: "week-to-week" })).toBe("Kittle Me This loses Joe Burrow: Out, week-to-week.");
    expect(lead({ ...base, timetable: "indefinitely" })).toBe("Kittle Me This loses Joe Burrow indefinitely.");
    expect(lead({ ...base, kind: "injury_note", statusFrom: undefined, statusTo: "Questionable", timetable: "season-ending" })).toBe(
      "Kittle Me This: season-ending for Joe Burrow, per ESPN."
    );
    expect(lead({ ...base, kind: "injury_note", statusFrom: undefined, statusTo: "Questionable", timetable: "day-to-day" })).toBe(
      "Kittle Me This: Joe Burrow is day-to-day, per ESPN."
    );
  });

  it("does not mention a timetable when the card has none", () => {
    const variants = defaultVariants({ ...base, timetable: undefined });
    for (const template of Object.values(variants)) expect(template).not.toContain("{timetable}");
  });

  it("phrases the ownership swing (spec §18) from the card's signed change", () => {
    const swing: WireFactCard = {
      kind: "ownership_swing",
      observedAt: 0,
      players: [{ espnId: "3915511", name: "Joe Burrow", position: "QB", nflTeam: "CIN" }],
      ownershipChange: -12.4,
      source: { type: "espn_fantasy", fetchedAt: 0 },
    };
    expect(ownershipSwingSlots(swing)).toEqual({ pct: "12%", direction: "dropped" });
    expect(ownershipSwingSlots({ ...swing, ownershipChange: 9 })).toEqual({ pct: "9%", direction: "added" });
    expect(ownershipSwingSlots({ ...swing, ownershipChange: undefined })).toEqual({});
    const variants = defaultVariants(swing);
    const slots: WireSlots = { ...SLOTS, ...ownershipSwingSlots(swing) };
    expect(fillVariant(variants.owner, slots)).toEqual({ ok: true, text: "Kittle Me This rosters Joe Burrow, who was dropped in 12% of ESPN leagues overnight." });
    expect(fillVariant(variants.opponent, slots)).toEqual({
      ok: true,
      text: "Kittle Me This draws Moisty Loins this week, and they roster Joe Burrow, who was dropped in 12% of ESPN leagues overnight.",
    });
    const freeAgent = fillVariant(variants.freeAgent, slots);
    expect(freeAgent.ok && freeAgent.text).toBe("Joe Burrow is on your wire in this league and was dropped in 12% of ESPN leagues overnight. $31 FAAB left.");
    const board = fillVariant(variants.draftBoard, { ...slots, adp: "18.4", adpRank: "QB3" });
    expect(board.ok && board.text).toBe("Joe Burrow (QB) is still on the board here and was dropped in 12% of ESPN leagues overnight. ADP 18.4, QB3.");
    // Without the swing slots the variant is skipped rather than posted with a hole in it.
    expect(fillVariant(variants.owner, SLOTS)).toEqual({ ok: false, unresolved: ["direction", "pct"] });
  });

  describe("live variants (spec §19)", () => {
    const game = { eventId: "401671", home: "CIN", away: "KC", homeScore: 14, awayScore: 10, period: 2, clock: "4:12" };
    const live = (overrides: Partial<WireFactCard>): WireFactCard => ({
      kind: "scoring_play",
      observedAt: 0,
      players: [{ espnId: "4362628", name: "Ja'Marr Chase", position: "WR", nflTeam: "CIN" }],
      nflTeam: "CIN",
      game,
      source: { type: "espn_summary", fetchedAt: 0 },
      ...overrides,
    });
    const owner = (card: WireFactCard, slots: WireSlots) => fillVariant(defaultVariants(card).owner, slots);
    const core: WireSlots = { team: "Kittle Me This", player: "Ja'Marr Chase" };

    it("scoring_play: the owner just got six (or whatever the play was worth)", () => {
      expect(owner(live({ play: { text: "Ja'Marr Chase 12 Yd pass", scoreValue: 6 } }), core)).toEqual({ ok: true, text: "Kittle Me This just got six from Ja'Marr Chase." });
      expect(owner(live({ play: { text: "Ja'Marr Chase 12 Yd pass" } }), core)).toEqual({ ok: true, text: "Kittle Me This just got six from Ja'Marr Chase." });
      expect(owner(live({ play: { text: "Evan McPherson 44 Yd Field Goal", scoreValue: 3 } }), core)).toEqual({ ok: true, text: "Kittle Me This just got three from Ja'Marr Chase." });
      expect(owner(live({ play: { text: "Two-point conversion", scoreValue: 2 } }), core)).toEqual({ ok: true, text: "Kittle Me This just got two from Ja'Marr Chase." });
    });

    it("big_line: the card's fantasy points are baked in; without them the {points} sentence fills or drops", () => {
      expect(owner(live({ kind: "big_line", line: { recYds: 131, fantasyPoints: 24.7 } }), core)).toEqual({
        ok: true,
        text: "Ja'Marr Chase is having a day for Kittle Me This. 24.7 fantasy points and counting.",
      });
      expect(owner(live({ kind: "big_line", line: { recYds: 131 } }), { ...core, points: "18.2" })).toEqual({
        ok: true,
        text: "Ja'Marr Chase is having a day for Kittle Me This. 18.2 fantasy points and counting.",
      });
      expect(owner(live({ kind: "big_line", line: { recYds: 131 } }), core)).toEqual({ ok: true, text: "Ja'Marr Chase is having a day for Kittle Me This.", dropped: ["points"] });
    });

    it("game_started / game_final: the owner line is the kickoff or the final for that team's player, plus an optional points tail", () => {
      expect(owner(live({ kind: "game_started" }), core)).toEqual({ ok: true, text: "Kickoff: Kittle Me This has Ja'Marr Chase on the field in this one." });
      expect(owner(live({ kind: "game_final" }), core)).toEqual({ ok: true, text: "Final for Kittle Me This: Ja'Marr Chase's game is done.", dropped: ["points"] });
      expect(owner(live({ kind: "game_final" }), { ...core, points: "16.4" })).toEqual({
        ok: true,
        text: "Final for Kittle Me This: Ja'Marr Chase's game is done. 16.4 fantasy points from him on the day.",
      });
      expect(owner(live({ kind: "game_final", line: { fantasyPoints: 16.4 } }), core)).toEqual({
        ok: true,
        text: "Final for Kittle Me This: Ja'Marr Chase's game is done. 16.4 fantasy points from him on the day.",
      });
    });

    it("bust_watch: the final points, and never a grade on the start (spec §16)", () => {
      expect(owner(live({ kind: "bust_watch", line: { fantasyPoints: 3.4 } }), core)).toEqual({
        ok: true,
        text: "Kittle Me This rosters Ja'Marr Chase: 3.4 fantasy points at the final. A bad day, not a lineup call.",
      });
      expect(owner(live({ kind: "bust_watch" }), core)).toEqual({
        ok: true,
        text: "Kittle Me This rosters Ja'Marr Chase: under 5 fantasy points at the final. A bad day, not a lineup call.",
      });
      for (const template of Object.values(defaultVariants(live({ kind: "bust_watch", line: { fantasyPoints: 3.4 } })))) {
        expect(template).not.toMatch(/mismanag|blunder|mistake|should have|idiot|dumb|panic|stupid|started/i);
      }
    });

    it("every live owner lead resolves from {team} and {player} alone, and the other variants read", () => {
      for (const kind of ["game_started", "game_final", "scoring_play", "big_line", "bust_watch"] as const) {
        const variants = defaultVariants(live({ kind, play: kind === "scoring_play" ? { text: "x" } : undefined }));
        const lead = owner(live({ kind }), core);
        expect(lead.ok, kind).toBe(true);
        if (lead.ok) {
          expect(lead.text, kind).toContain("Kittle Me This");
          expect(lead.text, kind).toContain("Ja'Marr Chase");
        }
        const opponent = fillVariant(variants.opponent, { team: "Sable Ridge Sentinels", ownerTeam: "Kittle Me This", player: "Ja'Marr Chase" });
        expect(opponent.ok, `${kind}/opponent`).toBe(true);
        if (opponent.ok) expect(opponent.text).toContain("Sable Ridge Sentinels draws Kittle Me This");
        const freeAgent = fillVariant(variants.freeAgent, { player: "Ja'Marr Chase" });
        expect(freeAgent.ok, `${kind}/freeAgent`).toBe(true);
        if (freeAgent.ok) expect(freeAgent.text).toContain("on your wire");
      }
    });
  });

  it("phrases the opponent line for the spec example", () => {
    expect(fillVariant(defaultVariants({ ...base, timetable: undefined }).opponent, SLOTS)).toEqual({
      ok: true,
      text: "Kittle Me This draws Moisty Loins the week Joe Burrow goes Out.",
    });
  });
});
