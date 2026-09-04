import { describe, expect, it } from "vitest";
import { buildFactsBlock, serializeFacts } from "../src/lib/ai/facts";
import { fixturesByName, factsRequestFor } from "../src/lib/ai/__fixtures__/index";
import { computeCostUsd } from "../src/lib/ai/content-generation-service";
import { getPersona, getPersonaDisplay } from "../src/lib/ai/persona-prompts";
import { chooseHotSeat, fallbackQuestionFor } from "../src/lib/ai/disputed/question";
import { produceEpisode, renderTranscriptMarkdown } from "../src/lib/ai/disputed/producer";
import type { TurnCallRequest, TurnCallResult, TurnCaller } from "../src/lib/ai/disputed/producer";
import type { EditCaller } from "../src/lib/ai/disputed/edit-bay";
import { buildTurnSystemPrompt, directorInstructionFor, SHOW_RULES } from "../src/lib/ai/disputed/prompts";
import type { EditedTurn, ShowBrief, TurnOutput } from "../src/lib/ai/disputed/types";

/**
 * The `rich-week` fixture (spec BUILD 1 §7) built into a real `FactsBlock`, exactly the way
 * `content-generation-service.ts` would build one for an article. Every test in this file shares it.
 */
const fixture = fixturesByName["rich-week"];
const facts = buildFactsBlock(factsRequestFor(fixture, "weekly_recap"));
const factsText = serializeFacts(facts);

const brief: ShowBrief = {
  week: facts.league.week,
  hotSeat: {
    teamId: "T10",
    teamName: "Sable Ridge Sentinels",
    managerName: "Ruth Tanaka",
    why: "Nina Sharpe is warm on them (+22), Mel Diaper is at feud (-58)",
  },
  fallbackQuestion: "Is Ruth Tanaka doing enough for Sable Ridge Sentinels?",
  ledger: { "mel-diaper": { hits: 3, misses: 2 }, "reggie-banks": { hits: 4, misses: 1 } },
};

/** Pulls the `KIND: <kind>` marker `directorInstructionFor` puts at the top of every DIRECTOR block. */
function extractKind(req: TurnCallRequest): string {
  const match = req.user.match(/KIND: (\S+)/);
  if (!match) throw new Error(`test fake: no KIND marker found in director instruction:\n${req.user}`);
  return match[1];
}

/** A turn output with sane, verifier-safe defaults: no jab, one cited fact, nothing else set. */
function baseOutput(overrides: Partial<TurnOutput> = {}): TurnOutput {
  return { text: "Default turn text.", jab: false, factsCited: ["the box score"], ...overrides };
}

/** A `TurnCaller` keyed by (speaker, kind) via `script`; usage/model are fixed per test. */
function makeFakeCaller(
  script: (req: TurnCallRequest) => TurnOutput,
  usage: TurnCallResult["usage"] = { input: 100, output: 50 },
  model = "claude-opus-5"
): TurnCaller {
  return async (req: TurnCallRequest): Promise<TurnCallResult> => ({ output: script(req), usage, model });
}

/** Same as `makeFakeCaller`, but also pushes every request it sees onto `sink`, in call order. */
function makeCapturingCaller(
  script: (req: TurnCallRequest) => TurnOutput,
  sink: TurnCallRequest[],
  usage: TurnCallResult["usage"] = { input: 100, output: 50 },
  model = "claude-opus-5"
): TurnCaller {
  return async (req: TurnCallRequest): Promise<TurnCallResult> => {
    sink.push(req);
    return { output: script(req), usage, model };
  };
}

/** Extracts the exact text under the argument DIRECTOR's "YOUR LAST TURN" block, if present. */
function lastTurnBlockFrom(user: string): string | undefined {
  const match = user.match(/YOUR LAST TURN \(do not repeat[^)]*\)\n([\s\S]*?)\n\nOUTPUT CONTRACT/);
  return match?.[1];
}

/** A script covering every kind with the minimum each needs to stay verifier-clean and complete
 * (openings carry a claim, grade carries a verdict) so a test can override only what it cares about. */
function defaultScript(req: TurnCallRequest): TurnOutput {
  const kind = extractKind(req);
  if (kind === "cold_open") return baseOutput({ question: brief.fallbackQuestion });
  if (kind === "opening") {
    // Different `kind` per debater so the two default claims are never duplicates of one another
    // (isDuplicateClaim compares kind/subjectTeamId/opponentTeamId/week) — tests that care about
    // duplicate-claim handling build their own claims instead of using this default.
    return baseOutput({
      claim: { text: `${req.speaker}'s position.`, kind: req.speaker === "mel-diaper" ? "general" : "team_finish" },
    });
  }
  if (kind === "grade") return baseOutput({ verdict: { winner: "reggie-banks", reason: "the record backs him" } });
  return baseOutput();
}

describe("chooseHotSeat", () => {
  it("picks the manager with the widest relationship-tier spread across writers", () => {
    const relationshipsByWriter = {
      "mel-diaper": [
        {
          userId: "user_ruth",
          teamId: "team_10",
          teamName: "Sable Ridge Sentinels",
          managerName: "Ruth Tanaka",
          score: -58,
          tier: "feud" as const,
          recentEvents: [],
        },
      ],
      "nina-sharpe": [
        {
          userId: "user_ruth",
          teamId: "team_10",
          teamName: "Sable Ridge Sentinels",
          managerName: "Ruth Tanaka",
          score: 22,
          tier: "warm" as const,
          recentEvents: [],
        },
      ],
      // A narrower spread on a different manager must not win over the feud/warm split above.
      "dex-alvarez": [
        {
          userId: "user_dana",
          teamId: "team_01",
          teamName: "Gravel Pit Grinders",
          managerName: "Dana Whitlock",
          score: 5,
          tier: "neutral" as const,
          recentEvents: [],
        },
      ],
      "walt-brennan": [
        {
          userId: "user_dana",
          teamId: "team_01",
          teamName: "Gravel Pit Grinders",
          managerName: "Dana Whitlock",
          score: 8,
          tier: "warm" as const,
          recentEvents: [],
        },
      ],
    };

    const hotSeat = chooseHotSeat(facts, relationshipsByWriter);

    expect(hotSeat).not.toBeNull();
    expect(hotSeat!.teamId).toBe("T10");
    expect(hotSeat!.teamName).toBe("Sable Ridge Sentinels");
    expect(hotSeat!.managerName).toBe("Ruth Tanaka");
    expect(hotSeat!.why).toContain("Nina Sharpe");
    expect(hotSeat!.why).toContain("+22");
    expect(hotSeat!.why).toContain("Mel Diaper");
    expect(hotSeat!.why).toContain("-58");
    expect(fallbackQuestionFor(hotSeat!)).toBe("Is Ruth Tanaka doing enough for Sable Ridge Sentinels?");
  });

  it("falls back to the standings/matchup split when no writer has a relationship reading", () => {
    const hotSeat = chooseHotSeat(facts, {});

    expect(hotSeat).not.toBeNull();
    // Ninth Street Nightjars (T4) lost to Halyard Bay despite the 4th-best points-for in the
    // league — the biggest process-versus-results split in the rich-week fixture's week 7 slate.
    expect(hotSeat!.teamId).toBe("T4");
    expect(hotSeat!.teamName).toBe("Ninth Street Nightjars");
    expect(hotSeat!.managerName).toBe("Trevor Ashby");
    expect(hotSeat!.why).toContain("Ninth Street Nightjars lost by 23.7");
    expect(hotSeat!.why).toContain("4th-highest points for");
  });

  it("returns null with nothing to build an episode from", () => {
    const empty = buildFactsBlock(
      factsRequestFor({ ...fixture, leagueData: { ...fixture.leagueData, standings: [], recentMatchups: [] } }, "weekly_recap")
    );
    expect(chooseHotSeat(empty, {})).toBeNull();
  });
});

