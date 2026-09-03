import { describe, expect, it } from "vitest";
import {
  checkEditedSegment,
  extractFactTokens,
  naturalizeTranscript,
  tidyEditedTurns,
} from "../src/lib/ai/disputed/edit-bay";
import type { EditCaller } from "../src/lib/ai/disputed/edit-bay";
import { EditedSegmentSchema, TurnOutputSchema } from "../src/lib/ai/disputed/types";
import type { EditedSegment, ShowSegment, ShowTranscript, ShowTurn } from "../src/lib/ai/disputed/types";
import { zodToJsonSchema } from "zod-to-json-schema";

/* -------------------------------------------------------------------------- *
 * A hand-built 5-turn segment with real-looking numbers, reused across the guard tests below.
 * Turn 0 (mel) is the segment's FIRST turn; turn 4 (curtis, "close") is its LAST and is locked,
 * along with turn 3 (nina, "grade").
 * -------------------------------------------------------------------------- */

function baseTurn(overrides: Partial<ShowTurn>): ShowTurn {
  return { speaker: "curtis-vaughn", kind: "argument", text: "", jab: false, factsCited: [], ...overrides };
}

const ORIGINAL_SEGMENT: ShowSegment = {
  id: "main_event",
  title: "Main Event",
  turns: [
    baseTurn({
      speaker: "mel-diaper",
      kind: "argument",
      text: "Trevor Ashby dropped 116.9 points and still lost by 4-3 in the standings. That's not a fluke, that's a trend.",
      jab: true,
      factsCited: ["mel's fact"],
    }),
    baseTurn({
      speaker: "reggie-banks",
      kind: "argument",
      text: "Nina Sharpe already covered the bench math. Cameron Coscia sits at $76 with nine pickups this year.",
      jab: true,
      factsCited: ["reggie's fact"],
      witnessRequested: "nina-sharpe",
      model: "claude-opus-5",
      retried: true,
    }),
    baseTurn({
      speaker: "nina-sharpe",
      kind: "witness",
      text: "Class, grade the claim: partly supported. The record is 4-3 and the points are 116.9. I'm holding it loosely.",
    }),
    baseTurn({
      speaker: "nina-sharpe",
      kind: "grade",
      text: "Class, final grade: supported. The number that decided it is 116.9.",
      verdict: { winner: "reggie-banks", reason: "the 116.9 number" },
    }),
    baseTurn({
      speaker: "curtis-vaughn",
      kind: "close",
      text: "That's the show.",
    }),
  ],
};

/** A faithful cut: turn 0 (mel) is split around reggie's interrupting line, everything else is trimmed but adds nothing. */
const ACCEPTED_EDIT: EditedSegment = {
  turns: [
    { sourceTurn: 0, speaker: "mel-diaper", text: "Trevor Ashby dropped 116.9 points and still—" },
    { sourceTurn: 1, speaker: "reggie-banks", text: "Oh, come on.", interrupts: true },
    { sourceTurn: 0, speaker: "mel-diaper", text: "lost by 4-3. That's a trend." },
    { sourceTurn: 2, speaker: "nina-sharpe", text: "Class, it's partly supported. 116.9, and the record's 4-3." },
    { sourceTurn: 3, speaker: "nina-sharpe", text: "Class, final grade: supported. The number that decided it is 116.9." },
    { sourceTurn: 4, speaker: "curtis-vaughn", text: "That's the show." },
  ],
};

describe("checkEditedSegment — accepts a faithful cut", () => {
  it("accepts a split turn (interruption), preserves the first and last original turns, and keeps locked turns verbatim", () => {
    const result = checkEditedSegment(ORIGINAL_SEGMENT, ACCEPTED_EDIT);
    expect(result).toEqual({ ok: true });
  });
});

