import { describe, expect, it } from "vitest";
import { buildInGameInjuryRule, conversationService, type ConversationContext } from "../src/lib/ai/conversation-service";
import {
  auditQuestion,
  checkDecline,
  checkFollowUpRedundancy,
  checkQuestionGrounding,
  checkQuestionShape,
  checkQuotes,
  contentWords,
  extractNumbers,
  factBlockFor,
  isDeclineReply,
  knownNamesFor,
  splitSentences,
  type Finding,
} from "../src/lib/ai/interview-checks";

/** The same fixture `scripts/measure-interview.ts` and the harness's --demo mode use. */
function context(overrides: Partial<ConversationContext> = {}): ConversationContext {
  return {
    userId: "user_measure",
    leagueId: "league_measure",
    scheduledContentId: undefined,
    contentType: "weekly_recap",
    week: 7,
    seasonId: 2026,
    managerName: "Priya Rao",
    teamName: "Sunday Scaries",
    interviewerPersona: "sam-ortega",
    writerPersona: "mel-diaper",
    opponentName: "Kittle Me This",
    opponentScore: 118.4,
    margin: 5.5,
    benchPoints: 31.2,
    topBenchPlayer: { player: "Jaylen Waddle", position: "WR", points: 22.6, projectedPoints: 14.1 },
    lineupDecisions: [
      {
        benchedPlayer: "Jaylen Waddle",
        benchedPoints: 22.6,
        startedPlayer: "Rome Odunze",
        startedPoints: 6.4,
        position: "WR",
        pointGain: 16.2,
      },
    ],
    transactionsThisWeek: [
      { type: "waiver", playersAdded: ["Tyjae Spears"], playersDropped: ["Rico Dowdle"], bidAmount: 17 },
    ],
    teamPerformance: {
      teamId: "T2",
      teamName: "Sunday Scaries",
      score: 112.9,
      projectedScore: 121.3,
      won: false,
      underperformers: [{ player: "Rome Odunze", position: "WR", expectedPts: 13.2, actualPts: 6.4 }],
      overperformers: [{ player: "Bijan Robinson", position: "RB", expectedPts: 18.6, actualPts: 27.9 }],
    },
    leagueContext: {
      standings: [
        { teamId: "T1", teamName: "Kittle Me This", rank: 2, record: "5-2" },
        { teamId: "T2", teamName: "Sunday Scaries", rank: 6, record: "4-3" },
      ],
    },
    writerContext: {
      persona: "mel-diaper",
      name: "Mel Diaper",
      relationship: { score: -22, tier: "cold" },
      recentMentions: [
        {
          week: 6,
          stance: "roast",
          evidence: "Priya Rao paid nineteen picks of air for Jalen Hurts and is still paying.",
          articleTitle: "Draft Grades: Receipts Edition",
        },
      ],
    },
    conversationHistory: [],
    ...overrides,
  };
}

const GOOD_OPENER =
  "Sam Ortega with FFSN, and this is on the record. That 5.5-point loss to Kittle Me This with Jaylen Waddle's 22.6 sitting on your bench - walk me through starting Rome Odunze over him?";

const REPLY =
  "I had Waddle in there until about 11:40, then I got cute. And honestly Mel can stick to mock drafts, he has never watched one of my games.";

const codes = (findings: Finding[]) => findings.map((f) => f.code);
const bySeverity = (findings: Finding[], severity: Finding["severity"]) => findings.filter((f) => f.severity === severity);

