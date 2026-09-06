import { describe, expect, it } from "vitest";
import { effectiveLanguageRange, getPersona } from "../src/lib/ai/persona-prompts";
import { GROUNDING_CONTRACT } from "../src/lib/ai/prompt-builder";
import {
  CHASE_PERSONA,
  WIRE_REPLY_MAX_TOKENS,
  WIRE_REPLY_TOOL_NAME,
  buildStandingBlock,
  effectiveReplyRating,
  parseWriterReply,
  prepareWriterReplyRequest,
  replyLanguageSeed,
  replyPersona,
  verifyWriterReply,
} from "../src/lib/ai/wire/reply";
import type { WireModelMessage } from "../src/lib/ai/wire/take";
import { MAX_POST_CHARS, MAX_THREAD_CONTEXT, WIRE_DEFAULT_ROUTE, type WireFactCard, type WriterReplyInput } from "../src/lib/ai/wire/types";

/**
 * Writer replies (spec §17.3), the pure half: what the request looks like and how a hand-built
 * model message parses and verifies. No network.
 */

const burrow: WireFactCard = {
  kind: "injury_status",
  observedAt: 1_800_000_000_000,
  players: [{ espnId: "3915511", name: "Joe Burrow", position: "QB", nflTeam: "CIN", percentOwned: 99 }],
  nflTeam: "CIN",
  statusFrom: "Questionable",
  statusTo: "Out",
  note: "Burrow (toe) will miss 6-8 weeks after surgery, Adam Schefter of ESPN reports.",
  timetable: "6-8 weeks",
  source: { type: "espn_injuries", id: "636276", fetchedAt: 1_800_000_000_000 },
};

const jab: WriterReplyInput = {
  persona: "dex-alvarez",
  mode: "reply",
  writerPostText: "Burrow: toe, surgery, 6-8 weeks per ESPN. REPORTED. Stand by.",
  card: burrow,
  managerText: 'lol Dex you "reported" this 40 minutes after everyone else. Elite insider work.',
  manager: {
    displayName: "Gabe Coscia",
    teamName: "Gabe's Gang",
    relationshipTier: "feud",
    recentEvidence: ["called the desk's trade coverage a yard sale in week 3"],
  },
  thread: [{ author: "manager", text: "Patrick Mahomes next?" }],
  languageRating: "salty",
  cleanTeam: false,
  week: 4,
};

const chase: WriterReplyInput = {
  persona: "sam-ortega",
  mode: "chase",
  managerText: "Benching my RB1 this week. Gut call. Don't @ me.",
  manager: { displayName: "Riv", teamName: "Team Rive", relationshipTier: "neutral", recentEvidence: [] },
  thread: [],
  languageRating: "clean",
  cleanTeam: false,
  week: 4,
};

function toolMessage(input: unknown, stopReason: string | null = "tool_use"): WireModelMessage {
  return {
    content: [{ type: "text" }, { type: "tool_use", name: WIRE_REPLY_TOOL_NAME, input }],
    stop_reason: stopReason,
  };
}