describe("produceEpisode — plain rundown", () => {
  it("runs cold open, openings, 8 alternating debater turns with redirects every 4, verdict, and last jabs", async () => {
    const call = makeFakeCaller(defaultScript);
    const { transcript, stats, claims } = await produceEpisode({
      facts,
      factsText,
      brief,
      relationshipsByWriter: {},
      call,
    });

    expect(transcript.schema).toBe("ffsn.transcript.v1");
    expect(transcript.show).toBe("disputed");
    expect(transcript.question).toBe(brief.fallbackQuestion);
    expect(transcript.hotSeat).toEqual(brief.hotSeat);
    expect(transcript.segments.map((segment) => segment.id)).toEqual([
      "cold_open",
      "opening_statements",
      "main_event",
      "verdict",
      "last_jabs",
    ]);

    expect(transcript.segments[0].turns.map((turn) => [turn.speaker, turn.kind])).toEqual([["curtis-vaughn", "cold_open"]]);
    expect(transcript.segments[1].turns.map((turn) => [turn.speaker, turn.kind])).toEqual([
      ["mel-diaper", "opening"],
      ["reggie-banks", "opening"],
    ]);

    // Default budgets (edit-bay follow-up, 2026-09-03): 8 debater turns, a redirect every 4 of them.
    // 8 is an exact multiple of 4, so the second redirect lands right after the very last argument
    // turn, before the segment hands off to the verdict.
    const mainEventSpeakers = transcript.segments[2].turns.map((turn) => turn.speaker);
    expect(mainEventSpeakers).toEqual([
      "mel-diaper",
      "reggie-banks",
      "mel-diaper",
      "reggie-banks",
      "curtis-vaughn",
      "mel-diaper",
      "reggie-banks",
      "mel-diaper",
      "reggie-banks",
      "curtis-vaughn",
    ]);
    expect(transcript.segments[2].turns.filter((turn) => turn.kind === "redirect")).toHaveLength(2);
    expect(transcript.segments[2].turns.filter((turn) => turn.kind === "argument")).toHaveLength(8);

    expect(transcript.segments[3].turns.map((turn) => [turn.speaker, turn.kind])).toEqual([
      ["nina-sharpe", "grade"],
      ["curtis-vaughn", "ledger"],
    ]);
    expect(transcript.segments[4].turns.map((turn) => [turn.speaker, turn.kind])).toEqual([
      ["mel-diaper", "jab"],
      ["reggie-banks", "jab"],
      ["curtis-vaughn", "close"],
    ]);

    expect(stats.redirects).toBe(2);
    expect(stats.dropped).toBe(0);
    expect(stats.retries).toBe(0);

    expect(claims.map((claim) => claim.persona).sort()).toEqual(["mel-diaper", "reggie-banks"]);
    expect(claims.every((claim) => claim.text.includes("position"))).toBe(true);
  });
});

describe("produceEpisode — witness calls", () => {
  it("routes a requested witness in immediately, then returns the floor to the other debater", async () => {
    const script = (req: TurnCallRequest): TurnOutput => {
      const kind = extractKind(req);
      if (kind === "argument" && req.speaker === "mel-diaper") {
        return baseOutput({ witnessRequested: "nina-sharpe" });
      }
      return defaultScript(req);
    };
    const call = makeFakeCaller(script);
    const { transcript, stats } = await produceEpisode({
      facts,
      factsText,
      brief,
      relationshipsByWriter: {},
      call,
      options: { budgets: { mainEvent: 2 } },
    });

    const mainEvent = transcript.segments.find((segment) => segment.id === "main_event")!;
    expect(mainEvent.turns.map((turn) => [turn.speaker, turn.kind])).toEqual([
      ["mel-diaper", "argument"],
      ["nina-sharpe", "witness"],
      ["reggie-banks", "argument"],
    ]);
    expect(stats.witnessCalls).toBe(1);
  });
});

describe("produceEpisode — heat", () => {
  it("redirects after three consecutive jab turns that cite no facts", async () => {
    let argumentCalls = 0;
    const script = (req: TurnCallRequest): TurnOutput => {
      const kind = extractKind(req);
      if (kind === "argument") {
        argumentCalls++;
        if (argumentCalls <= 3) return baseOutput({ jab: true, factsCited: [] });
        return baseOutput();
      }
      return defaultScript(req);
    };
    const call = makeFakeCaller(script);
    const { transcript } = await produceEpisode({
      facts,
      factsText,
      brief,
      relationshipsByWriter: {},
      call,
      // redirectEvery set high on purpose: this test is about the HEAT-triggered redirect (three
      // consecutive no-fact jabs), so the modulo-triggered redirect is pushed out of range rather
      // than left at its default — otherwise a future default change (edit-bay follow-up,
      // 2026-09-03: redirectEvery went 5→4, which collides with mainEvent 4 on its own) could add a
      // second, unrelated redirect this test isn't testing for.
      options: { budgets: { mainEvent: 4, redirectEvery: 10 } },
    });

    const mainEvent = transcript.segments.find((segment) => segment.id === "main_event")!;
    expect(mainEvent.turns.map((turn) => turn.kind)).toEqual(["argument", "argument", "argument", "redirect", "argument"]);
    expect(mainEvent.turns[3].speaker).toBe("curtis-vaughn");
  });
});

describe("produceEpisode — agreement cap", () => {
  it("keeps the first agreement and strips the second, and stats.agreements stays 1", async () => {
    const script = (req: TurnCallRequest): TurnOutput => {
      const kind = extractKind(req);
      if (kind === "argument") return baseOutput({ agreesWithOpponent: true });
      return defaultScript(req);
    };
    const call = makeFakeCaller(script);
    const { transcript, stats } = await produceEpisode({
      facts,
      factsText,
      brief,
      relationshipsByWriter: {},
      call,
      options: { budgets: { mainEvent: 2 } },
    });

    const mainEvent = transcript.segments.find((segment) => segment.id === "main_event")!;
    expect(mainEvent.turns[0].agreesWithOpponent).toBe(true);
    expect(mainEvent.turns[1].agreesWithOpponent).toBe(false);
    expect(stats.agreements).toBe(1);
  });
});

describe("produceEpisode — verification retry", () => {
  it("retries a turn once on a verifier block and keeps the clean retry", async () => {
    let melArgumentCalls = 0;
    const script = (req: TurnCallRequest): TurnOutput => {
      const kind = extractKind(req);
      if (kind === "argument" && req.speaker === "mel-diaper") {
        melArgumentCalls++;
        // "T3" reads as an internal id to the verifier (data_speak, always severity "block").
        if (melArgumentCalls === 1) return baseOutput({ text: "T3 has no answer for this." });
        return baseOutput({ text: "Clean answer on the retry." });
      }
      return defaultScript(req);
    };
    const call = makeFakeCaller(script);
    const { transcript, stats } = await produceEpisode({
      facts,
      factsText,
      brief,
      relationshipsByWriter: {},
      call,
      options: { budgets: { mainEvent: 2 } },
    });

    const mainEvent = transcript.segments.find((segment) => segment.id === "main_event")!;
    const melTurn = mainEvent.turns.find((turn) => turn.speaker === "mel-diaper")!;
    expect(melTurn.text).toBe("Clean answer on the retry.");
    expect(melTurn.retried).toBe(true);
    expect(stats.retries).toBe(1);
    expect(stats.dropped).toBe(0);
    expect(melArgumentCalls).toBe(2);
  });

  it("drops a turn that blocks twice and gives Curtis a redirect in its place", async () => {
    const script = (req: TurnCallRequest): TurnOutput => {
      const kind = extractKind(req);
      if (kind === "argument" && req.speaker === "mel-diaper") {
        // Blocks on both the first attempt and the retry.
        return baseOutput({ text: "T3 never learns." });
      }
      return defaultScript(req);
    };
    const call = makeFakeCaller(script);
    const { transcript, stats } = await produceEpisode({
      facts,
      factsText,
      brief,
      relationshipsByWriter: {},
      call,
      options: { budgets: { mainEvent: 2 } },
    });

    const mainEvent = transcript.segments.find((segment) => segment.id === "main_event")!;
    expect(mainEvent.turns.map((turn) => [turn.speaker, turn.kind])).toEqual([
      ["curtis-vaughn", "redirect"],
      ["reggie-banks", "argument"],
    ]);
    expect(stats.dropped).toBe(1);
    expect(stats.retries).toBe(1);
  });
});

