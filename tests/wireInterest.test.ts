import { describe, expect, it } from "vitest";
import { interestBase, isTakeWorthyScoringPlay, scoreInterest } from "../src/lib/ai/wire/interest";
import {
  SAME_PLAYER_PENALTY_WINDOW_MS,
  SCORING_PLAY_TAKE_MIN_TD_COUNT,
  SCORING_PLAY_TAKE_MIN_YARDS,
  type WireCardPlayer,
  type WireFactCard,
} from "../src/lib/ai/wire/types";

const NOW = 1_800_000_000_000;

function player(overrides: Partial<WireCardPlayer> = {}): WireCardPlayer {
  return { espnId: "3915511", name: "Joe Burrow", position: "WR", nflTeam: "CIN", ...overrides };
}

function card(overrides: Partial<WireFactCard> = {}): WireFactCard {
  return {
    kind: "injury_status",
    observedAt: NOW,
    players: [player()],
    nflTeam: "CIN",
    source: { type: "espn_injuries", id: "1", fetchedAt: NOW },
    ...overrides,
  };
}

describe("interestBase (spec §7 table)", () => {
  it("scores status transitions", () => {
    expect(interestBase(card({ statusFrom: "Questionable", statusTo: "Out" }))).toBe(60);
    expect(interestBase(card({ statusFrom: "Active", statusTo: "Injured Reserve" }))).toBe(60);
    expect(interestBase(card({ statusFrom: "Active", statusTo: "Questionable", timetable: "season-ending" }))).toBe(60);
    expect(interestBase(card({ statusFrom: "Active", statusTo: "Doubtful" }))).toBe(45);
    expect(interestBase(card({ statusFrom: "Active", statusTo: "Questionable" }))).toBe(30);
    expect(interestBase(card({ statusFrom: "Out", statusTo: "Active" }))).toBe(35);
    // A transition the table does not name falls to the default base.
    expect(interestBase(card({ statusFrom: "Active", statusTo: "Suspension" }))).toBe(15);
  });

  it("scores notes by whether they carry a timetable", () => {
    expect(interestBase(card({ kind: "injury_note", statusTo: "Questionable", timetable: "6-8 weeks" }))).toBe(40);
    expect(interestBase(card({ kind: "injury_note", statusTo: "Questionable" }))).toBe(15);
  });

  it("scores news, depth chart and trending", () => {
    expect(interestBase(card({ kind: "news", headline: "Burrow returns to practice" }))).toBe(20);
    expect(interestBase(card({ kind: "depth_chart", depthOrderFrom: 2, depthOrderTo: 1, depthPosition: "RB" }))).toBe(30);
    expect(interestBase(card({ kind: "depth_chart", depthOrderFrom: 3, depthOrderTo: 2, depthPosition: "RB" }))).toBe(15);
    expect(interestBase(card({ kind: "trending", trendingAdds: 1240 }))).toBe(20);
  });

  it("gives news a note's timetable base (spec update 2026-09-06, mirrors injury_note)", () => {
    expect(interestBase(card({ kind: "news", headline: "X out 4-6 weeks", timetable: "4-6 weeks" }))).toBe(40);
    expect(interestBase(card({ kind: "news" }))).toBe(20);
  });

  it("gives a trending spike +25 base when it carries a related event, and a board a fixed base", () => {
    expect(
      interestBase(
        card({
          kind: "trending",
          trendingAdds: 1240,
          related: { kind: "injury_status", players: ["X"], statusTo: "Out", observedAt: 0, source: "espn_injuries" },
        })
      )
    ).toBe(45);
    expect(interestBase(card({ kind: "trending_board" }))).toBe(40);
  });

  it("scores an ownership swing (spec §18) at 20, plus the usual roster term", () => {
    expect(interestBase(card({ kind: "ownership_swing", ownershipChange: -12 }))).toBe(20);
    expect(scoreInterest(card({ kind: "ownership_swing", ownershipChange: -12, players: [player({ percentOwned: 60 })] }), { now: NOW })).toBe(50);
  });

  it("gives kinds without a rule the default base", () => {
    expect(interestBase(card({ kind: "weather" }))).toBe(15);
  });

  it("scores the live kinds (spec §19)", () => {
    expect(interestBase(card({ kind: "game_started" }))).toBe(30);
    expect(interestBase(card({ kind: "game_final" }))).toBe(30);
    expect(interestBase(card({ kind: "scoring_play" }))).toBe(25);
    expect(interestBase(card({ kind: "big_line" }))).toBe(45);
    expect(interestBase(card({ kind: "bust_watch" }))).toBe(40);
  });
});