describe("prepareWriterReplyRequest", () => {
  const prepared = prepareWriterReplyRequest(jab);
  const system = prepared.params.system as Array<{ type: string; text: string; cache_control?: unknown }>;

  it("uses the wire route, a forced strict tool and the reply token budget", () => {
    expect(prepared.route).toEqual(WIRE_DEFAULT_ROUTE);
    expect(prepared.params.model).toBe(WIRE_DEFAULT_ROUTE.model);
    expect(prepared.params.max_tokens).toBe(WIRE_REPLY_MAX_TOKENS);
    expect(prepared.params.output_config).toEqual({ effort: WIRE_DEFAULT_ROUTE.effort });
    expect(prepared.params.tool_choice).toEqual({ type: "tool", name: WIRE_REPLY_TOOL_NAME });
    const tool = prepared.params.tools?.[0] as { name: string; strict?: boolean; input_schema: { required?: string[]; properties: Record<string, unknown> } };
    expect(tool.name).toBe(WIRE_REPLY_TOOL_NAME);
    expect(tool.strict).toBe(true);
    expect(Object.keys(tool.input_schema.properties).sort()).toEqual(["sentiment", "text"]);
  });

  it("caches the stable persona block and puts the standing after the breakpoint", () => {
    expect(system).toHaveLength(2);
    expect(system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(system[0].text.startsWith(GROUNDING_CONTRACT)).toBe(true);
    expect(system[0].text).toContain("WHO YOU ARE");
    expect(system[0].text).toContain("THE WIRE REPLY CONTRACT");
    expect(system[0].text).toContain(`at most ${MAX_POST_CHARS} characters`);
    expect(system[0].text).toContain("Never print a non-response");
    expect(system[0].text).not.toContain("Gabe Coscia");
    expect(system[1].cache_control).toBeUndefined();
    expect(system[1].text).toBe(prepared.standing);
  });

  it("states the manager, the tier and the persona's posture at that tier verbatim", () => {
    expect(prepared.standing).toContain("The manager is Gabe Coscia of Gabe's Gang. Your standing with them is feud.");
    expect(prepared.standing).toContain(getPersona("dex-alvarez").relationshipPosture.feud);
    expect(prepared.standing).toContain("called the desk's trade coverage a yard sale in week 3");
    expect(prepared.standing).toContain("Mode: reply");
  });

  it("falls back to the neutral posture for an unknown tier", () => {
    const standing = buildStandingBlock(getPersona("dex-alvarez"), { ...jab, manager: { ...jab.manager, relationshipTier: "bff" } });
    expect(standing).toContain("Your standing with them is neutral.");
    expect(standing).toContain(getPersona("dex-alvarez").relationshipPosture.neutral);
  });

  it("carries the persona's language trait at the league rating, and none for a clean-team manager", () => {
    expect(effectiveReplyRating(jab)).toBe("salty");
    expect(system[0].text).toContain("Your language (this league runs salty");
    const clean = prepareWriterReplyRequest({ ...jab, cleanTeam: true });
    expect(effectiveReplyRating({ ...jab, cleanTeam: true })).toBe("clean");
    expect(clean.systemPrompt).not.toContain("Your language (");
    expect(clean.standing).toContain("opted their team down to clean coverage");
  });

  it("sends the words and the card view, never ids or timestamps", () => {
    const content = prepared.params.messages[0].content;
    expect(typeof content).toBe("string");
    const view = JSON.parse(content as string) as Record<string, unknown>;
    expect(view).toMatchObject({
      mode: "reply",
      week: 4,
      writerPost: jab.writerPostText,
      managerText: jab.managerText,
      manager: { displayName: "Gabe Coscia", teamName: "Gabe's Gang" },
      thread: [{ author: "manager", text: "Patrick Mahomes next?" }],
    });
    expect(view).not.toHaveProperty("relationshipTier");
    const serialized = content as string;
    for (const key of ["espnId", "fetchedAt", "observedAt", "\"id\""]) expect(serialized).not.toContain(key);
    expect(serialized).toContain('"source": "ESPN"');
  });

  it("trims the thread to the last MAX_THREAD_CONTEXT turns", () => {
    const long = Array.from({ length: MAX_THREAD_CONTEXT + 3 }, (_, index) => ({
      author: index % 2 === 0 ? ("manager" as const) : ("writer" as const),
      text: `turn ${index}`,
    }));
    const view = JSON.parse(prepareWriterReplyRequest({ ...jab, thread: long }).params.messages[0].content as string) as {
      thread: Array<{ text: string }>;
    };
    expect(view.thread).toHaveLength(MAX_THREAD_CONTEXT);
    expect(view.thread[0].text).toBe("turn 3");
  });

  it("chase mode is always Sam, whatever persona was passed", () => {
    expect(replyPersona(chase)).toBe(CHASE_PERSONA);
    expect(replyPersona({ ...chase, persona: "dex-alvarez" })).toBe(CHASE_PERSONA);
    const prepared = prepareWriterReplyRequest({ ...chase, persona: "dex-alvarez" });
    expect(prepared.persona.slug).toBe("sam-ortega");
    expect(prepared.systemPrompt).toContain('You are Simone "Sam" Ortega');
    expect(prepared.standing).toContain("Mode: chase");
  });

  it("derives the language seed from the thread and the manager's words", () => {
    expect(replyLanguageSeed(jab)).toBe(replyLanguageSeed({ ...jab, manager: { ...jab.manager, displayName: "Someone Else" } }));
    expect(replyLanguageSeed(jab)).not.toBe(replyLanguageSeed({ ...jab, managerText: "different words" }));
  });
});

describe("parseWriterReply", () => {
  const good = "Filed 40 minutes after ESPN posted it. Checked the log twice. That is the whole wire, Gabe. Back to you.";

  it("returns a verified reply with the sentiment", () => {
    expect(parseWriterReply(toolMessage({ text: good, sentiment: "jab" }), jab)).toEqual({ text: good, sentiment: "jab", flags: [] });
  });

  it("flags a missing tool call and trusts nothing", () => {
    const result = parseWriterReply({ content: [{ type: "text" }], stop_reason: "end_turn" }, jab);
    expect(result).toEqual({ sentiment: "neutral", flags: ["no_tool_call"] });
  });

  it("flags an unparseable tool input", () => {
    expect(parseWriterReply(toolMessage("not an object"), jab)).toEqual({ sentiment: "neutral", flags: ["parse_error"] });
  });

  it("defaults an odd sentiment to neutral and keeps the text", () => {
    const result = parseWriterReply(toolMessage({ text: good, sentiment: "furious" }), jab);
    expect(result.text).toBe(good);
    expect(result.sentiment).toBe("neutral");
    expect(result.flags).toEqual(["sentiment_missing"]);
    expect(parseWriterReply(toolMessage({ text: good, sentiment: " Thanks " }), jab).sentiment).toBe("thanks");
  });

  it("records max_tokens without dropping a text that parsed and verified", () => {
    const result = parseWriterReply(toolMessage({ text: good, sentiment: "jab" }, "max_tokens"), jab);
    expect(result.text).toBe(good);
    expect(result.flags).toEqual(["max_tokens"]);
  });

  it("keeps the sentiment when the text fails verification, and posts nothing", () => {
    const result = parseWriterReply(toolMessage({ text: "Per the ledger, Burrow is out.", sentiment: "jab" }, "end_turn"), jab);
    expect(result.text).toBeUndefined();
    expect(result.sentiment).toBe("jab");
    expect(result.flags.some(flag => flag.startsWith("register_leak"))).toBe(true);
  });

  it("treats a missing text as empty", () => {
    expect(parseWriterReply(toolMessage({ sentiment: "neutral" }), jab)).toEqual({ sentiment: "neutral", flags: ["empty"] });
  });
});

describe("verifyWriterReply", () => {
  it("passes a reply that stays on the card and in the thread", () => {
    expect(verifyWriterReply("Week 4. 40 minutes, you say. 6-8 weeks, ESPN says. Patrick Mahomes is not on my notepad, Gabe.", jab)).toEqual([]);
  });

  it("flags a register leak", () => {
    expect(verifyWriterReply("Per the ledger, Burrow is out.", jab)).toEqual(['register_leak: "ledger" (prompt-layer jargon)']);
  });

  it("flags length", () => {
    const [flag] = verifyWriterReply("word ".repeat(70).trim(), jab);
    expect(flag).toMatch(/^too_long: \d+ > 280$/);
  });

  it("flags timetable talk the card does not carry, and a reporter credit", () => {
    const ir: WireFactCard = {
      ...burrow,
      statusTo: "Injured Reserve",
      note: "The Bengals placed Burrow (knee) on injured reserve Tuesday.",
      timetable: undefined,
    };
    expect(verifyWriterReply("On IR, season-ending. Filed.", { ...jab, card: ir })).toEqual(['timetable_without_card: "season-ending"']);
    expect(verifyWriterReply("Out 6-8 weeks, Schefter of ESPN reports.", jab)).toEqual(['reporter_attribution: "Schefter of ESPN reports"']);
    expect(verifyWriterReply("Out 6-8 weeks per ESPN. Filed.", jab)).toEqual([]);
  });

  it("flags a number that is neither on the card nor in the thread", () => {
    expect(verifyWriterReply("Burrow threw for 4,200 yards last year.", jab)).toEqual(["unverified_number: 4200"]);
  });

  it("allows numbers from the card, the manager, the history and the week", () => {
    expect(verifyWriterReply("6-8 weeks. 40 minutes. Week 3 you said yard sale. Week 4 now.", jab)).toEqual([]);
  });

  it("flags a name that is nowhere in the input", () => {
    expect(verifyWriterReply("You want Adam Schefter, not me.", jab)).toEqual(["unknown_name: Adam Schefter"]);
  });

  it("allows the manager, their team, names in the thread and the desk", () => {
    expect(verifyWriterReply("Gabe Coscia and Gabe's Gang can ask Patrick Mahomes. Nina Sharpe has the numbers.", jab)).toEqual([]);
  });

  it("flags any tracked word when the manager opted their team down", () => {
    expect(verifyWriterReply("Damn, Gabe.", { ...jab, cleanTeam: true })).toEqual(["language_over_rating: damn at clean"]);
  });

  it("flags any tracked word at clean", () => {
    expect(verifyWriterReply("Damn, Gabe.", { ...jab, languageRating: "clean" })).toEqual(["language_over_rating: damn at clean"]);
  });

  it("flags a strong word at salty", () => {
    const flags = verifyWriterReply("Bullshit, Gabe.", jab);
    expect(flags[0]).toBe("language_over_rating: bullshit at salty");
  });

  it("holds a reserved-desk writer to their effective ceiling for this thread", () => {
    const range = effectiveLanguageRange(getPersona("dex-alvarez"), "salty", replyLanguageSeed(jab));
    const flags = verifyWriterReply("Dead as hell, Gabe. Checked twice.", jab);
    expect(flags).toEqual(range.ceiling >= 1 ? [] : [`language_over_allowance: 1 > 0`]);
  });

  it("holds a writer with a floor to their allowance", () => {
    const mel: WriterReplyInput = { ...jab, persona: "mel-diaper", languageRating: "unfiltered" };
    const ceiling = getPersona("mel-diaper").language.allowance.unfiltered;
    expect(verifyWriterReply("Damn. Hell of a call, Gabe.", mel)).toEqual([]);
    const over = `${"Damn. ".repeat(ceiling + 1)}Gabe.`;
    expect(verifyWriterReply(over, mel)).toEqual([`language_over_allowance: ${ceiling + 1} > ${ceiling}`]);
  });

  it("never counts the manager's team name as profanity", () => {
    const damnYankees: WriterReplyInput = { ...jab, languageRating: "clean", manager: { ...jab.manager, teamName: "Damn Yankees" } };
    expect(verifyWriterReply("Damn Yankees again, Gabe.", damnYankees)).toEqual([]);
  });

  it("chase mode needs exactly one question mark", () => {
    expect(verifyWriterReply("I ask what changed between Wednesday and the gut call?", chase)).toEqual([]);
    expect(verifyWriterReply("I ask what changed.", chase)).toEqual(["chase_questions: 0"]);
    expect(verifyWriterReply("Gut call? Whose gut?", chase)).toEqual(["chase_questions: 2"]);
  });

  it("chase mode is clean when the league is clean, and checks names against the post", () => {
    expect(verifyWriterReply("I ask Riv what the hell changed?", chase)).toEqual(["language_over_rating: hell at clean"]);
    expect(verifyWriterReply("I ask Team Rive what Coach Smith said?", chase)).toEqual(["unknown_name: Coach Smith"]);
  });
});