describe("factBlockFor - the CONTEXT block Sam is actually shown", () => {
  it("is the service's own block, byte for byte", () => {
    const ctx = context();
    expect(factBlockFor(ctx)).toBe(conversationService.factBlock(ctx));
  });

  it("contains the lines the checks ground against", () => {
    const block = factBlockFor(context());
    expect(block).toContain("Story: weekly recap - Week 7, 2026 season");
    expect(block).toContain("Week 7 result: Lost 112.9-118.4 to Kittle Me This (margin 5.5)");
    expect(block).toContain("Standing: #6 by record (4-3)");
    expect(block).toContain("Bench points: 31.2 (most: Jaylen Waddle, WR, 22.6)");
    expect(block).toContain("Transaction (waiver): added Tyjae Spears, dropped Rico Dowdle for $17 FAAB");
    expect(block).toContain('Mel Diaper wrote about this manager in Week 6 ("Draft Grades: Receipts Edition")');
    // Only the manager's own standing is on the block: the opponent's 5-2 is not something Sam saw.
    expect(block).not.toContain("5-2");
  });

  it("omits Week 0, a 0-0 standing, and names an unplayed opponent without a score", () => {
    const preview = context({
      week: 0,
      contentType: "draft_rankings",
      opponentName: undefined,
      opponentScore: undefined,
      margin: undefined,
      upcomingOpponentName: "Gridiron Gang",
      teamPerformance: { ...context().teamPerformance, score: 0 },
      leagueContext: { standings: [{ teamId: "T2", teamName: "Sunday Scaries", rank: 1, record: "0-0" }] },
    });
    const block = factBlockFor(preview);
    expect(block).toContain("Story: draft rankings - 2026 season");
    expect(block).not.toMatch(/Week 0/);
    expect(block).not.toContain("Standing:");
    expect(block).toContain("Next matchup: vs Gridiron Gang (not played yet - no result to cite)");
  });
});

describe("extractNumbers", () => {
  it("finds decimals, integers, dollars, records, draft slots, ordinals and thousands", () => {
    const tokens = extractNumbers(
      "Lost 112.9-118.4 to Kittle Me This, $17 FAAB, a 4-3 record, pick 3.02, 6th place, 1,200 FAAB and a 5-2-1 rivalry"
    );
    expect(tokens.map((t) => t.key)).toEqual(["112.9", "118.4", "17", "4-3", "3.02", "6", "1200", "5-2-1"]);
    expect(tokens.find((t) => t.raw === "$17")?.kind).toBe("money");
    expect(tokens.find((t) => t.raw === "4-3")).toMatchObject({ kind: "record", parts: [4, 3], value: 4 });
    expect(tokens.find((t) => t.raw === "5-2-1")?.parts).toEqual([5, 2, 1]);
    expect(tokens.find((t) => t.raw === "6th")?.value).toBe(6);
    expect(tokens.find((t) => t.key === "1200")?.value).toBe(1200);
  });

  it("does not read 49ers, .500 or T2 as numbers", () => {
    expect(extractNumbers("the 49ers went .500 and T2 is a team id")).toEqual([]);
  });

  it("keeps a hyphenated point phrase as a number, not a record", () => {
    expect(extractNumbers("that 5.5-point loss and a 3-point swing").map((t) => [t.key, t.kind])).toEqual([
      ["5.5", "number"],
      ["3", "number"],
    ]);
  });
});

