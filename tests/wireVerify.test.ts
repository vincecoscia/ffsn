import { describe, expect, it } from "vitest";
import { verifyLeagueText, verifyTake } from "../src/lib/ai/wire/verify";
import type { WireFactCard } from "../src/lib/ai/wire/types";

const burrow: WireFactCard = {
  kind: "injury_status",
  observedAt: 0,
  players: [{ espnId: "3915511", name: "Joe Burrow", position: "QB", nflTeam: "CIN", percentOwned: 99 }],
  nflTeam: "CIN",
  statusFrom: "Questionable",
  statusTo: "Out",
  note: "Burrow (toe) will miss 6-8 weeks after surgery, Adam Schefter of ESPN reports.",
  timetable: "6-8 weeks",
  source: { type: "espn_injuries", fetchedAt: 0 },
};

const noTimetable: WireFactCard = { ...burrow, note: "Burrow (toe) did not practice Thursday.", timetable: undefined };

describe("verifyTake", () => {
  it("passes a take that stays on the card", () => {
    expect(verifyTake("Burrow: toe, surgery, 6-8 weeks per ESPN. REPORTED. Questionable to Out. Stand by.", burrow)).toEqual({ ok: true, violations: [] });
  });

  it("accepts the timetable with a different dash and lets the desk toss by name", () => {
    expect(verifyTake("Burrow out 6–8 weeks, ESPN says. Nina Sharpe has the math. Back to you.", burrow).ok).toBe(true);
  });

  it("flags a number that is not on the card", () => {
    const result = verifyTake("Burrow threw for 4,200 yards last year. Out 6-8 weeks per ESPN.", burrow);
    expect(result.ok).toBe(false);
    expect(result.violations).toContain("unverified_number: 4200");
  });

  it("flags a reporter attribution, even one that was in the note", () => {
    const result = verifyTake("Burrow is out 6-8 weeks, Schefter of ESPN reports.", burrow);
    expect(result.ok).toBe(false);
    expect(result.violations.some(v => v.startsWith("reporter_attribution"))).toBe(true);

    const per = verifyTake("Burrow is out 6-8 weeks per Adam Schefter.", burrow);
    expect(per.violations.some(v => v.startsWith("reporter_attribution"))).toBe(true);
    expect(per.violations).toContain("unknown_name: Adam Schefter");

    for (const text of [
      "Burrow is out 6-8 weeks, Alexander of the Houston Chronicle reports.",
      "The Houston Chronicle reports Burrow is out 6-8 weeks.",
      "Per the Houston Chronicle, Burrow is out 6-8 weeks.",
    ]) {
      expect(verifyTake(text, burrow).violations.some(v => v.startsWith("reporter_attribution")), text).toBe(true);
    }
    // The card's own source is never a reporter.
    expect(verifyTake("ESPN reports Burrow is out 6-8 weeks. Per ESPN, that is.", burrow).violations).toEqual([]);
  });

  it("flags timetable talk when the card has no timetable", () => {
    const result = verifyTake("Burrow could miss weeks after this one.", noTimetable);
    expect(result.ok).toBe(false);
    expect(result.violations).toContain('timetable_without_card: "weeks"');
    expect(verifyTake("Burrow is week-to-week.", noTimetable).violations).toContain('timetable_without_card: "week-to-week"');
    expect(verifyTake("Burrow sat out Thursday. Out. REPORTED.", noTimetable).ok).toBe(true);
  });

  it("flags a timetable that does not match the card's", () => {
    const result = verifyTake("Burrow is out 4-6 weeks per ESPN.", burrow);
    expect(result.violations).toContain('timetable_mismatch: "4-6 weeks" is not "6-8 weeks"');
  });

  it("flags a register leak", () => {
    const result = verifyTake("Per the ledger, Burrow is out 6-8 weeks.", burrow);
    expect(result.ok).toBe(false);
    expect(result.violations.some(v => v.startsWith("register_leak"))).toBe(true);
    expect(verifyTake("Burrow status change logged 2026-09-04T20:24Z. Out.", noTimetable).violations.some(v => v.includes("ISO-8601"))).toBe(true);
  });

  it("lets a take relay a person the note names, whole, and never the reporter", () => {
    const card: WireFactCard = {
      ...noTimetable,
      note: 'Coach Mike LaFleur said Thursday that Burrow (toe) is "progressing," Howard Balzer of Cards Wire reports.',
    };
    expect(verifyTake("Mike LaFleur says Burrow is progressing. STATED. Stand by.", card).ok).toBe(true);
    expect(verifyTake("Howard Balzer says Burrow is progressing.", card).violations).toContain("unknown_name: Howard Balzer");
  });

  it("flags a person or fantasy team that is not on the card, and exempts openers, NFL teams and the desk", () => {
    expect(verifyTake("Jake Browning starts for the Bengals now. Burrow out 6-8 weeks per ESPN.", burrow).violations).toContain("unknown_name: Jake Browning");
    expect(verifyTake("Kittle Me This loses Burrow for 6-8 weeks.", burrow).violations).toContain("unknown_name: Kittle Me This");
    const fine = verifyTake("The Bengals lose Joe Burrow for 6-8 weeks per ESPN. Cincinnati Bengals problem. Dex Alvarez, out.", burrow);
    expect(fine.violations).toEqual([]);
  });

  it("flags an over-long or empty take", () => {
    expect(verifyTake("x".repeat(281), noTimetable).violations.some(v => v.startsWith("too_long"))).toBe(true);
    expect(verifyTake("   ", noTimetable).violations).toContain("empty");
  });

  it("flags unnamed sourcing", () => {
    expect(verifyTake("Sources say Burrow is out 6-8 weeks.", burrow).violations.some(v => v.startsWith("reporter_attribution"))).toBe(true);
  });
});

describe("verifyLeagueText", () => {
  it("allows nothing tracked at clean", () => {
    expect(verifyLeagueText("Kittle Me This wins by 11.6.", "clean", [])).toEqual({ ok: true, violations: [] });
    const result = verifyLeagueText("A damn shame for Kittle Me This.", "clean", []);
    expect(result.ok).toBe(false);
    expect(result.violations).toContain("language_over_rating: damn at clean");
  });

  it("allows the mild tier at salty and both tiers at unfiltered", () => {
    expect(verifyLeagueText("A damn shame.", "salty", []).ok).toBe(true);
    const strong = verifyLeagueText("A shitty week to be a bench.", "salty", []);
    expect(strong.ok).toBe(false);
    expect(strong.violations).toContain("language_over_rating: shitty at salty");
    expect(verifyLeagueText("A shitty week to be a bench.", "unfiltered", []).ok).toBe(true);
  });

  it("protects a team whose manager opted down, at any rating", () => {
    const result = verifyLeagueText("Kittle Me This is a damn mess. Moisty Loins is fine.", "unfiltered", ["Kittle Me This"]);
    expect(result.ok).toBe(false);
    expect(result.violations).toEqual(["clean_team_language: Kittle Me This"]);
    expect(verifyLeagueText("Kittle Me This is a mess. Moisty Loins is a damn mess.", "unfiltered", ["Kittle Me This"]).ok).toBe(true);
  });

  it("never counts a team's own name as profanity", () => {
    expect(verifyLeagueText("GLORY ASSHOLE wins the week.", "clean", ["GLORY ASSHOLE"]).ok).toBe(true);
  });

  it("flags an over-long line", () => {
    expect(verifyLeagueText("x".repeat(300), "clean", []).violations.some(v => v.startsWith("too_long"))).toBe(true);
  });
});
