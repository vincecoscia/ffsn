import { afterEach, describe, expect, it, vi } from "vitest";
import { GROUNDING_CONTRACT } from "../src/lib/ai/prompt-builder";
import {
  buildWireSystemPrompt,
  modelCardView,
  parseWireTakes,
  prepareWireTakeRequest,
  resolveWireRoute,
  WIRE_TAKES_TOOL_NAME,
  wireMaxTokens,
  type WireModelMessage,
  type WireTakeInput,
} from "../src/lib/ai/wire/take";
import { SLOT_TOKENS, WIRE_DEFAULT_ROUTE, type WireFactCard } from "../src/lib/ai/wire/types";

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

const chase: WireFactCard = {
  kind: "injury_note",
  observedAt: 1_800_000_000_000,
  players: [{ espnId: "4362628", name: "Ja'Marr Chase", position: "WR", nflTeam: "CIN" }],
  nflTeam: "CIN",
  statusTo: "Questionable",
  note: "Chase (hip) was limited in practice Thursday.",
  source: { type: "espn_injuries", id: "636277", fetchedAt: 1_800_000_000_000 },
};

const inputs: WireTakeInput[] = [
  { postId: "p1", card: burrow },
  { postId: "p2", card: chase },
];

const GOOD_TAKE = {
  postId: "p1",
  global: "Burrow: toe, surgery, 6-8 weeks per ESPN. REPORTED. Questionable to Out. Stand by.",
  owner: "{team} loses {player} for {timetable}. {faab} FAAB left. {bestFA} is the best {pos} on waivers.",
  opponent: "{team} draws {ownerTeam} the week {player} goes {status}. Take the gift.",
  freeAgent: "{backup} is the add if he is on your wire. {trendingAdds} Sleeper leagues grabbed him in the last day.",
  tags: ["REPORTED"],
};

function toolMessage(input: unknown, stopReason: string | null = "tool_use"): WireModelMessage {
  return {
    content: [
      { type: "text" },
      { type: "tool_use", name: WIRE_TAKES_TOOL_NAME, input },
    ],
    stop_reason: stopReason,
  };
}

describe("resolveWireRoute", () => {
  afterEach(() => vi.restoreAllMocks());

  it("defaults to Sonnet low", () => {
    expect(resolveWireRoute(undefined)).toEqual(WIRE_DEFAULT_ROUTE);
    expect(resolveWireRoute("")).toEqual(WIRE_DEFAULT_ROUTE);
  });

  it("honours a valid override", () => {
    expect(resolveWireRoute(JSON.stringify({ model: "claude-opus-5", effort: "medium" }))).toEqual({ model: "claude-opus-5", effort: "medium" });
  });

  it("logs and ignores a malformed override", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(resolveWireRoute("{not json")).toEqual(WIRE_DEFAULT_ROUTE);
    expect(resolveWireRoute(JSON.stringify({ model: "gpt-5", effort: "low" }))).toEqual(WIRE_DEFAULT_ROUTE);
    expect(resolveWireRoute(JSON.stringify({ model: "claude-opus-5", effort: "max" }))).toEqual(WIRE_DEFAULT_ROUTE);
    expect(warn).toHaveBeenCalled();
  });
});