describe("checkQuestionGrounding - every number and name must be in CONTEXT", () => {
  it("passes a grounded opener with no findings at all", () => {
    expect(checkQuestionGrounding(GOOD_OPENER, context())).toEqual([]);
  });

  it("blocks a number that is not in CONTEXT", () => {
    const findings = checkQuestionGrounding("Bijan Robinson gave you 41.7 - was that the plan?", context());
    expect(bySeverity(findings, "block").map((f) => f.code)).toEqual(["unsupported_number"]);
    expect(findings[0].detail).toContain('"41.7"');
  });

  it("accepts ±0.05, a record part, an ordinal and a dollar figure", () => {
    const question = "At 6th with 4 wins, $17 on Tyjae Spears and 22.60 from Waddle on the bench - what was the thinking?";
    expect(checkQuestionGrounding(question, context())).toEqual([]);
    const audit = auditQuestion(question, context());
    expect(audit.numbers.find((n) => n.raw === "4")?.via).toBe("record part of 4-3");
    expect(audit.numbers.find((n) => n.raw === "22.60")?.via).toBe("approx 22.6");
  });

  it("reports a sum or difference of two CONTEXT numbers as info, not a block", () => {
    const findings = checkQuestionGrounding("231.3 combined points in that game - did it feel that close?", context());
    expect(findings).toEqual([
      { code: "number_derived", severity: "info", detail: '"231.3" is only grounded as derived (112.9 + 118.4)' },
    ]);
  });

  it("blocks a record that is not on the block", () => {
    const findings = checkQuestionGrounding("Kittle Me This is 5-2 - does that change how you see the loss?", context());
    expect(codes(findings)).toEqual(["unsupported_number"]);
    expect(findings[0].detail).toContain('"5-2" is record not in CONTEXT');
  });

  it("blocks a player name that is not in CONTEXT", () => {
    const findings = checkQuestionGrounding("How did Justin Jefferson look in that loss to Kittle Me This?", context());
    expect(findings).toEqual([{ code: "unsupported_name", severity: "block", detail: '"Justin Jefferson" is not in CONTEXT' }]);
  });

  it("blocks a name the context object knows about but the block does not show", () => {
    const ctx = context({
      leagueContext: {
        standings: [...context().leagueContext.standings, { teamId: "T3", teamName: "Gridiron Gang", rank: 1, record: "7-0" }],
      },
    });
    const findings = checkQuestionGrounding("Gridiron Gang is still unbeaten - does your 4-3 keep you in it?", ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ code: "unsupported_name", severity: "block" });
    expect(findings[0].detail).toContain("known to the context object but not on the CONTEXT block");
  });

  it("warns on a lone capitalized word mid-sentence that is not in CONTEXT, but not on a surname that is", () => {
    expect(checkQuestionGrounding("Was benching Waddle about the matchup?", context())).toEqual([]);
    const findings = checkQuestionGrounding("Did Mahomes change your Waddle call?", context());
    expect(findings).toEqual([
      { code: "unknown_proper_noun", severity: "warn", detail: '"Mahomes" is capitalized mid-sentence and not in CONTEXT' },
    ]);
  });

  it("gives a word that opens a quoted clause the same benefit of the doubt as a sentence opener", () => {
    expect(checkQuestionGrounding('You said "Got cute" - what tipped the Waddle call?', context())).toEqual([]);
    expect(codes(checkQuestionGrounding('You said "Got cute with Mahomes" - why?', context()))).toEqual(["unknown_proper_noun"]);
  });

  it("allows Sam, FFSN, the manager's first name, the writer's name and Week without them being facts", () => {
    const question =
      "Priya, Sam Ortega at FFSN again. Mel Diaper called your Jalen Hurts pick \"nineteen picks of air\" in Week 6 - anything you want to say to him on the record?";
    expect(checkQuestionGrounding(question, context())).toEqual([]);
  });

  it("warns on NFL nicknames, injuries, rookies, byes, suspensions and trade rumors that CONTEXT does not mention", () => {
    const findings = checkQuestionGrounding(
      "With the Dolphins on a bye, Waddle hurt, a rookie starting, Odunze suspended and the trade rumors - what changed?",
      context()
    );
    expect(codes(findings)).toEqual([
      "vocab_nfl_team",
      "vocab_injury",
      "vocab_rookie",
      "vocab_bye",
      "vocab_suspended",
      "vocab_trade_rumor",
    ]);
    expect(findings.every((f) => f.severity === "warn")).toBe(true);
  });

  it("does not warn on vocabulary the block itself contains", () => {
    const ctx = context({
      draftData: {
        userDraftPicks: [
          {
            isRookie: true,
            perceivedValue: 0,
            pickNumber: 26,
            playerADP: 31,
            playerName: "Tetairoa McMillan",
            playerPosition: "WR",
            playerProjectedPoints: null,
            playerTeam: "CAR",
            roundNumber: 3,
            roundPickNumber: 2,
            teamName: "Sunday Scaries",
            teamOwner: "Priya Rao",
          },
        ],
      },
    });
    expect(factBlockFor(ctx)).toContain("Draft pick 3.02 (overall 26): Tetairoa McMillan, WR, rookie, ADP 31 (5 picks early)");
    expect(checkQuestionGrounding("Taking the rookie Tetairoa McMillan at 3.02, 5 picks early - what did you see?", ctx)).toEqual([]);
  });
});