describe("produceEpisode — cost accrual", () => {
  it("sums usage and cost across every call via computeCostUsd", async () => {
    const usage = { input: 100, output: 50 };
    const model = "claude-opus-5";
    const call = makeFakeCaller(defaultScript, usage, model);
    const { stats } = await produceEpisode({
      facts,
      factsText,
      brief,
      relationshipsByWriter: {},
      call,
      options: { budgets: { mainEvent: 2 } },
    });

    // cold_open(1) + opening(2) + main_event(2) + grade(1) + ledger(1) + jab(2) + close(1) = 10 calls.
    const expectedCalls = 10;
    expect(stats.promptTokens).toBe(usage.input * expectedCalls);
    expect(stats.completionTokens).toBe(usage.output * expectedCalls);
    expect(stats.costUsd).toBeCloseTo(
      computeCostUsd(model, { input_tokens: usage.input * expectedCalls, output_tokens: usage.output * expectedCalls }),
      8
    );
    expect(stats.modelsUsed).toEqual([model]);
  });
});

describe("renderTranscriptMarkdown", () => {
  it("contains every segment heading and a speaker plate for each turn", async () => {
    const call = makeFakeCaller(defaultScript);
    const { transcript } = await produceEpisode({
      facts,
      factsText,
      brief,
      relationshipsByWriter: {},
      call,
      options: { budgets: { mainEvent: 2 } },
    });

    const markdown = renderTranscriptMarkdown(transcript);

    expect(markdown).toContain("# Disputed · Week");
    for (const heading of ["## Cold Open", "## Opening Statements", "## Main Event", "## Verdict", "## Last Jabs"]) {
      expect(markdown).toContain(heading);
    }

    const curtis = getPersonaDisplay("curtis-vaughn");
    expect(markdown).toContain(`**${curtis.name} (${curtis.role}):**`);
    const mel = getPersonaDisplay("mel-diaper");
    expect(markdown).toContain(`**${mel.name} (${mel.role}):**`);
  });
});

describe("produceEpisode — catchphrase placement", () => {
  it("retries a non-jab Reggie turn that uses the catchphrase, and keeps a clean retry", async () => {
    let reggieArgumentCalls = 0;
    const script = (req: TurnCallRequest): TurnOutput => {
      const kind = extractKind(req);
      if (kind === "argument" && req.speaker === "reggie-banks") {
        reggieArgumentCalls++;
        if (reggieArgumentCalls === 1) {
          return baseOutput({ text: "Trevor wins in Week 8. You can take that to the bank." });
        }
        return baseOutput({ text: "Trevor wins in Week 8. Scoreboard." });
      }
      return defaultScript(req);
    };
    const call = makeFakeCaller(script);
    const { transcript, stats } = await produceEpisode({
      facts,
      factsText,
      brief,
      relationshipsByWriter: {},
      call,
      options: { budgets: { mainEvent: 2 } },
    });

    const mainEvent = transcript.segments.find((segment) => segment.id === "main_event")!;
    const reggieTurn = mainEvent.turns.find((turn) => turn.speaker === "reggie-banks")!;
    expect(reggieTurn.text).toBe("Trevor wins in Week 8. Scoreboard.");
    expect(reggieTurn.retried).toBe(true);
    expect(stats.catchphraseStripped).toBe(0);
    expect(stats.retries).toBe(0); // this retry is the catchphrase path, not the verifier-block path
    expect(reggieArgumentCalls).toBe(2);
  });

  it("strips the catchphrase sentence when it survives the retry, and records a warn violation", async () => {
    const script = (req: TurnCallRequest): TurnOutput => {
      const kind = extractKind(req);
      if (kind === "argument" && req.speaker === "reggie-banks") {
        // Both attempts use it — it must never reach the transcript outside the last jab.
        return baseOutput({ text: "Trevor wins in Week 8. You can take that to the bank. Scoreboard." });
      }
      return defaultScript(req);
    };
    const call = makeFakeCaller(script);
    const { transcript, stats } = await produceEpisode({
      facts,
      factsText,
      brief,
      relationshipsByWriter: {},
      call,
      options: { budgets: { mainEvent: 2 } },
    });

    const mainEvent = transcript.segments.find((segment) => segment.id === "main_event")!;
    const reggieTurn = mainEvent.turns.find((turn) => turn.speaker === "reggie-banks")!;
    expect(reggieTurn.text.toLowerCase()).not.toContain("take that to the bank");
    expect(reggieTurn.text).toContain("Scoreboard.");
    expect(stats.catchphraseStripped).toBe(1);
    expect(
      stats.violations.some((violation) => violation.kind === "catchphrase_stripped" && violation.speaker === "reggie-banks")
    ).toBe(true);
  });

  it("still lets Reggie use the catchphrase in his last jab", async () => {
    const script = (req: TurnCallRequest): TurnOutput => {
      const kind = extractKind(req);
      if (kind === "jab" && req.speaker === "reggie-banks") {
        return baseOutput({ text: "Trevor's 5-3 by Sunday. You can take that to the bank." });
      }
      return defaultScript(req);
    };
    const call = makeFakeCaller(script);
    const { transcript, stats } = await produceEpisode({
      facts,
      factsText,
      brief,
      relationshipsByWriter: {},
      call,
      options: { budgets: { mainEvent: 2 } },
    });

    const lastJabs = transcript.segments.find((segment) => segment.id === "last_jabs")!;
    const reggieJab = lastJabs.turns.find((turn) => turn.speaker === "reggie-banks")!;
    expect(reggieJab.text).toContain("You can take that to the bank.");
    expect(stats.catchphraseStripped).toBe(0);
  });
});

describe("SHOW_RULES — repetition guidance", () => {
  it("caps a debater's two-word sign-off and restricts predictions to the opening and the last jab", () => {
    expect(SHOW_RULES).toContain("two-word sign-off");
    expect(SHOW_RULES).toContain("at most twice across the whole episode");
    expect(SHOW_RULES).toContain("A prediction is stated once");
    expect(SHOW_RULES).toContain("restated once, in the last jab");
  });
});

describe("directorInstructionFor — argument repetition guard", () => {
  it("includes the speaker's previous turn and the no-repeat instruction when previousTurnText is given", () => {
    const instruction = directorInstructionFor("argument", {
      brief,
      question: "Is Trevor Ashby a contender?",
      agreementsUsed: 0,
      previousTurnText: "Week 8, Quarry Road, he wins and he's 5-3. Scoreboard.",
    });
    expect(instruction).toContain("YOUR LAST TURN");
    expect(instruction).toContain("do not repeat its prediction, its closing line, or its sign-off");
    expect(instruction).toContain("advance the argument with a fact you have not used yet");
    expect(instruction).toContain("Week 8, Quarry Road, he wins and he's 5-3. Scoreboard.");
  });

  it("omits the block entirely when there is no previous turn yet", () => {
    const instruction = directorInstructionFor("argument", {
      brief,
      question: "Is Trevor Ashby a contender?",
      agreementsUsed: 0,
    });
    expect(instruction).not.toContain("YOUR LAST TURN");
  });
});

describe("produceEpisode — repetition guard threading", () => {
  it("passes each debater's own previous turn (not the opponent's, not the whole transcript) into their next argument instruction", async () => {
    const requests: TurnCallRequest[] = [];
    let melArgumentCount = 0;
    const script = (req: TurnCallRequest): TurnOutput => {
      const kind = extractKind(req);
      if (kind === "opening" && req.speaker === "mel-diaper") {
        return baseOutput({ text: "MEL OPENING STATEMENT TEXT.", claim: { text: "Mel's position.", kind: "general" } });
      }
      if (kind === "argument" && req.speaker === "mel-diaper") {
        melArgumentCount++;
        return baseOutput({ text: `MEL ARGUMENT NUMBER ${melArgumentCount}.` });
      }
      return defaultScript(req);
    };
    const call = makeCapturingCaller(script, requests);
    await produceEpisode({
      facts,
      factsText,
      brief,
      relationshipsByWriter: {},
      call,
      options: { budgets: { mainEvent: 4 } },
    });

    const melArgumentRequests = requests.filter((req) => req.speaker === "mel-diaper" && extractKind(req) === "argument");
    expect(melArgumentRequests).toHaveLength(2);
    // Mel's first argument turn sees his OPENING statement as "YOUR LAST TURN"...
    expect(lastTurnBlockFrom(melArgumentRequests[0].user)).toBe("MEL OPENING STATEMENT TEXT.");
    // ...and his second sees his own first argument turn — never Reggie's, and never re-shown the opening.
    expect(lastTurnBlockFrom(melArgumentRequests[1].user)).toBe("MEL ARGUMENT NUMBER 1.");
  });
});