describe("scoreInterest on the live kinds (spec §19)", () => {
  const game = { eventId: "401", home: "CIN", away: "KC", homeScore: 14, awayScore: 10, period: 2, clock: "4:12" };
  const chase = (overrides: Partial<WireCardPlayer> = {}) =>
    player({ espnId: "4362628", name: "Ja'Marr Chase", position: "WR", percentOwned: 100, ...overrides });

  it("adds the roster term to every live kind as usual", () => {
    expect(scoreInterest(card({ kind: "game_started", game, players: [player({ percentOwned: 60 })] }), { now: NOW })).toBe(60);
    expect(scoreInterest(card({ kind: "big_line", game, players: [chase()], line: { recYds: 112 } }), { now: NOW })).toBe(95);
    expect(scoreInterest(card({ kind: "bust_watch", game, players: [chase()], line: { fantasyPoints: 3.4 } }), { now: NOW })).toBe(90);
  });

  it("gives a scoring play the +25 take bonus for a long touchdown or the player's third of the day", () => {
    const short = card({ kind: "scoring_play", game, players: [chase()], play: { text: "Ja'Marr Chase 12 Yd pass from Joe Burrow", yards: 12, tdCountToday: 1 } });
    expect(isTakeWorthyScoringPlay(short)).toBe(false);
    expect(scoreInterest(short, { now: NOW })).toBe(75);

    const long = card({ kind: "scoring_play", game, players: [chase()], play: { text: "Ja'Marr Chase 64 Yd pass from Joe Burrow", yards: 64, tdCountToday: 1 } });
    expect(isTakeWorthyScoringPlay(long)).toBe(true);
    expect(scoreInterest(long, { now: NOW })).toBe(100);

    const third = card({ kind: "scoring_play", game, players: [chase({ percentOwned: 20 })], play: { text: "Ja'Marr Chase 4 Yd pass from Joe Burrow", yards: 4, tdCountToday: 3 } });
    expect(isTakeWorthyScoringPlay(third)).toBe(true);
    expect(scoreInterest(third, { now: NOW })).toBe(60);

    expect(scoreInterest(card({ kind: "scoring_play", game, players: [chase({ percentOwned: 20 })], play: { text: "Ja'Marr Chase 4 Yd pass from Joe Burrow", yards: SCORING_PLAY_TAKE_MIN_YARDS - 1, tdCountToday: SCORING_PLAY_TAKE_MIN_TD_COUNT - 1 } }), { now: NOW })).toBe(35);
    expect(scoreInterest(card({ kind: "scoring_play", game, players: [chase({ percentOwned: 20 })], play: { text: "Ja'Marr Chase 4 Yd pass from Joe Burrow", yards: SCORING_PLAY_TAKE_MIN_YARDS } }), { now: NOW })).toBe(60);
  });

  it("never applies the scoring-play bonus to another kind, even with a play attached", () => {
    expect(scoreInterest(card({ kind: "big_line", game, players: [chase({ percentOwned: 0 })], play: { text: "x", yards: 80 } }), { now: NOW })).toBe(45);
  });
});

