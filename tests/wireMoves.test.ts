import { describe, expect, it } from "vitest";
import { describeMove, joinNames } from "../src/lib/ai/wire/moves";
import { buildStandingBlock, isMoveChase, modelReplyView, prepareWriterReplyRequest, verifyWriterReply } from "../src/lib/ai/wire/reply";
import { getPersona } from "../src/lib/ai/persona-prompts";
import type { WriterReplyInput } from "../src/lib/ai/wire/types";

/** Dex Desk (spec §18): the sentence Sam asks about, and Sam's chase over it. No network. */

describe("joinNames", () => {
  it("joins one, two and many names in prose", () => {
    expect(joinNames(["Joe Burrow"])).toBe("Joe Burrow");
    expect(joinNames(["Joe Burrow", "Chase Brown"])).toBe("Joe Burrow and Chase Brown");
    expect(joinNames(["Joe Burrow", "Chase Brown", "Tee Higgins"])).toBe("Joe Burrow, Chase Brown and Tee Higgins");
  });

  it("drops blanks", () => {
    expect(joinNames(["", "  ", "Joe Burrow"])).toBe("Joe Burrow");
    expect(joinNames([])).toBe("");
  });
});

describe("describeMove", () => {
  const base = { team: "Kittle Me This", manager: "Jordan Lee", players: ["Joe Burrow"] };

  it("describes a lineup move with the slot and the benched player", () => {
    expect(describeMove({ ...base, kind: "lineup_move", slot: "FLEX", benched: "Chase Brown" })).toBe(
      "Jordan Lee of Kittle Me This moved Joe Burrow into the FLEX and benched Chase Brown."
    );
  });

  it("describes a late swap with the minutes to kickoff", () => {
    expect(describeMove({ ...base, kind: "late_swap", slot: "FLEX", benched: "Chase Brown", minutes: 40 })).toBe(
      "Jordan Lee of Kittle Me This moved Joe Burrow into the FLEX and benched Chase Brown 40 minutes before kickoff."
    );
    expect(describeMove({ ...base, kind: "late_swap", slot: "RB2", minutes: 1 })).toBe("Jordan Lee of Kittle Me This moved Joe Burrow into the RB2 1 minute before kickoff.");
    expect(describeMove({ ...base, kind: "late_swap", slot: "RB2", minutes: 0.2 })).toBe("Jordan Lee of Kittle Me This moved Joe Burrow into the RB2 right at kickoff.");
    expect(describeMove({ ...base, kind: "late_swap", slot: "RB2" })).toBe("Jordan Lee of Kittle Me This moved Joe Burrow into the RB2 inside an hour of kickoff.");
  });

  it("describes a proposal as involving its pieces, never as giving them", () => {
    expect(describeMove({ ...base, kind: "trade_proposal", players: ["Joe Burrow", "Chase Brown"], otherTeam: "Sable Ridge Sentinels" })).toBe(
      "Jordan Lee of Kittle Me This proposed a trade to Sable Ridge Sentinels involving Joe Burrow and Chase Brown."
    );
    expect(describeMove({ ...base, kind: "trade_proposal", players: [], otherTeam: "Sable Ridge Sentinels" })).toBe(
      "Jordan Lee of Kittle Me This proposed a trade to Sable Ridge Sentinels."
    );
    expect(describeMove({ ...base, kind: "trade_proposal", players: ["Joe Burrow"] })).toBe("Jordan Lee of Kittle Me This proposed a trade involving Joe Burrow.");
    expect(describeMove({ ...base, kind: "trade_proposal", players: [] })).toBe("Jordan Lee of Kittle Me This proposed a trade.");
  });

  it("degrades when the slot, the manager or the players are unknown", () => {
    expect(describeMove({ ...base, kind: "lineup_move" })).toBe("Jordan Lee of Kittle Me This moved Joe Burrow into the starting lineup.");
    expect(describeMove({ ...base, kind: "lineup_move", players: ["Joe Burrow", "Chase Brown"], slot: "FLEX" })).toBe(
      "Jordan Lee of Kittle Me This moved Joe Burrow and Chase Brown into the starting lineup."
    );
    expect(describeMove({ ...base, kind: "lineup_move", manager: "", slot: "FLEX" })).toBe("Kittle Me This moved Joe Burrow into the FLEX.");
    expect(describeMove({ ...base, kind: "lineup_move", team: " ", manager: "", players: [] })).toBe("The manager changed the starting lineup.");
  });

  it("never emits a slot token, an id or a timestamp", () => {
    const text = describeMove({ ...base, kind: "late_swap", slot: "FLEX", benched: "Chase Brown", minutes: 40 });
    expect(text).not.toMatch(/\{[A-Za-z]+\}/);
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });
});

describe("Sam's chase over a move description", () => {
  const move: WriterReplyInput = {
    persona: "sam-ortega",
    mode: "chase",
    chaseSubject: "move",
    managerText: describeMove({ kind: "late_swap", team: "Kittle Me This", manager: "Jordan Lee", players: ["Joe Burrow"], slot: "FLEX", benched: "Chase Brown", minutes: 40 }),
    manager: { displayName: "Jordan Lee", teamName: "Kittle Me This", relationshipTier: "neutral", recentEvidence: [] },
    thread: [],
    languageRating: "clean",
    cleanTeam: false,
    week: 4,
  };

  it("is a move chase only when the mode and the subject say so", () => {
    expect(isMoveChase(move)).toBe(true);
    expect(isMoveChase({ ...move, chaseSubject: "post" })).toBe(false);
    expect(isMoveChase({ ...move, chaseSubject: undefined })).toBe(false);
    expect(isMoveChase({ ...move, mode: "reply" })).toBe(false);
  });

  it("works without a writer post: Sam, chase mode, the description under `move`, never under managerText", () => {
    const prepared = prepareWriterReplyRequest(move);
    expect(prepared.persona.slug).toBe("sam-ortega");
    expect(prepared.standing).toContain("Mode: chase");
    expect(prepared.standing).toContain("describes a move this manager just made");
    expect(prepared.standing).toContain("one question about the decision: no opinion, no numbers");
    expect(prepared.systemPrompt).toContain("never quote the description back");
    const view = modelReplyView(move);
    expect(view.move).toBe(move.managerText);
    expect(view).not.toHaveProperty("managerText");
    expect(view.writerPost).toBeUndefined();
    const serialized = prepared.params.messages[0].content as string;
    expect(serialized).toContain("40 minutes before kickoff");
    expect(serialized).not.toContain("managerText");
  });

  it("keeps the plain post wording for a manager's own post", () => {
    const post = { ...move, chaseSubject: "post" as const, managerText: "Benching my RB1 this week. Gut call." };
    expect(buildStandingBlock(getPersona("sam-ortega"), post)).toContain("exactly one question about what they just posted");
    expect(modelReplyView(post).managerText).toBe(post.managerText);
  });

  it("verifies one question that names only the people in the move", () => {
    expect(verifyWriterReply("I ask Jordan Lee what changed on Joe Burrow in the last hour before kickoff?", move)).toEqual([]);
    expect(verifyWriterReply("I ask what changed? Was it the matchup?", move)).toEqual(["chase_questions: 2"]);
    expect(verifyWriterReply("I ask what changed on Joe Burrow.", move)).toEqual(["chase_questions: 0"]);
    expect(verifyWriterReply("I ask Jordan Lee whether Coach Taylor said something?", move)).toEqual(["unknown_name: Coach Taylor"]);
  });
});