describe("checkQuestionShape", () => {
  it("passes a two-sentence opener with one question mark", () => {
    expect(checkQuestionShape(GOOD_OPENER, { isOpener: true })).toEqual([]);
  });

  it("blocks zero or two question marks, but takes 'walk me through it' as the question", () => {
    expect(codes(checkQuestionShape("Sam Ortega, on the record. Your bench outscored your starters.", { isOpener: true }))).toEqual(["no_question"]);
    expect(codes(checkQuestionShape("Sam Ortega, on the record. Walk me through it.", { isOpener: true }))).toEqual(["imperative_prompt"]);
    expect(
      codes(checkQuestionShape("Sam Ortega, on the record. Why Odunze? And why so late?", { isOpener: true }))
    ).toEqual(["multiple_questions"]);
  });

  it("warns on sentence count, exclamation points and emoji", () => {
    const opener = "Sam Ortega with FFSN. This is on the record. You lost by 5.5. Waddle sat. Walk me through it?";
    expect(codes(checkQuestionShape(opener, { isOpener: true }))).toEqual(["too_many_sentences"]);
    expect(codes(checkQuestionShape("You benched Waddle. That hurt. Why?", { isOpener: false }))).toEqual(["too_many_sentences"]);
    expect(codes(checkQuestionShape("Waddle sat! Why?", { isOpener: false }))).toEqual(["exclamation"]);
    expect(codes(checkQuestionShape("Why bench Waddle 🙃?", { isOpener: false }))).toEqual(["emoji"]);
  });

  it("warns when the opener skips the introduction or the on-the-record disclosure", () => {
    expect(codes(checkQuestionShape("That 5.5-point loss to Kittle Me This - walk me through it?", { isOpener: true }))).toEqual([
      "opener_no_intro",
      "opener_no_record_disclosure",
    ]);
    expect(checkQuestionShape("That 5.5-point loss - walk me through it?", { isOpener: false })).toEqual([]);
  });

  it("does not split sentences on decimals or a quoted line", () => {
    expect(splitSentences('Mel called it "nineteen picks of air." You lost 112.9-118.4. Anything to say?')).toHaveLength(3);
    const followUp = 'Mel called your Hurts pick "nineteen picks of air." Anything you want to say to him?';
    expect(checkQuestionShape(followUp, { isOpener: false })).toEqual([]);
  });
});

describe("checkFollowUpRedundancy", () => {
  it("passes a follow-up that digs into something the manager said", () => {
    expect(checkFollowUpRedundancy(GOOD_OPENER, REPLY, "What happened at 11:40 that made you pull Waddle?", context())).toEqual([]);
  });

  it("warns when the follow-up restates opener facts the manager never brought up", () => {
    const findings = checkFollowUpRedundancy(
      GOOD_OPENER,
      REPLY,
      "Was leaving Jaylen Waddle's 22.6 on the bench the difference against Kittle Me This?",
      context()
    );
    expect(codes(findings)).toEqual(["restates_opener_fact"]);
    expect(findings[0].detail).toContain('"22.6"');
    expect(findings[0].detail).toContain('"Kittle Me This"');
    expect(findings[0].detail).not.toContain("Jaylen Waddle");
  });

  it("blocks a follow-up that shares no content word with the reply", () => {
    const findings = checkFollowUpRedundancy(GOOD_OPENER, REPLY, "How are you seeing the playoff picture from here?", context());
    expect(findings).toEqual([
      { code: "not_anchored", severity: "block", detail: "not anchored in reply: shares no content word with what the manager said" },
    ]);
  });

  it("blocks the opener asked again", () => {
    const again =
      "Walk me through that 5.5-point loss to Kittle Me This with Jaylen Waddle's 22.6 sitting on your bench and starting Rome Odunze over him?";
    expect(codes(checkFollowUpRedundancy(GOOD_OPENER, REPLY, again, context()))).toContain("same_question");
  });

  it("warns when the follow-up asks what the reply already answered", () => {
    const reply = "I benched Waddle because the weather in Miami looked awful and I trusted Odunze's target share.";
    const followUp = "Did the Miami weather and Odunze's target share drive the Waddle benching?";
    const findings = checkFollowUpRedundancy(GOOD_OPENER, reply, followUp, context());
    expect(codes(findings)).toEqual(["already_answered"]);
  });

  it("content words drop stopwords and short tokens and stem lightly", () => {
    expect(contentWords("I benched Waddle and the benching stung, 22.6 points")).toEqual(new Set(["bench", "waddle", "stung", "22.6"]));
  });
});

