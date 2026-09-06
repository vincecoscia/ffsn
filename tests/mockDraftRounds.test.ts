import { describe, expect, it } from "vitest";
import { findIncompleteRounds } from "../src/lib/ai/fact-verifier";

const slots = (round: number, n: number, skip: string[] = []) =>
  Array.from({ length: n }, (_, i) => `${round}.${String(i + 1).padStart(2, "0")}`)
    .filter((label) => !skip.includes(label))
    .map((label) => `${label}, Some Team. Player X, ADP 12.4.`)
    .join(" ");

describe("mock draft: rounds one and two are pick by pick", () => {
  it("passes when every slot of both rounds is numbered somewhere in the piece", () => {
    const sections = [
      { name: "COLD OPEN", content: "Ten boards." },
      { name: "ROUND ONE", content: slots(1, 10) },
      { name: "ROUND TWO", content: `1.10 AND 2.01, Chodie mcgruber gets the turn. ${slots(2, 10, ["2.01"])}` },
      { name: "ROUNDS THREE THROUGH EIGHT", content: "Position runs." },
    ];
    expect(findIncompleteRounds(sections, 10)).toEqual([]);
  });

  it("blocks the section holding a round that skips slots, naming the missing picks", () => {
    const sections = [
      { name: "COLD OPEN", content: "Ten boards." },
      { name: "ROUND ONE AND TWO", content: `${slots(1, 10)} ROUND TWO IS WHERE THIS ROOM BLOWS IT. 2.02 is Josh Allen at 19.1.` },
      { name: "ROUNDS THREE THROUGH EIGHT", content: "Position runs." },
    ];
    const violations = findIncompleteRounds(sections, 10);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ kind: "round_incomplete", severity: "block", section: "ROUND ONE AND TWO" });
    expect(violations[0].detail).toContain("round 2: 1 of 10 picks are numbered");
    expect(violations[0].detail).toContain("2.01, 2.03");
  });

  it("never reads an ADP like 2.4 as a pick, and a missing round one is reported too", () => {
    const sections = [
      { name: "COLD OPEN", content: "Bijan Robinson, ADP 2.4, is the pick." },
      { name: "THE BOARD", content: "Nobody numbered anything." },
    ];
    const violations = findIncompleteRounds(sections, 4);
    expect(violations.map((v) => v.detail.slice(0, 7))).toEqual(["round 1", "round 2"]);
    expect(violations.every((v) => v.section === "THE BOARD")).toBe(true);
  });
});