describe("produceEpisode — cold open word ceiling", () => {
  it("raises the host ceiling to 70 words for the cold open only; redirect/ledger/close stay at 45", async () => {
    const requests: TurnCallRequest[] = [];
    const script = (req: TurnCallRequest): TurnOutput => {
      const kind = extractKind(req);
      if (kind === "cold_open") {
        // 90 words: over the old 45-word host ceiling's 1.5x (67.5), under the new 70-word
        // ceiling's 1.5x (105) — must not warn now that cold_open carries the raised ceiling.
        return baseOutput({ text: Array(90).fill("word").join(" "), question: brief.fallbackQuestion });
      }
      return defaultScript(req);
    };
    const call = makeCapturingCaller(script, requests);
    const { stats } = await produceEpisode({
      facts,
      factsText,
      brief,
      relationshipsByWriter: {},
      call,
      options: { budgets: { mainEvent: 2 } },
    });

    const coldOpenCeilingWarning = stats.violations.find(
      (violation) => violation.speaker === "curtis-vaughn" && violation.kind === "cold_open" && violation.detail.includes("ceiling")
    );
    expect(coldOpenCeilingWarning).toBeUndefined();

    const coldOpenRequest = requests.find((req) => extractKind(req) === "cold_open")!;
    expect(coldOpenRequest.user).toContain("host turns stay under 70 words");

    const ledgerRequest = requests.find((req) => extractKind(req) === "ledger")!;
    expect(ledgerRequest.user).toContain("host turns stay under 45 words");
    const closeRequest = requests.find((req) => extractKind(req) === "close")!;
    expect(closeRequest.user).toContain("host turns stay under 45 words");
  });
});

describe("produceEpisode — prompt caching split", () => {
  it("sends FACTS as a shared systemPrefix, keeps each speaker's own system prompt stable, and never repeats FACTS in the user turn", async () => {
    const requests: TurnCallRequest[] = [];
    const call = makeCapturingCaller(defaultScript, requests);
    await produceEpisode({
      facts,
      factsText,
      brief,
      relationshipsByWriter: {},
      call,
      options: { budgets: { mainEvent: 2 } },
    });

    expect(requests.length).toBeGreaterThan(1);

    // FACTS is byte-identical across every call, for every speaker — this is what makes it
    // cacheable as one shared prefix (pilot follow-up, 2026-09-03: keyed after the per-speaker
    // system prompt instead, it was a separate ~30k-token cache write per speaker). And it must
    // never also ride along in the user turn, or every call pays for it uncached there instead.
    for (const req of requests) {
      expect(req.systemPrefix).toBe(factsText);
      expect(req.user).not.toContain("<FACTS>");
      expect(req.user).not.toContain("ffsn.facts.v1");
    }

    // Each speaker's own per-speaker system prompt (contract + who-you-are + relationships + show
    // rules + role) is the exact same string every time that speaker is called...
    const systemsBySpeaker = new Map<string, Set<string>>();
    for (const req of requests) {
      const seen = systemsBySpeaker.get(req.speaker) ?? new Set<string>();
      seen.add(req.system);
      systemsBySpeaker.set(req.speaker, seen);
    }
    for (const [speaker, systems] of systemsBySpeaker) {
      expect(systems.size, `${speaker}'s system prompt changed between calls`).toBe(1);
    }
    // ...and it differs from another speaker's (Curtis's identity/role text isn't Mel's).
    const curtisSystem = requests.find((req) => req.speaker === "curtis-vaughn")!.system;
    const melSystem = requests.find((req) => req.speaker === "mel-diaper")!.system;
    expect(curtisSystem).not.toBe(melSystem);

    // The user turn still carries what changes every call (at minimum, a different DIRECTOR kind).
    const coldOpenUser = requests.find((req) => extractKind(req) === "cold_open")!.user;
    const openingUser = requests.find((req) => extractKind(req) === "opening")!.user;
    expect(coldOpenUser).not.toBe(openingUser);
  });
});

describe("produceEpisode — sides", () => {
  it("captures the cold open's sides and stores them on the transcript", async () => {
    const givenSides = {
      "mel-diaper": "The process says Trevor is a fraud.",
      "reggie-banks": "The scoreboard says Trevor is a contender.",
    };
    const script = (req: TurnCallRequest): TurnOutput => {
      const kind = extractKind(req);
      if (kind === "cold_open") return baseOutput({ question: brief.fallbackQuestion, sides: givenSides });
      return defaultScript(req);
    };
    const call = makeFakeCaller(script);
    const { transcript } = await produceEpisode({
      facts,
      factsText,
      brief,
      relationshipsByWriter: {},
      call,
      options: { budgets: { mainEvent: 2 } },
    });

    expect(transcript.sides).toEqual(givenSides);
  });

  it("derives a deterministic fallback pair of sides when the cold open returns none", async () => {
    // defaultScript's cold_open never sets `sides`.
    const call = makeFakeCaller(defaultScript);
    const { transcript } = await produceEpisode({
      facts,
      factsText,
      brief,
      relationshipsByWriter: {},
      call,
      options: { budgets: { mainEvent: 2 } },
    });

    const team = facts.teams.find((candidate) => candidate.id === brief.hotSeat.teamId);
    const expectedReggieSide = team?.record
      ? `The scoreboard says yes: judge the ${brief.hotSeat.teamName} on results, and the results are ${team.record}.`
      : `The scoreboard says yes: judge the ${brief.hotSeat.teamName} on results.`;

    expect(transcript.sides).toEqual({
      "mel-diaper": `The process says no: judge the ${brief.hotSeat.teamName} on the draft board and the lineup card its GM set, not the standings.`,
      "reggie-banks": expectedReggieSide,
    });
  });
});

describe("produceEpisode — sides threading into opening instructions", () => {
  it("gives each debater YOUR SIDE, and gives Reggie MEL'S OPENING with Mel's claim", async () => {
    const requests: TurnCallRequest[] = [];
    const givenSides = { "mel-diaper": "The process says no.", "reggie-banks": "The scoreboard says yes." };
    const script = (req: TurnCallRequest): TurnOutput => {
      const kind = extractKind(req);
      if (kind === "cold_open") return baseOutput({ question: brief.fallbackQuestion, sides: givenSides });
      if (kind === "opening" && req.speaker === "mel-diaper") {
        return baseOutput({ text: "MEL SAYS FRAUD.", claim: { text: "Mel's claim text.", kind: "general" } });
      }
      return defaultScript(req);
    };
    const call = makeCapturingCaller(script, requests);
    await produceEpisode({
      facts,
      factsText,
      brief,
      relationshipsByWriter: {},
      call,
      options: { budgets: { mainEvent: 2 } },
    });

    const melOpeningRequest = requests.find((req) => req.speaker === "mel-diaper" && extractKind(req) === "opening")!;
    expect(melOpeningRequest.user).toContain(`YOUR SIDE: ${givenSides["mel-diaper"]}`);

    const reggieOpeningRequest = requests.find((req) => req.speaker === "reggie-banks" && extractKind(req) === "opening")!;
    expect(reggieOpeningRequest.user).toContain(`YOUR SIDE: ${givenSides["reggie-banks"]}`);
    expect(reggieOpeningRequest.user).toContain("MEL'S OPENING");
    expect(reggieOpeningRequest.user).toContain("MEL SAYS FRAUD.");
    expect(reggieOpeningRequest.user).toContain("Mel's claim text.");
  });
});