describe("checkEditedSegment — rejections", () => {
  it("rejects a new number not in the original", () => {
    const edited: EditedSegment = {
      turns: ACCEPTED_EDIT.turns.map((turn) =>
        turn.sourceTurn === 0 && turn.text.startsWith("Trevor")
          ? { ...turn, text: "Trevor Ashby dropped 31.7 points and still—" }
          : turn
      ),
    };
    const result = checkEditedSegment(ORIGINAL_SEGMENT, edited);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("31.7");
  });

  it("rejects a new mid-sentence name not in the original", () => {
    const edited: EditedSegment = {
      turns: ACCEPTED_EDIT.turns.map((turn) =>
        turn.sourceTurn === 2
          ? { ...turn, text: "Class, it's partly supported for Bijan. 116.9, and the record's 4-3." }
          : turn
      ),
    };
    const result = checkEditedSegment(ORIGINAL_SEGMENT, edited);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("bijan");
  });

  it("rejects growth (edited segment longer than the original)", () => {
    // Every original turn, in full, plus one extra copy of turn 0's text — no new tokens anywhere,
    // just more of them than the original had.
    const edited: EditedSegment = {
      turns: [
        ...ORIGINAL_SEGMENT.turns.map((turn, index) => ({ sourceTurn: index, speaker: turn.speaker, text: turn.text })),
        { sourceTurn: 0, speaker: "mel-diaper", text: ORIGINAL_SEGMENT.turns[0].text },
      ],
    };
    const result = checkEditedSegment(ORIGINAL_SEGMENT, edited);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/grew/i);
  });

  it("rejects a changed locked grade turn", () => {
    const edited: EditedSegment = {
      turns: ACCEPTED_EDIT.turns.map((turn) =>
        turn.sourceTurn === 3
          ? { ...turn, text: "Class, final grade: supported for sure. The number that decided it is 116.9." }
          : turn
      ),
    };
    const result = checkEditedSegment(ORIGINAL_SEGMENT, edited);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("locked turn 3");
  });

  it("rejects a wrong-speaker sourceTurn", () => {
    const edited: EditedSegment = {
      turns: ACCEPTED_EDIT.turns.map((turn) =>
        turn.sourceTurn === 1 && turn.speaker === "reggie-banks" ? { ...turn, speaker: "mel-diaper" } : turn
      ),
    };
    const result = checkEditedSegment(ORIGINAL_SEGMENT, edited);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/speaker/i);
  });

  it("rejects a dropped first turn", () => {
    const edited: EditedSegment = { turns: ACCEPTED_EDIT.turns.filter((turn) => turn.sourceTurn !== 0) };
    const result = checkEditedSegment(ORIGINAL_SEGMENT, edited);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/first turn/i);
  });

  it("rejects a dropped last turn", () => {
    const edited: EditedSegment = { turns: ACCEPTED_EDIT.turns.filter((turn) => turn.sourceTurn !== 4) };
    const result = checkEditedSegment(ORIGINAL_SEGMENT, edited);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/last turn/i);
  });
});