describe("checkQuotes", () => {
  it("passes verbatim segments, including ones a model re-cased or re-quoted", () => {
    expect(checkQuotes(REPLY, ["I had Waddle in there until about 11:40, then I got cute."])).toEqual([]);
    expect(checkQuotes(REPLY, ["mel can stick to mock drafts"])).toEqual([]);
  });

  it("blocks a retyped segment", () => {
    const findings = checkQuotes(REPLY, ["I had Waddle in until 11:40"]);
    expect(findings).toEqual([
      { code: "quote_not_verbatim", severity: "block", detail: '"I had Waddle in until 11:40" is not a verbatim span of the reply' },
    ]);
  });

  it("warns on a bare topic label but not on a short quote with a verb", () => {
    expect(codes(checkQuotes(REPLY, ["mock drafts"]))).toEqual(["quote_topic_label"]);
    expect(checkQuotes("No, that's it. Print it.", ["Print it."])).toEqual([]);
  });

  it("warns when a substantive reply yields no quote, but not for a decline or a short reply", () => {
    expect(codes(checkQuotes(REPLY, []))).toEqual(["no_quotes"]);
    expect(checkQuotes("No comment, I'd rather not get into any of it today.", [])).toEqual([]);
    expect(checkQuotes("Nope.", [])).toEqual([]);
  });
});

describe("checkDecline", () => {
  it("recognises the ways a manager says no", () => {
    for (const reply of ["No comment.", "I'll pass.", "Pass.", "Not today, Sam.", "I'd rather not.", "Leave me out of this one."]) {
      expect(isDeclineReply(reply), reply).toBe(true);
    }
    expect(isDeclineReply("I passed on Waddle at the deadline and regret it.")).toBe(false);
    expect(isDeclineReply(REPLY)).toBe(false);
  });

  it("requires a decline to be recorded and closed", () => {
    expect(checkDecline("No comment.", { shouldRecordDecline: true, intent: "closing" })).toEqual([]);
    expect(codes(checkDecline("No comment.", { shouldRecordDecline: false, intent: "closing" }))).toEqual(["decline_not_recorded"]);
    expect(codes(checkDecline("No comment.", { shouldRecordDecline: true, intent: "follow_up" }))).toEqual(["decline_not_closed"]);
    expect(checkDecline("No comment.", { shouldRecordDecline: false, intent: "follow_up" }).every((f) => f.severity === "block")).toBe(true);
  });

  it("reports a decline recorded on a substantive reply as info", () => {
    expect(checkDecline(REPLY, { shouldRecordDecline: true, intent: "closing" })).toEqual([
      { code: "decline_recorded", severity: "info", detail: "shouldRecordDecline is true on a reply that does not read as a decline" },
    ]);
    expect(checkDecline(REPLY, { shouldRecordDecline: false, intent: "follow_up" })).toEqual([]);
  });
});

describe("knownNamesFor", () => {
  it("collects players, teams and people from every context field", () => {
    const known = knownNamesFor(context());
    expect(known.players).toEqual(expect.arrayContaining(["Jaylen Waddle", "Rome Odunze", "Bijan Robinson", "Tyjae Spears", "Rico Dowdle"]));
    expect(known.teams).toEqual(expect.arrayContaining(["Sunday Scaries", "Kittle Me This"]));
    expect(known.people).toEqual(["Priya Rao", "Mel Diaper"]);
  });
});

describe("what the first live run taught the checks (Sept 2026)", () => {
  const codes = (findings: Array<{ code: string }>) => findings.map((f) => f.code);

  it("blocks a score written opponent-first, and accepts it manager-first", () => {
    // The fixture lost 112.9-118.4 to Kittle Me This.
    expect(codes(checkQuestionGrounding("You dropped 118.4 to 112.9 against Kittle Me This, walk me through it.", context()))).toContain("score_order_reversed");
    expect(codes(checkQuestionGrounding("You lost 112.9-118.4 to Kittle Me This, walk me through it.", context()))).not.toContain("score_order_reversed");
    // A record that happens to pair two numbers is not a score.
    expect(codes(checkQuestionGrounding("You're 4-3 at #6, walk me through it.", context()))).not.toContain("score_order_reversed");
  });

  it("warns, rather than blocks, when Sam rounds a CONTEXT number", () => {
    // benchPoints is 31.2 on the block.
    const findings = checkQuestionGrounding("You left a 31-point bench behind, walk me through it.", context());
    expect(codes(findings)).toContain("number_rounded");
    expect(codes(findings)).not.toContain("unsupported_number");
  });

  it("grounds numbers and names the manager said, once replies are supplied", () => {
    const question = "You said 7-6 better become 8-6 and that Gainwell was the call, anything else you want on the record?";
    expect(codes(checkQuestionGrounding(question, context()))).toEqual(expect.arrayContaining(["unsupported_number", "unknown_proper_noun"]));
    expect(codes(checkQuestionGrounding(question, context(), { replies: ["7-6 better become 8-6, and Gainwell was the call."] }))).toEqual([]);
  });

  it("does not read days, months, contractions or fantasy shorthand as invented names", () => {
    const question = "You're 4-3 heading into Sunday with $17 FAAB on Tyjae Spears; I'll ask once, walk me through it.";
    expect(codes(checkQuestionGrounding(question, context()))).not.toContain("unknown_proper_noun");
  });
});