describe("produceEpisode — sides threading into argument instructions", () => {
  it("includes YOUR SIDE and OPPONENT'S SIDE in every argument instruction", async () => {
    const requests: TurnCallRequest[] = [];
    const givenSides = { "mel-diaper": "The process says no.", "reggie-banks": "The scoreboard says yes." };
    const script = (req: TurnCallRequest): TurnOutput => {
      const kind = extractKind(req);
      if (kind === "cold_open") return baseOutput({ question: brief.fallbackQuestion, sides: givenSides });
      return defaultScript(req);
    };
    const call = makeCapturingCaller(script, requests);
    await produceEpisode({
      facts,
      factsText,
      brief,
      relationshipsByWriter: {},
      call,
      options: { budgets: { mainEvent: 2 } },
    });

    const melArgument = requests.find((req) => req.speaker === "mel-diaper" && extractKind(req) === "argument")!;
    expect(melArgument.user).toContain(`YOUR SIDE: ${givenSides["mel-diaper"]}`);
    expect(melArgument.user).toContain(`OPPONENT'S SIDE: ${givenSides["reggie-banks"]}`);

    const reggieArgument = requests.find((req) => req.speaker === "reggie-banks" && extractKind(req) === "argument")!;
    expect(reggieArgument.user).toContain(`YOUR SIDE: ${givenSides["reggie-banks"]}`);
    expect(reggieArgument.user).toContain(`OPPONENT'S SIDE: ${givenSides["mel-diaper"]}`);
  });
});

describe("produceEpisode — opposed claims", () => {
  it("retries Reggie's opening once when it duplicates Mel's claim, and keeps both claims once he takes the other side", async () => {
    let reggieOpeningCalls = 0;
    const script = (req: TurnCallRequest): TurnOutput => {
      const kind = extractKind(req);
      if (kind === "cold_open") return baseOutput({ question: brief.fallbackQuestion });
      if (kind === "opening" && req.speaker === "mel-diaper") {
        return baseOutput({ claim: { text: "Mel's prediction.", kind: "general" } });
      }
      if (kind === "opening" && req.speaker === "reggie-banks") {
        reggieOpeningCalls++;
        if (reggieOpeningCalls === 1) {
          // Same kind, no subject/opponent/week — a duplicate of Mel's claim by isDuplicateClaim.
          return baseOutput({ claim: { text: "Reggie's rebuttal.", kind: "general" } });
        }
        return baseOutput({ claim: { text: "Reggie's real prediction.", kind: "team_finish" } });
      }
      return defaultScript(req);
    };
    const call = makeFakeCaller(script);
    const { transcript, stats, claims } = await produceEpisode({
      facts,
      factsText,
      brief,
      relationshipsByWriter: {},
      call,
      options: { budgets: { mainEvent: 2 } },
    });

    const reggieOpening = transcript.segments
      .find((segment) => segment.id === "opening_statements")!
      .turns.find((turn) => turn.speaker === "reggie-banks")!;
    expect(reggieOpening.retried).toBe(true);
    expect(reggieOpening.claim?.text).toBe("Reggie's real prediction.");
    expect(stats.duplicateClaimsDropped).toBe(0);
    expect(stats.violations.some((violation) => violation.kind === "duplicate_claim")).toBe(false);
    expect(claims.map((claim) => claim.persona).sort()).toEqual(["mel-diaper", "reggie-banks"]);
    expect(reggieOpeningCalls).toBe(2);
  });

  it("drops Reggie's claim when it duplicates Mel's twice, keeps the turn text, and records one duplicate_claim warn", async () => {
    const script = (req: TurnCallRequest): TurnOutput => {
      const kind = extractKind(req);
      if (kind === "cold_open") return baseOutput({ question: brief.fallbackQuestion });
      if (kind === "opening" && req.speaker === "mel-diaper") {
        return baseOutput({ claim: { text: "Mel's prediction.", kind: "general" } });
      }
      if (kind === "opening" && req.speaker === "reggie-banks") {
        // Duplicates Mel's claim on both the first attempt and the retry.
        return baseOutput({
          text: "Reggie's argument text stands even without a claim.",
          claim: { text: "Reggie's rebuttal.", kind: "general" },
        });
      }
      return defaultScript(req);
    };
    const call = makeFakeCaller(script);
    const { transcript, stats, claims } = await produceEpisode({
      facts,
      factsText,
      brief,
      relationshipsByWriter: {},
      call,
      options: { budgets: { mainEvent: 2 } },
    });

    const reggieOpening = transcript.segments
      .find((segment) => segment.id === "opening_statements")!
      .turns.find((turn) => turn.speaker === "reggie-banks")!;
    expect(reggieOpening.claim).toBeUndefined();
    expect(reggieOpening.text).toBe("Reggie's argument text stands even without a claim.");
    expect(stats.duplicateClaimsDropped).toBe(1);
    expect(stats.violations.filter((violation) => violation.kind === "duplicate_claim")).toHaveLength(1);
    expect(claims.map((claim) => claim.persona)).toEqual(["mel-diaper"]);
  });
});

describe("produceEpisode — call failures", () => {
  it("drops a turn whose call throws once, gives Curtis a redirect, and the episode completes", async () => {
    let melArgumentCalls = 0;
    const script = (req: TurnCallRequest): TurnOutput => {
      const kind = extractKind(req);
      if (kind === "argument" && req.speaker === "mel-diaper") {
        melArgumentCalls++;
        if (melArgumentCalls === 1) throw new Error("Connection error.");
      }
      return defaultScript(req);
    };
    const call = makeFakeCaller(script);
    const { transcript, stats } = await produceEpisode({
      facts,
      factsText,
      brief,
      relationshipsByWriter: {},
      call,
      options: { budgets: { mainEvent: 2 } },
    });

    const mainEvent = transcript.segments.find((segment) => segment.id === "main_event")!;
    expect(mainEvent.turns.map((turn) => [turn.speaker, turn.kind])).toEqual([
      ["curtis-vaughn", "redirect"],
      ["reggie-banks", "argument"],
    ]);
    expect(stats.dropped).toBe(1);
    expect(stats.violations.filter((violation) => violation.kind === "call_failed")).toHaveLength(1);
  });

  it("rejects after three consecutive call failures, with no infinite loop", async () => {
    const script = (): TurnOutput => {
      throw new Error("Connection error.");
    };
    const call = makeFakeCaller(script);

    await expect(
      produceEpisode({
        facts,
        factsText,
        brief,
        relationshipsByWriter: {},
        call,
        options: { budgets: { mainEvent: 2 } },
      })
    ).rejects.toThrow(/consecutive failed turn calls/);
  });

  it("survives two consecutive call failures (under the abort threshold) and completes with dropped 2", async () => {
    let callCount = 0;
    const script = (req: TurnCallRequest): TurnOutput => {
      callCount++;
      if (callCount <= 2) throw new Error("Connection error.");
      return defaultScript(req);
    };
    const call = makeFakeCaller(script);

    const { stats } = await produceEpisode({
      facts,
      factsText,
      brief,
      relationshipsByWriter: {},
      call,
      options: { budgets: { mainEvent: 2 } },
    });

    expect(stats.dropped).toBe(2);
    expect(stats.violations.filter((violation) => violation.kind === "call_failed")).toHaveLength(2);
  });
});