describe("prepareWireTakeRequest", () => {
  const prepared = prepareWireTakeRequest(inputs, "dex-alvarez", { model: "claude-sonnet-5", effort: "low" });

  it("builds a cached system block: grounding contract, Dex's identity at clean, voice samples, the Wire contract", () => {
    const system = prepared.params.system;
    expect(Array.isArray(system)).toBe(true);
    if (!Array.isArray(system)) return;
    expect(system).toHaveLength(1);
    expect(system[0].type).toBe("text");
    expect(system[0].cache_control).toEqual({ type: "ephemeral" });
    const text = system[0].text;
    expect(text.startsWith(GROUNDING_CONTRACT)).toBe(true);
    expect(text).toContain("WHO YOU ARE");
    expect(text).toContain("You are Dex Alvarez");
    expect(text).toContain("VOICE SAMPLES");
    expect(text).toContain("THE WIRE CONTRACT");
    expect(text).toContain("Write CLEAN");
    expect(text).toContain("REPORTED");
    expect(text).toContain("STATED");
    expect(text).toContain("OPINION");
    // Clean: no language trait rendered.
    expect(text).not.toContain("Your language (this league runs");
    for (const token of SLOT_TOKENS) expect(text).toContain(`{${token}}`);
    expect(buildWireSystemPrompt("dex-alvarez")).toBe(text);
  });

  it("forces the wire_takes tool with a strict schema and sizes max_tokens per card", () => {
    expect(prepared.params.model).toBe("claude-sonnet-5");
    expect(prepared.params.output_config).toEqual({ effort: "low" });
    expect(prepared.params.max_tokens).toBe(wireMaxTokens(2));
    expect(wireMaxTokens(2)).toBe(840);
    expect(prepared.params.tool_choice).toEqual({ type: "tool", name: WIRE_TAKES_TOOL_NAME });
    const tool = prepared.params.tools?.[0];
    expect(tool?.name).toBe(WIRE_TAKES_TOOL_NAME);
    expect(tool && "strict" in tool ? tool.strict : undefined).toBe(true);
    const schema = tool && "input_schema" in tool ? (tool.input_schema as { properties?: Record<string, unknown> }) : undefined;
    expect(schema?.properties).toHaveProperty("takes");
  });

  it("sends the cards as a JSON array without ids, timestamps or source plumbing", () => {
    const content = prepared.params.messages[0].content;
    expect(typeof content).toBe("string");
    const parsed = JSON.parse(content as string) as Array<{ postId: string; card: Record<string, unknown> }>;
    expect(parsed.map(item => item.postId)).toEqual(["p1", "p2"]);
    expect(parsed[0].card).toEqual(modelCardView(burrow));
    expect(parsed[0].card.source).toBe("ESPN");
    expect(JSON.stringify(parsed)).not.toContain("3915511");
    expect(JSON.stringify(parsed)).not.toContain("observedAt");
    expect(JSON.stringify(parsed)).not.toContain("fetchedAt");
    expect(parsed[0].card.timetable).toBe("6-8 weeks");
  });
});