describe("checkEditedSegment — language rating guard (step f)", () => {
  const segment: ShowSegment = {
    id: "main_event",
    title: "Main Event",
    turns: [
      baseTurn({
        speaker: "mel-diaper",
        text: "The Grinders really blew it drafting a kicker early.",
      }),
      baseTurn({ speaker: "curtis-vaughn", kind: "close", text: "That's the show." }),
    ],
  };

  it("rejects an edit that introduces profanity at clean rating (the default, when no rating is given)", () => {
    const edited: EditedSegment = {
      turns: [
        { sourceTurn: 0, speaker: "mel-diaper", text: "The Grinders damn blew it drafting a kicker early." },
        { sourceTurn: 1, speaker: "curtis-vaughn", text: "That's the show." },
      ],
    };
    const result = checkEditedSegment(segment, edited);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('edited segment introduces profanity at clean rating: "damn"');
  });

  it("rejects the same edit when languageRating is explicitly clean", () => {
    const edited: EditedSegment = {
      turns: [
        { sourceTurn: 0, speaker: "mel-diaper", text: "The Grinders damn blew it drafting a kicker early." },
        { sourceTurn: 1, speaker: "curtis-vaughn", text: "That's the show." },
      ],
    };
    const result = checkEditedSegment(segment, edited, { languageRating: "clean" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('"damn"');
  });

  it("does not reject the same mild-profanity edit at salty rating", () => {
    const edited: EditedSegment = {
      turns: [
        { sourceTurn: 0, speaker: "mel-diaper", text: "The Grinders damn blew it drafting a kicker early." },
        { sourceTurn: 1, speaker: "curtis-vaughn", text: "That's the show." },
      ],
    };
    const result = checkEditedSegment(segment, edited, { languageRating: "salty" });
    expect(result).toEqual({ ok: true });
  });

  it("accepts an edit that introduces no profanity at clean rating", () => {
    const edited: EditedSegment = {
      turns: [
        { sourceTurn: 0, speaker: "mel-diaper", text: "The Grinders blew it drafting a kicker early." },
        { sourceTurn: 1, speaker: "curtis-vaughn", text: "That's the show." },
      ],
    };
    const result = checkEditedSegment(segment, edited);
    expect(result).toEqual({ ok: true });
  });

  it("rejects a new strong word at salty rating, even though a new mild word passes", () => {
    const strongEdit: EditedSegment = {
      turns: [
        { sourceTurn: 0, speaker: "mel-diaper", text: "The Grinders fucking blew it drafting a kicker early." },
        { sourceTurn: 1, speaker: "curtis-vaughn", text: "That's the show." },
      ],
    };
    const strongResult = checkEditedSegment(segment, strongEdit, { languageRating: "salty" });
    expect(strongResult.ok).toBe(false);
    if (!strongResult.ok) {
      expect(strongResult.reason).toBe('edited segment introduces profanity at salty rating: "fucking"');
    }

    const mildEdit: EditedSegment = {
      turns: [
        { sourceTurn: 0, speaker: "mel-diaper", text: "The Grinders damn blew it drafting a kicker early." },
        { sourceTurn: 1, speaker: "curtis-vaughn", text: "That's the show." },
      ],
    };
    const mildResult = checkEditedSegment(segment, mildEdit, { languageRating: "salty" });
    expect(mildResult).toEqual({ ok: true });
  });
});

describe("checkEditedSegment — sentence-initial capitals and desk names are not new names", () => {
  it("does not reject a sentence-initial capitalized word, or a desk member's name, that are new to this segment", () => {
    const original: ShowSegment = {
      id: "main_event",
      title: "Main Event",
      turns: [
        baseTurn({
          speaker: "mel-diaper",
          text:
            "The Grinders have a real problem at running back this week against a tough opponent, and nobody has fixed it.",
        }),
      ],
    };
    // "November" opens the edit's very first sentence (must not read as an invented name); "Nina
    // Sharpe" sits mid-sentence and is new to THIS segment's text, but she is a real desk member.
    const edited: EditedSegment = {
      turns: [{ sourceTurn: 0, speaker: "mel-diaper", text: "November means nothing without Nina Sharpe grading it." }],
    };
    const result = checkEditedSegment(original, edited);
    expect(result).toEqual({ ok: true });
  });
});

describe("extractFactTokens", () => {
  it("normalizes numbers by stripping commas, and leaves $ and % signs and hyphenated records alone", () => {
    const { numbers } = extractFactTokens("The line was 116.9, then 4-3, then $76, then 1,094.2, then 20%.");
    expect(numbers).toEqual(new Set(["116.9", "4-3", "$76", "1094.2", "20%"]));
  });

  it("excludes sentence-initial words and the first-person stoplist from names", () => {
    const { names } = extractFactTokens("Well, Reggie says I'm not worried, and Reggie says I'll say it again.");
    expect(names.has("well")).toBe(false); // sentence-initial (start of text)
    expect(names.has("i'm")).toBe(false); // stoplist, mid-sentence
    expect(names.has("i'll")).toBe(false); // stoplist, mid-sentence
    expect(names.has("reggie")).toBe(true);
  });
});

describe("naturalizeTranscript", () => {
  const segmentA: ShowSegment = {
    id: "opening_statements",
    title: "Opening Statements",
    turns: [
      baseTurn({
        speaker: "mel-diaper",
        kind: "opening",
        text: "Mel says the Grinders are legit and points to 116.9 points this week.",
      }),
      baseTurn({
        speaker: "reggie-banks",
        kind: "opening",
        text: "Reggie disagrees and cites a 4-3 record as proof of nothing.",
      }),
    ],
  };
  const segmentB: ShowSegment = {
    id: "last_jabs",
    title: "Last Jabs",
    turns: [
      baseTurn({
        speaker: "mel-diaper",
        kind: "jab",
        text: "Mel takes one last shot at Reggie with the 116.9 number.",
        jab: true,
      }),
      baseTurn({ speaker: "curtis-vaughn", kind: "close", text: "That's the show." }),
    ],
  };
  const transcript: ShowTranscript = {
    schema: "ffsn.transcript.v1",
    show: "disputed",
    question: "Test question?",
    segments: [segmentA, segmentB],
  };

  // segmentA's edit is faithful (accepted); segmentB's introduces "55.2", a number nowhere in the
  // original (rejected) — so naturalizeTranscript must fall back to segmentB's original turns.
  const fakeCall: EditCaller = async (req) => {
    if (req.segmentId === "opening_statements") {
      return {
        output: {
          turns: [
            { sourceTurn: 0, speaker: "mel-diaper", text: "Mel says 116.9 proves it." },
            { sourceTurn: 1, speaker: "reggie-banks", text: "Reggie says 4-3 proves nothing." },
          ],
        },
        usage: { input: 20, output: 10 },
        model: "claude-sonnet-5",
      };
    }
    return {
      output: {
        turns: [
          { sourceTurn: 0, speaker: "mel-diaper", text: "Mel closes with a fresh 55.2 number." },
          { sourceTurn: 1, speaker: "curtis-vaughn", text: "That's the show." },
        ],
      },
      usage: { input: 15, output: 8 },
      model: "claude-sonnet-5",
    };
  };

  it("falls back to the original segment on a guard rejection, and reports the rejection", async () => {
    const result = await naturalizeTranscript(transcript, { call: fakeCall });

    expect(result.stats.segmentsEdited).toBe(1);
    expect(result.stats.segmentsRejected).toBe(1);
    expect(result.stats.rejections).toHaveLength(1);
    expect(result.stats.rejections[0].segment).toBe("last_jabs");
    expect(result.stats.rejections[0].reason).toContain("55.2");

    expect(result.transcript.segments[0].turns.map((turn) => turn.text)).toEqual([
      "Mel says 116.9 proves it.",
      "Reggie says 4-3 proves nothing.",
    ]);
    // Rejected — the original segment comes back completely unchanged.
    expect(result.transcript.segments[1]).toEqual(segmentB);
  });

  it("sets transcript.edited with the right word counts and per-segment stats", async () => {
    const result = await naturalizeTranscript(transcript, { call: fakeCall });

    // segmentA original: 13 + 11 = 24 words. segmentB original: 11 + 3 = 14 words.
    expect(result.stats.wordsBefore).toBe(38);
    // segmentA edited: 5 + 5 = 10 words. segmentB rejected, so its ORIGINAL 14 words count instead.
    expect(result.stats.wordsAfter).toBe(24);

    expect(result.transcript.edited).toEqual({
      pass: "edit-bay-v1",
      wordsBefore: 38,
      wordsAfter: 24,
      segmentsEdited: 1,
      segmentsRejected: 1,
      rejections: [{ segment: "last_jabs", reason: result.stats.rejections[0].reason }],
    });
  });

  it("copies kind/factsCited/witnessRequested/model/retried from the source turn, and carries interrupts through", async () => {
    const oneSegmentTranscript: ShowTranscript = {
      schema: "ffsn.transcript.v1",
      show: "disputed",
      question: "Test question?",
      segments: [ORIGINAL_SEGMENT],
    };
    const call: EditCaller = async () => ({
      output: ACCEPTED_EDIT,
      usage: { input: 30, output: 12 },
      model: "claude-sonnet-5",
    });

    const result = await naturalizeTranscript(oneSegmentTranscript, { call });

    expect(result.stats.segmentsRejected).toBe(0);
    expect(result.stats.segmentsEdited).toBe(1);

    const turns = result.transcript.segments[0].turns;
    expect(turns).toHaveLength(6);

    // turns[1] is reggie's interrupting line — drastically shorter text, but same metadata as his
    // ORIGINAL argument turn (sourceTurn 1): kind, jab, factsCited, witnessRequested, model, retried.
    const interrupting = turns[1];
    expect(interrupting.text).toBe("Oh, come on.");
    expect(interrupting.interrupts).toBe(true);
    expect(interrupting.speaker).toBe("reggie-banks");
    expect(interrupting.kind).toBe("argument");
    expect(interrupting.jab).toBe(true);
    expect(interrupting.factsCited).toEqual(["reggie's fact"]);
    expect(interrupting.witnessRequested).toBe("nina-sharpe");
    expect(interrupting.model).toBe("claude-opus-5");
    expect(interrupting.retried).toBe(true);

    // turns[0] and turns[2] are both mel's split turn 0 — same metadata, no interrupts of their own.
    expect(turns[0].kind).toBe("argument");
    expect(turns[0].jab).toBe(true);
    expect(turns[0].factsCited).toEqual(["mel's fact"]);
    expect(turns[0].interrupts).toBeUndefined();
    expect(turns[2].factsCited).toEqual(["mel's fact"]);

    // turns[4] is the locked grade turn: verbatim text, verdict carried over from the source.
    expect(turns[4].text).toBe(ORIGINAL_SEGMENT.turns[3].text);
    expect(turns[4].verdict).toEqual({ winner: "reggie-banks", reason: "the 116.9 number" });

    // turns[5] is the locked close turn, and the segment's last turn.
    expect(turns[5].text).toBe("That's the show.");
    expect(turns[5].kind).toBe("close");
  });
});

describe("naturalizeTranscript — one retry with the reason fed back", () => {
  const oneSegment: ShowTranscript = {
    schema: "ffsn.transcript.v1",
    show: "disputed",
    question: "Test question?",
    segments: [ORIGINAL_SEGMENT],
  };

  it("accepts the retry when the first edit touched a locked turn", async () => {
    const prompts: string[] = [];
    let calls = 0;
    const call: EditCaller = async (req) => {
      prompts.push(req.user);
      calls++;
      const output: EditedSegment =
        calls === 1
          ? { turns: ACCEPTED_EDIT.turns.map((turn) => (turn.sourceTurn === 3 ? { ...turn, text: "Final grade: whatever." } : turn)) }
          : ACCEPTED_EDIT;
      return { output, usage: { input: 10, output: 5 }, model: "claude-sonnet-5" };
    };

    const result = await naturalizeTranscript(oneSegment, { call });
    expect(calls).toBe(2);
    expect(prompts[1]).toContain("YOUR PREVIOUS EDIT WAS REJECTED");
    expect(prompts[1]).toContain("locked turn 3");
    expect(result.stats.segmentsRetried).toBe(1);
    expect(result.stats.segmentsEdited).toBe(1);
    expect(result.stats.segmentsRejected).toBe(0);
  });

  it("keeps pass one when the retry fails too", async () => {
    let calls = 0;
    const call: EditCaller = async () => {
      calls++;
      return {
        output: { turns: ACCEPTED_EDIT.turns.map((turn) => (turn.sourceTurn === 3 ? { ...turn, text: "Final grade: whatever." } : turn)) },
        usage: { input: 10, output: 5 },
        model: "claude-sonnet-5",
      };
    };
    const result = await naturalizeTranscript(oneSegment, { call });
    expect(calls).toBe(2);
    expect(result.stats.segmentsRetried).toBe(1);
    expect(result.stats.segmentsRejected).toBe(1);
    expect(result.transcript.segments[0].turns).toEqual(ORIGINAL_SEGMENT.turns);
  });
});

describe("tidyEditedTurns", () => {
  const turn = (speaker: string, text: string, extra: Partial<ShowTurn> = {}): ShowTurn =>
    baseTurn({ speaker, text, ...extra });

  it("merges consecutive turns by the same speaker back into one", () => {
    const tidied = tidyEditedTurns([
      turn("mel-diaper", "Pick two."),
      turn("mel-diaper", "Pick twenty-two."),
      turn("reggie-banks", "Cute draft."),
    ]);
    expect(tidied.map((t) => t.speaker)).toEqual(["mel-diaper", "reggie-banks"]);
    expect(tidied[0].text).toBe("Pick two. Pick twenty-two.");
  });

  it("ends the interrupted line with an em dash when the editor forgot", () => {
    const tidied = tidyEditedTurns([
      turn("reggie-banks", "Two straight losses."),
      turn("mel-diaper", "FREE?!", { interrupts: true }),
    ]);
    expect(tidied[0].text).toBe("Two straight losses—");
    expect(tidied[1].interrupts).toBe(true);
  });

  it("leaves a locked line alone and drops the cut-in flag instead", () => {
    const tidied = tidyEditedTurns([
      turn("nina-sharpe", "Winner: Reggie.", { kind: "grade" }),
      turn("mel-diaper", "WHAT?!", { interrupts: true }),
    ]);
    expect(tidied[0].text).toBe("Winner: Reggie.");
    expect(tidied[1].interrupts).toBeUndefined();
  });

  it("never marks the first turn of a segment as a cut-in", () => {
    const tidied = tidyEditedTurns([turn("mel-diaper", "MIRAGE?!", { interrupts: true })]);
    expect(tidied[0].interrupts).toBeUndefined();
  });
});

describe("tool schemas sent to the API", () => {
  // The first live edit-bay run (2026-09-03) had every call rejected with
  // "For 'integer' type, property 'minimum' is not supported": a `.nonnegative()` on the
  // source-turn index became `minimum: 0` in the strict tool schema. Bounds belong in the
  // deterministic guard, never in the schema the API sees.
  it("carry no numeric bounds", () => {
    for (const schema of [EditedSegmentSchema, TurnOutputSchema]) {
      const json = JSON.stringify(zodToJsonSchema(schema, { $refStrategy: "none" }));
      expect(json).not.toMatch(/"(?:minimum|maximum|exclusiveMinimum|exclusiveMaximum|multipleOf)"/);
    }
  });
});