describe("scoreInterest", () => {
  it("is the base alone when nothing else is known", () => {
    expect(scoreInterest(card({ statusTo: "Out" }), { now: NOW })).toBe(60);
    expect(scoreInterest(card({ kind: "news" }), { now: NOW })).toBe(20);
  });

  it("adds half of percentOwned, capped at 50", () => {
    expect(scoreInterest(card({ kind: "news", players: [player({ percentOwned: 60 })] }), { now: NOW })).toBe(50);
    expect(scoreInterest(card({ kind: "news", players: [player({ percentOwned: 100 })] }), { now: NOW })).toBe(70);
    expect(scoreInterest(card({ kind: "news", players: [player({ percentOwned: 30 })] }), { now: NOW })).toBe(35);
  });

  it("uses the most-owned player on a multi-player card", () => {
    const multi = card({ kind: "news", players: [player({ percentOwned: 10 }), player({ espnId: "2", name: "Ja'Marr Chase", percentOwned: 90 })] });
    expect(scoreInterest(multi, { now: NOW })).toBe(65);
  });

  it("adds 15 for a multi-week timetable and nothing for a short one", () => {
    expect(scoreInterest(card({ kind: "injury_note", timetable: "6-8 weeks" }), { now: NOW })).toBe(55);
    expect(scoreInterest(card({ kind: "injury_note", timetable: "day-to-day" }), { now: NOW })).toBe(40);
  });

  it("adds 10 for a QB or a top-12 positional ADP", () => {
    expect(scoreInterest(card({ statusTo: "Out", players: [player({ position: "QB" })] }), { now: NOW })).toBe(70);
    expect(scoreInterest(card({ statusTo: "Out", players: [player({ adpPositionRank: 12 })] }), { now: NOW })).toBe(70);
    expect(scoreInterest(card({ statusTo: "Out", players: [player({ adpPositionRank: 13 })] }), { now: NOW })).toBe(60);
    // Both together are still one bonus.
    expect(scoreInterest(card({ statusTo: "Out", players: [player({ position: "QB", adpPositionRank: 1 })] }), { now: NOW })).toBe(70);
  });

  it("takes 20 off when the same player was posted inside the window", () => {
    const out = card({ statusTo: "Out" });
    expect(scoreInterest(out, { now: NOW, recentSamePlayerPostAt: NOW - 60 * 60 * 1000 })).toBe(40);
    expect(scoreInterest(out, { now: NOW, recentSamePlayerPostAt: NOW - SAME_PLAYER_PENALTY_WINDOW_MS })).toBe(40);
    expect(scoreInterest(out, { now: NOW, recentSamePlayerPostAt: NOW - SAME_PLAYER_PENALTY_WINDOW_MS - 1 })).toBe(60);
  });

  it("clamps to 0–100 and rounds", () => {
    expect(scoreInterest(card({ kind: "injury_note" }), { now: NOW, recentSamePlayerPostAt: NOW })).toBe(0);
    const max = card({ statusTo: "Out", timetable: "6-8 weeks", players: [player({ position: "QB", percentOwned: 100 })] });
    expect(scoreInterest(max, { now: NOW })).toBe(100);
    expect(scoreInterest(card({ kind: "news", players: [player({ percentOwned: 61 })] }), { now: NOW })).toBe(51);
  });

  it("never turns a trending_board into a take, however widely rostered its names are", () => {
    const board = card({ kind: "trending_board", players: [player({ percentOwned: 93 })] });
    expect(scoreInterest(board, { now: NOW })).toBe(40);
    expect(scoreInterest(board, { now: NOW, recentSamePlayerPostAt: NOW })).toBe(40);
  });

  it("matches the spec's Burrow example: QB, OUT, multi-week, widely rostered → tier-1 take", () => {
    const burrow = card({
      statusFrom: "Questionable",
      statusTo: "Out",
      timetable: "6-8 weeks",
      players: [player({ position: "QB", percentOwned: 99.4, adpPositionRank: 3 })],
    });
    expect(scoreInterest(burrow, { now: NOW })).toBeGreaterThanOrEqual(50);
  });
});