describe("in-game injuries are not lineup mistakes (The Wire spec §16.1)", () => {
  const kickoffAt = 1760893200000;
  const injured = () =>
    context({
      inGameInjuries: [
        {
          espnId: "4567",
          name: "Rome Odunze",
          position: "WR",
          nflTeam: "CHI",
          fantasyTeamId: "2",
          fantasyTeamName: "Sunday Scaries",
          week: 7,
          status: "OUT",
          observedAt: kickoffAt + 41 * 60_000,
          kickoffAt,
          started: true,
          points: 6.4,
        },
      ],
    });

  it("puts the injury on the CONTEXT block and takes the lineup line and the under-projection off it", () => {
    const block = factBlockFor(injured());
    expect(block).toContain("In-game injury: Rome Odunze (WR) left hurt - OUT, 41 minutes after kickoff, started, 6.4 points");
    expect(block).not.toContain("Lineup: Jaylen Waddle");
    expect(block).not.toContain("Under projection: Rome Odunze");
    // The bench total is still a fact; the swap it implies is not a question.
    expect(block).toContain("Bench points: 31.2 (most: Jaylen Waddle, WR, 22.6)");
    // Without an injury the block is what it always was.
    expect(factBlockFor(context())).toContain("Lineup: Jaylen Waddle (WR) scored 22.6 on the bench; started Rome Odunze scored 6.4");
  });

  it("hands Sam the replacement rule, naming the player, and nothing when nobody left hurt", () => {
    expect(buildInGameInjuryRule(injured())).toBe(
      "IN-GAME INJURY RULE\nRome Odunze left the game hurt. That is never the manager's decision: never ask why they started Rome Odunze or whether they regret it; ask how they replace the production (bench cover, the waiver wire, the next man up), one question."
    );
    expect(buildInGameInjuryRule(context())).toBeNull();
  });

  it("blocks the question no reporter would ask: why they started him, or whether they regret it", () => {
    // The sanctioned lineup opener becomes the wrong question once the started player left hurt.
    const opener = checkQuestionGrounding(GOOD_OPENER, injured());
    expect(codes(opener)).toEqual(["injury_blame_question"]);
    expect(bySeverity(opener, "block")).toHaveLength(1);
    expect(opener[0].detail).toContain("Rome Odunze left his game hurt (OUT)");

    for (const question of [
      "Why did you start Odunze with the injury report the way it was?",
      "Any regret on Rome Odunze in that slot?",
      "Should you have had Jaylen Waddle in over Rome Odunze?",
    ]) {
      expect(codes(checkQuestionGrounding(question, injured())), question).toContain("injury_blame_question");
    }
  });

  it("passes the replacement question, and the same opener when nobody left hurt", () => {
    const replacement = "Sam Ortega with FFSN, on the record. With Rome Odunze out after 41 minutes, who covers WR for Sunday Scaries this week - the bench or the wire?";
    expect(codes(checkQuestionGrounding(replacement, injured()))).not.toContain("injury_blame_question");
    expect(checkQuestionGrounding(GOOD_OPENER, context())).toEqual([]);
    expect(auditQuestion(GOOD_OPENER, context()).injuryBlame).toEqual([]);
  });

  it("records what it saw in the audit", () => {
    expect(auditQuestion(GOOD_OPENER, injured()).injuryBlame).toEqual([{ player: "Rome Odunze", phrase: "walk me through starting" }]);
    expect(knownNamesFor(injured()).players).toContain("Rome Odunze");
  });
});