describe("parseWireTakes", () => {
  it("returns a full take set for a good entry and take_missing for an absent one", () => {
    const results = parseWireTakes(toolMessage({ takes: [GOOD_TAKE] }), inputs);
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      postId: "p1",
      take: {
        global: GOOD_TAKE.global,
        owner: GOOD_TAKE.owner,
        opponent: GOOD_TAKE.opponent,
        freeAgent: GOOD_TAKE.freeAgent,
        tags: ["REPORTED"],
      },
      flags: [],
    });
    expect(results[1]).toEqual({ postId: "p2", flags: ["take_missing"] });
  });

  it("drops the whole take when the global fails verification, with the violations as flags", () => {
    const bad = { ...GOOD_TAKE, global: "Burrow threw for 4,200 yards last year and is out 6-8 weeks, Schefter of ESPN reports." };
    const [result] = parseWireTakes(toolMessage({ takes: [bad] }), inputs);
    expect(result.take).toBeUndefined();
    expect(result.flags).toContain("unverified_number: 4200");
    expect(result.flags.some(flag => flag.startsWith("reporter_attribution"))).toBe(true);
  });

  it("drops a global with profanity or a slot token", () => {
    const sweary = parseWireTakes(toolMessage({ takes: [{ ...GOOD_TAKE, global: "Burrow is out 6-8 weeks. Damn. REPORTED." }] }), inputs)[0];
    expect(sweary.take).toBeUndefined();
    expect(sweary.flags).toContain("profanity: damn");

    const templated = parseWireTakes(toolMessage({ takes: [{ ...GOOD_TAKE, global: "{team} loses Burrow for 6-8 weeks per ESPN." }] }), inputs)[0];
    expect(templated.take).toBeUndefined();
    expect(templated.flags).toContain("slot_token_in_global: {team}");
  });

  it("drops only the offending variant and keeps the rest", () => {
    const entry = {
      ...GOOD_TAKE,
      owner: "{team} loses {player} and {dropped} is the drop.",
      opponent: `{team} draws {ownerTeam}. ${"x".repeat(280)}`,
      freeAgent: "{backup} is the add. Jake Browning is the name. 1,500 leagues agree.",
    };
    const [result] = parseWireTakes(toolMessage({ takes: [entry] }), inputs);
    expect(result.take?.global).toBe(GOOD_TAKE.global);
    expect(result.take?.owner).toBeUndefined();
    expect(result.take?.opponent).toBeUndefined();
    expect(result.take?.freeAgent).toBeUndefined();
    expect(result.flags).toContain("owner: unknown_token: {dropped}");
    expect(result.flags.some(flag => flag.startsWith("opponent: too_long"))).toBe(true);
    expect(result.flags).toContain("freeAgent: unknown_name: Jake Browning");
    expect(result.flags).toContain("freeAgent: unverified_number: 1500");
  });

  it("does not read a slot token as a field name or a person", () => {
    const entry = { ...GOOD_TAKE, owner: "{team} rosters {player}, and he just moved up the {nflTeam} depth chart. {manager} knows." };
    const [result] = parseWireTakes(toolMessage({ takes: [entry] }), inputs);
    expect(result.flags).toEqual([]);
    expect(result.take?.owner).toBe(entry.owner);
  });

  it("normalises tags: case-folds, drops unknowns, defaults to REPORTED", () => {
    const entries = [
      { ...GOOD_TAKE, tags: ["reported", "Opinion", "BREAKING"] },
      { ...GOOD_TAKE, postId: "p2", global: "Chase: hip, limited Thursday per ESPN. Questionable. REPORTED.", tags: [] },
    ];
    const results = parseWireTakes(toolMessage({ takes: entries }), inputs);
    expect(results[0].take?.tags).toEqual(["REPORTED", "OPINION"]);
    expect(results[1].take?.tags).toEqual(["REPORTED"]);
  });

  it("treats null variants as absent and keeps the first entry for a duplicate postId", () => {
    const entries = [
      { ...GOOD_TAKE, owner: null, opponent: null, freeAgent: null },
      { ...GOOD_TAKE, global: "A second take that should be ignored. 6-8 weeks." },
    ];
    const [result] = parseWireTakes(toolMessage({ takes: entries }), inputs);
    expect(result.take?.global).toBe(GOOD_TAKE.global);
    expect(result.take?.owner).toBeUndefined();
    expect(result.flags).toEqual([]);
  });

  it("flags every input when there is no tool call, and adds max_tokens when the output was cut", () => {
    const none = parseWireTakes({ content: [{ type: "text" }], stop_reason: "end_turn" }, inputs);
    expect(none.map(result => result.flags)).toEqual([
      ["take_missing", "no_tool_call"],
      ["take_missing", "no_tool_call"],
    ]);
    const cut = parseWireTakes(toolMessage({ takes: [GOOD_TAKE] }, "max_tokens"), inputs);
    expect(cut[0].flags).toEqual([]);
    expect(cut[1].flags).toEqual(["take_missing", "max_tokens"]);
  });

  it("survives a malformed tool payload without throwing", () => {
    expect(parseWireTakes(toolMessage({ nope: true }), inputs).map(result => result.flags[0])).toEqual(["take_missing", "take_missing"]);
    const mixed = parseWireTakes(toolMessage({ takes: [42, GOOD_TAKE] }), inputs);
    expect(mixed[0].take?.global).toBe(GOOD_TAKE.global);
    expect(mixed[1].flags).toEqual(["take_missing", "parse_error: bad take entry"]);
  });
});

describe("module boundaries", () => {
  const sources = import.meta.glob("../src/lib/ai/wire/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

  it("keeps the Anthropic SDK, Node built-ins, the @/ alias and take.ts out of every pure module", () => {
    const files = Object.keys(sources);
    expect(files.length).toBeGreaterThanOrEqual(9);
    for (const [file, source] of Object.entries(sources)) {
      // take.ts and reply.ts (spec §17.3) are the two "use node" entry points; everything else is
      // imported by the Convex default runtime and must stay pure.
      if (file.endsWith("/take.ts") || file.endsWith("/reply.ts")) {
        expect(source).toContain("@anthropic-ai/sdk");
        continue;
      }
      expect(source, file).not.toContain("@anthropic-ai/sdk");
      expect(source, file).not.toMatch(/from ["']node:/);
      expect(source, file).not.toMatch(/from ["']@\//);
      expect(source, file).not.toMatch(/from ["']\.\/take["']/);
      expect(source, file).not.toMatch(/from ["'](?:\.\.\/)+convex\//);
    }
  });
});