describe("produceEpisode — naturalize (edit bay) integration", () => {
  // With budgets.mainEvent: 2, every turn `defaultScript` produces uses `baseOutput()`'s untouched
  // default text ("Default turn text.") — cold_open's own text included, since only its "question"
  // field is overridden. That makes every segment's speaker sequence exactly this, in order.
  const SEGMENT_SPEAKERS: Record<string, string[]> = {
    cold_open: ["curtis-vaughn"],
    opening_statements: ["mel-diaper", "reggie-banks"],
    main_event: ["mel-diaper", "reggie-banks"],
    verdict: ["nina-sharpe", "curtis-vaughn"],
    last_jabs: ["mel-diaper", "reggie-banks", "curtis-vaughn"],
  };

  /** Echoes every turn back verbatim (so the guard always accepts it), marking main_event's second turn as cutting in on the first. */
  const fakeEditCaller: EditCaller = async (req) => {
    const speakers = SEGMENT_SPEAKERS[req.segmentId] ?? [];
    const turns: EditedTurn[] = speakers.map((speaker, index) => ({
      sourceTurn: index,
      speaker,
      text: "Default turn text.",
      interrupts: req.segmentId === "main_event" && index === 1 ? true : undefined,
    }));
    return { output: { turns }, usage: { input: 10, output: 5 }, model: "claude-sonnet-5" };
  };

  it("runs the edit bay, returns rawTranscript separately from the edited transcript, and carries interrupts", async () => {
    const call = makeFakeCaller(defaultScript);

    const result = await produceEpisode({
      facts,
      factsText,
      brief,
      relationshipsByWriter: {},
      call,
      options: { budgets: { mainEvent: 2 }, naturalize: { call: fakeEditCaller } },
    });

    expect(result.rawTranscript).not.toBe(result.transcript);
    expect(result.rawTranscript.edited).toBeUndefined();
    expect(result.transcript.edited).toBeDefined();
    expect(result.transcript.edited?.pass).toBe("edit-bay-v1");
    expect(result.transcript.edited?.segmentsRejected).toBe(0);
    expect(result.transcript.edited?.segmentsEdited).toBe(result.transcript.segments.length);

    const mainEvent = result.transcript.segments.find((segment) => segment.id === "main_event")!;
    expect(mainEvent.turns[1].interrupts).toBe(true);
    expect(mainEvent.turns[0].interrupts).toBeUndefined();
    // The tidy pass makes the interrupted line end on an em dash.
    expect(mainEvent.turns[0].text).toBe("Default turn text—");
    // Copied over from the source turn untouched.
    expect(mainEvent.turns[0].speaker).toBe("mel-diaper");
    expect(mainEvent.turns[0].kind).toBe("argument");
    expect(mainEvent.turns[1].speaker).toBe("reggie-banks");

    const rawMainEvent = result.rawTranscript.segments.find((segment) => segment.id === "main_event")!;
    expect(rawMainEvent.turns.every((turn) => !turn.interrupts)).toBe(true);
  });

  it("without options.naturalize, rawTranscript is the exact same object as transcript", async () => {
    const call = makeFakeCaller(defaultScript);
    const result = await produceEpisode({
      facts,
      factsText,
      brief,
      relationshipsByWriter: {},
      call,
      options: { budgets: { mainEvent: 2 } },
    });
    expect(result.rawTranscript).toBe(result.transcript);
  });
});

describe("produceEpisode — transcript.language", () => {
  it("defaults to clean when the brief carries no languageRating", async () => {
    const call = makeFakeCaller(defaultScript);
    const { transcript } = await produceEpisode({
      facts,
      factsText,
      brief,
      relationshipsByWriter: {},
      call,
      options: { budgets: { mainEvent: 2 } },
    });
    expect(transcript.language).toBe("clean");
  });

  it("carries the brief's languageRating onto the transcript", async () => {
    const call = makeFakeCaller(defaultScript);
    const { transcript } = await produceEpisode({
      facts,
      factsText,
      brief: { ...brief, languageRating: "salty" },
      relationshipsByWriter: {},
      call,
      options: { budgets: { mainEvent: 2 } },
    });
    expect(transcript.language).toBe("salty");
  });
});

describe("buildTurnSystemPrompt — house style / language", () => {
  it("puts the house style block right after the grounding contract and before WHO YOU ARE", () => {
    const persona = getPersona("mel-diaper");
    const system = buildTurnSystemPrompt(persona, facts, "role rules", brief);
    const contractIndex = system.indexOf("GROUNDING CONTRACT");
    const houseStyleIndex = system.indexOf("HOUSE STYLE");
    const whoYouAreIndex = system.indexOf("WHO YOU ARE");

    expect(contractIndex).toBe(0);
    expect(houseStyleIndex).toBeGreaterThan(contractIndex);
    expect(whoYouAreIndex).toBeGreaterThan(houseStyleIndex);
  });

  it("includes the salty tier text for a salty brief and omits it for a clean one", () => {
    const persona = getPersona("mel-diaper");
    const saltySystem = buildTurnSystemPrompt(persona, facts, "role rules", { ...brief, languageRating: "salty" });
    expect(saltySystem).toContain("salty: Mild profanity is allowed");

    const cleanSystem = buildTurnSystemPrompt(persona, facts, "role rules", brief);
    expect(cleanSystem).not.toContain("salty: Mild profanity is allowed");
    expect(cleanSystem).toContain("clean: No profanity of any kind.");
  });

  it("includes the show-surface language line", () => {
    const persona = getPersona("mel-diaper");
    const system = buildTurnSystemPrompt(persona, facts, "role rules", brief);
    expect(system).toContain("In the show, cut-ins and reactions follow the same rating.");
  });
});

describe("produceEpisode — language rating enforcement", () => {
  it("Mel saying 'damn' at clean rating gets one retry naming the language rating, and when the retry still says it the offending sentence is removed", async () => {
    const requests: TurnCallRequest[] = [];
    const script = (req: TurnCallRequest): TurnOutput => {
      const kind = extractKind(req);
      if (kind === "argument" && req.speaker === "mel-diaper") {
        // Same response every call: the retry "still says it".
        return baseOutput({ text: "Two picks in and nothing to show for it. That lineup call was damn near criminal." });
      }
      return defaultScript(req);
    };
    const call = makeCapturingCaller(script, requests);
    const { transcript, stats } = await produceEpisode({
      facts,
      factsText,
      brief, // languageRating undefined -> defaults to "clean"
      relationshipsByWriter: {},
      call,
      options: { budgets: { mainEvent: 2 } },
    });

    const melArgumentRequests = requests.filter((req) => req.speaker === "mel-diaper" && extractKind(req) === "argument");
    expect(melArgumentRequests).toHaveLength(2);
    expect(melArgumentRequests[1].user).toContain("language rating");

    const mainEvent = transcript.segments.find((segment) => segment.id === "main_event")!;
    const melTurn = mainEvent.turns.find((turn) => turn.speaker === "mel-diaper")!;
    expect(melTurn.text).toBe("Two picks in and nothing to show for it.");
    expect(melTurn.retried).toBe(true);
    expect(stats.languageStripped).toBe(1);
    expect(
      stats.violations.filter((violation) => violation.kind === "language_stripped" && violation.speaker === "mel-diaper")
    ).toHaveLength(1);
  });

  it("the same mild word at salty rating passes without a retry", async () => {
    const requests: TurnCallRequest[] = [];
    const script = (req: TurnCallRequest): TurnOutput => {
      const kind = extractKind(req);
      if (kind === "argument" && req.speaker === "mel-diaper") {
        return baseOutput({ text: "That lineup call was damn near criminal." });
      }
      return defaultScript(req);
    };
    const call = makeCapturingCaller(script, requests);
    const { transcript, stats } = await produceEpisode({
      facts,
      factsText,
      brief: { ...brief, languageRating: "salty" },
      relationshipsByWriter: {},
      call,
      options: { budgets: { mainEvent: 2 } },
    });

    const melArgumentRequests = requests.filter((req) => req.speaker === "mel-diaper" && extractKind(req) === "argument");
    expect(melArgumentRequests).toHaveLength(1);

    const mainEvent = transcript.segments.find((segment) => segment.id === "main_event")!;
    const melTurn = mainEvent.turns.find((turn) => turn.speaker === "mel-diaper")!;
    expect(melTurn.text).toBe("That lineup call was damn near criminal.");
    expect(melTurn.retried).toBeUndefined();
    expect(stats.languageStripped).toBe(0);
  });

  it("a strong word at salty rating is retried", async () => {
    const requests: TurnCallRequest[] = [];
    let melArgumentCalls = 0;
    const script = (req: TurnCallRequest): TurnOutput => {
      const kind = extractKind(req);
      if (kind === "argument" && req.speaker === "mel-diaper") {
        melArgumentCalls++;
        if (melArgumentCalls === 1) return baseOutput({ text: "That whole draft was bullshit." });
        return baseOutput({ text: "That whole draft was indefensible." });
      }
      return defaultScript(req);
    };
    const call = makeCapturingCaller(script, requests);
    const { transcript, stats } = await produceEpisode({
      facts,
      factsText,
      brief: { ...brief, languageRating: "salty" },
      relationshipsByWriter: {},
      call,
      options: { budgets: { mainEvent: 2 } },
    });

    const melArgumentRequests = requests.filter((req) => req.speaker === "mel-diaper" && extractKind(req) === "argument");
    expect(melArgumentRequests).toHaveLength(2);
    expect(melArgumentRequests[1].user).toContain("language rating");

    const mainEvent = transcript.segments.find((segment) => segment.id === "main_event")!;
    const melTurn = mainEvent.turns.find((turn) => turn.speaker === "mel-diaper")!;
    expect(melTurn.text).toBe("That whole draft was indefensible.");
    expect(melTurn.retried).toBe(true);
    expect(stats.languageStripped).toBe(0);
    expect(melArgumentCalls).toBe(2);
  });

  it("Curtis gets his one at unfiltered — the first mild word is kept, a second Curtis turn with one is retried against his per-episode allowance", async () => {
    const requests: TurnCallRequest[] = [];
    let curtisCloseCalls = 0;
    const script = (req: TurnCallRequest): TurnOutput => {
      const kind = extractKind(req);
      if (kind === "cold_open") {
        return baseOutput({ question: brief.fallbackQuestion, text: "Good evening. Well, hell. Let's go to the board." });
      }
      if (kind === "close" && req.speaker === "curtis-vaughn") {
        curtisCloseCalls++;
        if (curtisCloseCalls === 1) return baseOutput({ text: "Well, that was a damn fine debate tonight." });
        return baseOutput({ text: "Well, that was one heck of a debate tonight." });
      }
      return defaultScript(req);
    };
    const call = makeCapturingCaller(script, requests);
    const { transcript, stats } = await produceEpisode({
      facts,
      factsText,
      brief: { ...brief, languageRating: "unfiltered" },
      relationshipsByWriter: {},
      call,
      options: { budgets: { mainEvent: 2 } },
    });

    // The cold open's "hell" is his one for the night: kept verbatim, one call, no retry.
    const coldOpen = transcript.segments.find((segment) => segment.id === "cold_open")!.turns[0];
    expect(coldOpen.text).toContain("Well, hell.");
    expect(coldOpen.retried).toBeUndefined();
    expect(requests.filter((req) => extractKind(req) === "cold_open")).toHaveLength(1);

    // The close would be his second: retried once naming the allowance, and the clean retry kept.
    const curtisCloseRequests = requests.filter((req) => req.speaker === "curtis-vaughn" && extractKind(req) === "close");
    expect(curtisCloseRequests).toHaveLength(2);
    expect(curtisCloseRequests[1].user).toContain("language allowance for tonight (1 at unfiltered)");

    const lastJabs = transcript.segments.find((segment) => segment.id === "last_jabs")!;
    const closeTurn = lastJabs.turns.find((turn) => turn.kind === "close")!;
    expect(closeTurn.text).toBe("Well, that was one heck of a debate tonight.");
    expect(closeTurn.retried).toBe(true);
    expect(stats.languageStripped).toBe(0);
    expect(stats.profanityBySpeaker["curtis-vaughn"]).toBe(1);
    expect(curtisCloseCalls).toBe(2);
  });

  it("a team name containing a listed word never triggers enforcement, at clean rating or any other", async () => {
    const factsWithProfaneTeamName = {
      ...facts,
      teams: [...facts.teams, { id: "T99", teamId: "solo99", name: "Damn Good Dynasty", record: "0-0-0" }],
    };
    const requests: TurnCallRequest[] = [];
    const script = (req: TurnCallRequest): TurnOutput => {
      const kind = extractKind(req);
      if (kind === "argument" && req.speaker === "mel-diaper") {
        return baseOutput({ text: "The Damn Good Dynasty still can't fix their bench." });
      }
      return defaultScript(req);
    };
    const call = makeCapturingCaller(script, requests);
    const { transcript, stats } = await produceEpisode({
      facts: factsWithProfaneTeamName,
      factsText,
      brief, // clean — the strictest rating, and still never flags the team's own name
      relationshipsByWriter: {},
      call,
      options: { budgets: { mainEvent: 2 } },
    });

    const melArgumentRequests = requests.filter((req) => req.speaker === "mel-diaper" && extractKind(req) === "argument");
    expect(melArgumentRequests).toHaveLength(1);

    const mainEvent = transcript.segments.find((segment) => segment.id === "main_event")!;
    const melTurn = mainEvent.turns.find((turn) => turn.speaker === "mel-diaper")!;
    expect(melTurn.text).toBe("The Damn Good Dynasty still can't fix their bench.");
    expect(melTurn.retried).toBeUndefined();
    expect(stats.languageStripped).toBe(0);
    expect(stats.violations.some((violation) => violation.kind === "language_stripped")).toBe(false);
  });

  it("a genuine violation in one sentence never also strips an innocent sentence that merely names a profane-sounding team", async () => {
    const factsWithProfaneTeamName = {
      ...facts,
      teams: [...facts.teams, { id: "T99", teamId: "solo99", name: "Damn Good Dynasty", record: "0-0-0" }],
    };
    const script = (req: TurnCallRequest): TurnOutput => {
      const kind = extractKind(req);
      if (kind === "argument" && req.speaker === "mel-diaper") {
        // The team name ("Damn Good Dynasty") is fine at every rating; the second sentence's bare
        // "damn" is the actual, genuine violation, and only that sentence should ever be removed.
        return baseOutput({
          text: "The Damn Good Dynasty are still 2-5. That trade was a damn disaster for them.",
        });
      }
      return defaultScript(req);
    };
    const call = makeFakeCaller(script);
    const { transcript, stats } = await produceEpisode({
      facts: factsWithProfaneTeamName,
      factsText,
      brief,
      relationshipsByWriter: {},
      call,
      options: { budgets: { mainEvent: 2 } },
    });

    const mainEvent = transcript.segments.find((segment) => segment.id === "main_event")!;
    const melTurn = mainEvent.turns.find((turn) => turn.speaker === "mel-diaper")!;
    expect(melTurn.text).toBe("The Damn Good Dynasty are still 2-5.");
    expect(stats.languageStripped).toBe(1);
  });
});

describe("produceEpisode — language allowances (owner ask, 2026-09-03: profanity as a persona trait)", () => {
  const unfilteredBrief: ShowBrief = { ...brief, languageRating: "unfiltered" };

  it("lets a reserved speaker carry one strong word at unfiltered, then strips the second over the allowance", async () => {
    let dexCalls = 0;
    const script = (req: TurnCallRequest): TurnOutput => {
      const kind = extractKind(req);
      if (kind === "argument" && req.speaker === "mel-diaper") {
        return baseOutput({ witnessRequested: "dex-alvarez" });
      }
      if (kind === "witness" && req.speaker === "dex-alvarez") {
        dexCalls++;
        // Every Dex turn (and every retry) carries one strong word.
        return baseOutput({ text: "Phone works. Nobody gives a shit. That's the wire." });
      }
      return defaultScript(req);
    };
    const call = makeFakeCaller(script);
    const { transcript, stats } = await produceEpisode({
      facts,
      factsText,
      brief: unfilteredBrief,
      relationshipsByWriter: {},
      call,
      options: { budgets: { mainEvent: 4 } },
    });

    const mainEvent = transcript.segments.find((segment) => segment.id === "main_event")!;
    const dexTurns = mainEvent.turns.filter((turn) => turn.speaker === "dex-alvarez");
    expect(dexTurns.length).toBe(2);
    // First witness call: within his allowance of 1, kept verbatim.
    expect(dexTurns[0].text).toContain("Nobody gives a shit.");
    // Second: over the allowance twice, so the offending sentence is stripped and the rest survives.
    expect(dexTurns[1].text).not.toContain("shit");
    expect(dexTurns[1].text).toContain("Phone works.");
    expect(dexTurns[1].text).toContain("That's the wire.");
    expect(stats.languageStripped).toBe(1);
    expect(stats.profanityBySpeaker["dex-alvarez"]).toBe(1);
    expect(dexCalls).toBe(3); // 1 kept + (1 + 1 retry) stripped
    expect(
      stats.violations.some((v) => v.kind === "language_stripped" && v.speaker === "dex-alvarez" && v.detail.includes("allowance"))
    ).toBe(true);
  });

  it("never strips a debater who stays inside his allowance at unfiltered, and counts what he carried", async () => {
    const script = (req: TurnCallRequest): TurnOutput => {
      const kind = extractKind(req);
      if (kind === "argument" && req.speaker === "mel-diaper") {
        return baseOutput({ text: "THAT PICK IS BULLSHIT. Fourteen picks of air, what the fuck was the plan?" });
      }
      return defaultScript(req);
    };
    const { transcript, stats } = await produceEpisode({
      facts,
      factsText,
      brief: unfilteredBrief,
      relationshipsByWriter: {},
      call: makeFakeCaller(script),
      options: { budgets: { mainEvent: 4 } },
    });
    const mainEvent = transcript.segments.find((segment) => segment.id === "main_event")!;
    const melTurns = mainEvent.turns.filter((turn) => turn.speaker === "mel-diaper");
    expect(melTurns.length).toBe(2);
    for (const turn of melTurns) expect(turn.text).toContain("BULLSHIT");
    expect(stats.languageStripped).toBe(0);
    expect(stats.profanityBySpeaker["mel-diaper"]).toBe(4);
  });

  it("still strips a strong word at salty as out of tier, whoever says it", async () => {
    const script = (req: TurnCallRequest): TurnOutput => {
      const kind = extractKind(req);
      if (kind === "argument" && req.speaker === "reggie-banks") {
        return baseOutput({ text: "Cute draft. That grade card is horseshit. Scoreboard." });
      }
      return defaultScript(req);
    };
    const { transcript, stats } = await produceEpisode({
      facts,
      factsText,
      brief: { ...brief, languageRating: "salty" },
      relationshipsByWriter: {},
      call: makeFakeCaller(script),
      options: { budgets: { mainEvent: 2 } },
    });
    const mainEvent = transcript.segments.find((segment) => segment.id === "main_event")!;
    const reggie = mainEvent.turns.find((turn) => turn.speaker === "reggie-banks")!;
    expect(reggie.text).not.toContain("horseshit");
    expect(reggie.text).toContain("Cute draft.");
    expect(stats.violations.some((v) => v.kind === "language_stripped" && v.detail.includes("outside the salty rating"))).toBe(true);
  });

  it("at clean, strips any profanity from anyone, exactly as before", async () => {
    const script = (req: TurnCallRequest): TurnOutput => {
      const kind = extractKind(req);
      if (kind === "argument" && req.speaker === "mel-diaper") return baseOutput({ text: "Damn. Fourteen picks of air. I want a hearing." });
      return defaultScript(req);
    };
    const { transcript, stats } = await produceEpisode({
      facts,
      factsText,
      brief,
      relationshipsByWriter: {},
      call: makeFakeCaller(script),
      options: { budgets: { mainEvent: 2 } },
    });
    const mainEvent = transcript.segments.find((segment) => segment.id === "main_event")!;
    const mel = mainEvent.turns.find((turn) => turn.speaker === "mel-diaper")!;
    expect(mel.text).not.toContain("Damn");
    expect(mel.text).toContain("I want a hearing.");
    expect(stats.languageStripped).toBe(1);
    expect(stats.profanityBySpeaker).toEqual({});
  });
});

describe("directorInstructionFor — language notes are triggers, with a jab fallback", () => {
  const unfilteredBrief: ShowBrief = { ...brief, languageRating: "unfiltered" };

  it("says nothing about language at clean, or for a speaker with no allowance", () => {
    expect(directorInstructionFor("opening", { brief, languageUsed: 0, languageAllowance: 12 })).not.toContain("LANGUAGE:");
    expect(directorInstructionFor("jab", { brief: unfilteredBrief, jabSpeaker: "mel-diaper", languageUsed: 0, languageAllowance: 0 })).not.toContain("LANGUAGE:");
  });

  it("names the moment on an opening and an argument, never a word count to hit", () => {
    const opening = directorInstructionFor("opening", { brief: unfilteredBrief, languageUsed: 0, languageAllowance: 12, languageFloor: 4 });
    expect(opening).toContain("LANGUAGE: this league runs unfiltered and your range tonight is 4 to 12. Your language trait applies");
    expect(opening).not.toContain("use one");
    const argument = directorInstructionFor("argument", { brief: unfilteredBrief, languageUsed: 3, languageAllowance: 12, languageFloor: 4 });
    expect(argument).toContain("You are at 3 for the night and your range tonight is 4 to 12 — you are under it.");
    const onPace = directorInstructionFor("argument", { brief: unfilteredBrief, languageUsed: 5, languageAllowance: 12, languageFloor: 4 });
    expect(onPace).toContain("You are at 5 for the night and your range tonight is 4 to 12.");
    expect(onPace).not.toContain("under it");
  });

  it("falls back to an explicit instruction on the last jab while the debater is under his floor, sized to the shortfall", () => {
    const silent = directorInstructionFor("jab", { brief: unfilteredBrief, jabSpeaker: "reggie-banks", languageUsed: 0, languageAllowance: 10, languageFloor: 3 });
    expect(silent).toContain("you are at 0 for the night against a floor of 3");
    expect(silent).toContain("at least 3 words");
    expect(silent).toContain("fuck");
    const under = directorInstructionFor("jab", { brief: unfilteredBrief, jabSpeaker: "reggie-banks", languageUsed: 2, languageAllowance: 10, languageFloor: 3 });
    expect(under).toContain("you are at 2 for the night against a floor of 3");
    expect(under).toContain("at least one word");
    // No floor set: the fallback still fires at zero, exactly as before.
    const noFloor = directorInstructionFor("jab", { brief: unfilteredBrief, jabSpeaker: "reggie-banks", languageUsed: 0, languageAllowance: 10 });
    expect(noFloor).toContain("against a floor of 1");
    const salty = directorInstructionFor("jab", { brief: { ...brief, languageRating: "salty" }, jabSpeaker: "reggie-banks", languageUsed: 0, languageAllowance: 5, languageFloor: 2 });
    expect(salty).not.toContain("fuck");
    const loud = directorInstructionFor("jab", { brief: unfilteredBrief, jabSpeaker: "reggie-banks", languageUsed: 4, languageAllowance: 10, languageFloor: 3 });
    expect(loud).not.toContain("against a floor of");
    expect(loud).toContain("LANGUAGE: this league runs unfiltered.");
  });

  it("threads each debater's own running count and allowance into the producer's instructions", async () => {
    const seen: TurnCallRequest[] = [];
    const script = (req: TurnCallRequest): TurnOutput => {
      const kind = extractKind(req);
      if (kind === "opening" && req.speaker === "mel-diaper") {
        return baseOutput({ text: "Bullshit pick. Shit process.", claim: { text: "Mel's position.", kind: "general" } });
      }
      return defaultScript(req);
    };
    await produceEpisode({
      facts,
      factsText,
      brief: unfilteredBrief,
      relationshipsByWriter: {},
      call: makeCapturingCaller(script, seen),
      options: { budgets: { mainEvent: 2 } },
    });
    const melArgument = seen.find((req) => req.speaker === "mel-diaper" && extractKind(req) === "argument")!;
    expect(melArgument.user).toContain("You are at 2 for the night and your range tonight is 4 to 12 — you are under it.");
    const reggieArgument = seen.find((req) => req.speaker === "reggie-banks" && extractKind(req) === "argument")!;
    expect(reggieArgument.user).toContain("You are at 0 for the night and your range tonight is 3 to 10 — you are under it.");
    const reggieJab = seen.find((req) => req.speaker === "reggie-banks" && extractKind(req) === "jab")!;
    expect(reggieJab.user).toContain("you are at 0 for the night against a floor of 3");
    // Mel is at 2 against a floor of 4, so his jab fallback fires too, sized to the shortfall.
    const melJab = seen.find((req) => req.speaker === "mel-diaper" && extractKind(req) === "jab")!;
    expect(melJab.user).toContain("you are at 2 for the night against a floor of 4");
    expect(melJab.user).toContain("at least 2 words");
  });

  it("puts the persona's language trait and samples in the show system prompt above clean only", () => {
    const persona = getPersona("nina-sharpe");
    const unfiltered = buildTurnSystemPrompt(persona, facts, "role", unfilteredBrief);
    expect(unfiltered).toContain("Your language (this league runs unfiltered; your allowance is 1 per piece");
    const reggie = buildTurnSystemPrompt(getPersona("reggie-banks"), facts, "role", unfilteredBrief);
    expect(reggie).toContain("your range for a piece is 3 to 10");
    expect(unfiltered).toContain("LANGUAGE SAMPLES");
    expect(unfiltered).toContain("a fucking problem. Moving on.");
    const clean = buildTurnSystemPrompt(persona, facts, "role", brief);
    expect(clean).not.toContain("Your language (this league runs");
    expect(clean).not.toContain("LANGUAGE SAMPLES");
  });
});
