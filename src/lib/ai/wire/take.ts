// The Wire — tier-1 take generation (spec §3.1). The ONLY module in src/lib/ai/wire that may
// import the Anthropic SDK; nothing else in the folder imports this file, so the Convex default
// runtime never sees it. `convex/wireGenerate.ts` ("use node") calls `generateWireTakes`.
//
// One call per persona per batch window: a JSON array of fact cards in, one tool call out with a
// take set per card. The persona system prompt is stable across batches and carries a cache
// breakpoint, so the long part is paid once per window.
//
// Never throws for a bad model output — every problem becomes a flag on the result so the post
// falls back to its plain card. Throws only for transport/auth errors so the caller can flag
// "generation_error".

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { computeCostUsd } from "../content-generation-service";
import { countProfanity } from "../language";
import { getPersona } from "../persona-prompts";
import { GROUNDING_CONTRACT, buildWhoYouAreBlock, voiceSamplesFor } from "../prompt-builder";
import { sourceLabel } from "./card";
import { isSlotToken, templateTokens } from "./fill";
import {
  MAX_POST_CHARS,
  SLOT_TOKENS,
  WIRE_DEFAULT_ROUTE,
  WIRE_TAGS,
  type WireFactCard,
  type WirePersona,
  type WireTag,
  type WireTakeSet,
} from "./types";
import { verifyTake } from "./verify";

/* ------------------------------------------------------------------------------------------- *
 * Public shapes (W-A codes against these)
 * ------------------------------------------------------------------------------------------- */

export interface WireTakeInput {
  postId: string;
  card: WireFactCard;
}

export interface WireTakeResult {
  postId: string;
  /** Absent when the model gave nothing usable; `flags` says why. */
  take?: WireTakeSet;
  flags: string[];
}

export interface WireTakeBatchResult {
  results: WireTakeResult[];
  costUsd: number;
  model: string;
  effort: string;
}

/* ------------------------------------------------------------------------------------------- *
 * Route
 * ------------------------------------------------------------------------------------------- */

export type WireRouteModel = "claude-opus-5" | "claude-sonnet-5";
export type WireRouteEffort = "low" | "medium";
export interface WireRoute {
  model: WireRouteModel;
  effort: WireRouteEffort;
}

/** Env var holding a JSON `{ model, effort }` that replaces WIRE_DEFAULT_ROUTE. */
export const WIRE_ROUTE_OVERRIDE_ENV = "WIRE_ROUTE_OVERRIDE";

function isRouteModel(value: unknown): value is WireRouteModel {
  return value === "claude-opus-5" || value === "claude-sonnet-5";
}
function isRouteEffort(value: unknown): value is WireRouteEffort {
  return value === "low" || value === "medium";
}

let overrideCache: { raw: string; route: WireRoute | null } | null = null;

/**
 * WIRE_DEFAULT_ROUTE unless `WIRE_ROUTE_OVERRIDE` holds valid JSON of the shape
 * `{ model: "claude-opus-5" | "claude-sonnet-5", effort: "low" | "medium" }`. Malformed values are
 * logged once and ignored — a bad env var must never take the wire offline.
 */
export function resolveWireRoute(raw: string | undefined = process.env[WIRE_ROUTE_OVERRIDE_ENV]): WireRoute {
  if (!raw || raw.trim().length === 0) return { ...WIRE_DEFAULT_ROUTE };
  if (overrideCache?.raw === raw) return overrideCache.route ?? { ...WIRE_DEFAULT_ROUTE };
  let route: WireRoute | null = null;
  try {
    const parsed: unknown = JSON.parse(raw);
    const model = (parsed as { model?: unknown } | null)?.model;
    const effort = (parsed as { effort?: unknown } | null)?.effort;
    if (isRouteModel(model) && isRouteEffort(effort)) {
      route = { model, effort };
    } else {
      console.warn(
        `Ignoring ${WIRE_ROUTE_OVERRIDE_ENV}: expected { model: "claude-opus-5" | "claude-sonnet-5", effort: "low" | "medium" }`
      );
    }
  } catch (error) {
    console.warn(`${WIRE_ROUTE_OVERRIDE_ENV} is not valid JSON; ignoring it`, error);
  }
  overrideCache = { raw, route };
  return route ?? { ...WIRE_DEFAULT_ROUTE };
}

/* ------------------------------------------------------------------------------------------- *
 * Prompt
 * ------------------------------------------------------------------------------------------- */

const SLOT_LIST = SLOT_TOKENS.map(token => `{${token}}`).join(" ");

/** The Wire's own contract: what a live post is, what it may say, and how the variants work. */
export const WIRE_CONTRACT = `THE WIRE CONTRACT — the live feed. Where this differs from the article rules above, this wins.

You are posting to The Wire, FFSN's live league feed: one to three sentences, in your voice, reacting
to a fact card the moment it lands. For this job the fact card in the user message is your <FACTS>
block; there is nothing else.

Rules for every string you return:
1. At most ${MAX_POST_CHARS} characters. Shorter is better. One sentence can be the whole post.
2. The only facts you may state are on the card: the player(s), the NFL team, the position, the status
   change, the text of the note, the headline, the depth-chart move, the trending count. Nothing else —
   no stats, no history, no other players, no dates or days, no "this week's game", no guess at what
   the injury is or how bad it is.
3. A timetable ("6-8 weeks", "week-to-week", "season-ending") appears only if the card has a
   "timetable" field, and then you quote it exactly as written. No timetable on the card means you do
   not say how long. Never a medical guess.
4. Attribute to the card's source only — "per ESPN", "ESPN says", "on Sleeper". Never name a reporter,
   a beat writer or an outlet that appears inside the note: "per Schefter" and "the Athletic reports"
   are wrong even when the note says so. No unnamed sources, ever.
5. Write CLEAN: no profanity, whatever your usual range. This post goes to every league at once.
6. "global" is finished prose for every league. It contains no {slot} tokens and no fantasy team or
   manager names — you do not know who rosters him.
7. "owner", "opponent" and "freeAgent" are optional league-specific TEMPLATES. Every fantasy team,
   manager and league-specific figure in them is a slot token from this list and nothing else:
   ${SLOT_LIST}
   - owner: to the manager who rosters the player. {team} is their team; {faab}, {bestFA}, {backup},
     {pos}, {timetable}, {status} and {player} are available.
   - opponent: to the team facing that manager this week. {team} is the opponent; {ownerTeam} is the
     team that rosters the player.
   - freeAgent: to leagues where the player, or his {backup}, is unrostered. {backup} is the next man
     up on the NFL depth chart; {trendingAdds} is how many Sleeper leagues added the man you are
     recommending in the last day (write it next to him, not next to the injured player); {bestFA}
     and {faab} are available.
   Write each variant so every sentence stands alone: a sentence whose slots cannot be filled in a
   league is dropped whole. Skip a variant rather than pad one.
8. Tags come from ${WIRE_TAGS.join(", ")}. REPORTED: the fact is in the source's report (a status
   change, a note, a headline). STATED: the note quotes someone on the record (a coach, the player)
   and you are relaying what they said. OPINION: your own read, flagged as yours. LIVE, FINAL and
   UPDATE belong to the live game desk; do not use them here. Most posts carry one tag; REPORTED
   plus OPINION when you add a read.
9. Broadcast register, as always: no field names, no ids, no timestamps, no JSON in the prose.

Return exactly one entry per card, keyed by its postId, through the wire_takes tool.`;

/** The whole system prompt for one persona: contract, identity (clean), voice samples, Wire contract. */
export function buildWireSystemPrompt(persona: WirePersona | string): string {
  const prompt = getPersona(persona);
  const samples = voiceSamplesFor(prompt, "clean");
  const parts = [GROUNDING_CONTRACT, buildWhoYouAreBlock(prompt, "clean")];
  if (samples.length > 0) {
    parts.push(`VOICE SAMPLES — style only. The braces are placeholders, not content. Never copy a
placeholder, a number, or a name out of these lines into a post.
${samples.map(sample => `- ${sample}`).join("\n")}`);
  }
  parts.push(WIRE_CONTRACT);
  return parts.join("\n\n");
}

/**
 * The card as the model sees it: the facts, minus ids, timestamps and source plumbing. The source
 * becomes its public label so the model attributes to "ESPN"/"Sleeper" and nothing more specific.
 */
export function modelCardView(card: WireFactCard): Record<string, unknown> {
  return {
    kind: card.kind,
    players: card.players.map(player => ({
      name: player.name,
      position: player.position,
      nflTeam: player.nflTeam,
      percentOwned: player.percentOwned,
      adpPositionRank: player.adpPositionRank,
    })),
    nflTeam: card.nflTeam,
    statusFrom: card.statusFrom,
    statusTo: card.statusTo,
    note: card.note,
    headline: card.headline,
    timetable: card.timetable,
    depthOrderFrom: card.depthOrderFrom,
    depthOrderTo: card.depthOrderTo,
    depthPosition: card.depthPosition,
    trendingAdds: card.trendingAdds,
    source: sourceLabel(card.source.type),
  };
}

const WireTakeItemSchema = z.object({
  postId: z.string().describe("The postId of the card this take answers"),
  global: z.string().describe("The finished post for every league. Plain prose, no {slot} tokens, no fantasy team names."),
  owner: z.string().optional().describe("Template for the team that rosters the player; {slot} tokens for every league-specific name."),
  opponent: z.string().optional().describe("Template for that team's opponent this week."),
  freeAgent: z.string().optional().describe("Template for leagues where the player or his backup is unrostered."),
  tags: z.array(z.enum(WIRE_TAGS)).describe("One or two of REPORTED, STATED, OPINION"),
});

export const WireTakesToolSchema = z.object({
  takes: z.array(WireTakeItemSchema).describe("One entry per card, in any order"),
});

export const WIRE_TAKES_TOOL_NAME = "wire_takes";

/** Output budget: ~320 tokens per card (four strings and tags) plus a little for the wrapper. */
export function wireMaxTokens(count: number): number {
  return 320 * count + 200;
}

export interface PreparedWireTakeRequest {
  params: Anthropic.MessageCreateParamsNonStreaming;
  route: WireRoute;
  systemPrompt: string;
}

/** Exactly what `generateWireTakes` sends, for the eval script and tests. No network. */
export function prepareWireTakeRequest(
  inputs: WireTakeInput[],
  persona: WirePersona | string,
  route: WireRoute = resolveWireRoute()
): PreparedWireTakeRequest {
  const systemPrompt = buildWireSystemPrompt(persona);
  const userMessage = JSON.stringify(
    inputs.map(input => ({ postId: input.postId, card: modelCardView(input.card) })),
    null,
    2
  );
  const params: Anthropic.MessageCreateParamsNonStreaming = {
    model: route.model,
    max_tokens: wireMaxTokens(inputs.length),
    output_config: { effort: route.effort },
    system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: userMessage }],
    tools: [
      {
        name: WIRE_TAKES_TOOL_NAME,
        strict: true,
        description: "Return one take set per fact card for The Wire",
        input_schema: { ...zodToJsonSchema(WireTakesToolSchema, { $refStrategy: "none" }), type: "object" } as const,
      },
    ],
    tool_choice: { type: "tool", name: WIRE_TAKES_TOOL_NAME },
  };
  return { params, route, systemPrompt };
}

/** Same request with `strict` removed from every tool definition (the API's strict-mode fallback). */
export function withoutStrictTools(params: Anthropic.MessageCreateParamsNonStreaming): Anthropic.MessageCreateParamsNonStreaming {
  if (!params.tools) return params;
  return {
    ...params,
    tools: params.tools.map(tool => ("strict" in tool ? ({ ...tool, strict: undefined } as typeof tool) : tool)),
  };
}

/* ------------------------------------------------------------------------------------------- *
 * Parsing
 * ------------------------------------------------------------------------------------------- */

/** The part of an Anthropic message the parser reads; hand-built objects satisfy it in tests. */
export interface WireModelMessage {
  content: ReadonlyArray<{ type: string; name?: string; input?: unknown }>;
  stop_reason?: string | null;
}

// Lenient per-item shape: a stray null or a bad tag must cost one field, never the whole batch.
const LenientTakeItem = z.object({
  postId: z.union([z.string(), z.number()]).transform(value => String(value)),
  global: z.string(),
  owner: z.string().nullish(),
  opponent: z.string().nullish(),
  freeAgent: z.string().nullish(),
  tags: z.array(z.unknown()).nullish(),
});

const LenientTakes = z.object({ takes: z.array(z.unknown()) });

const TAG_SET: ReadonlySet<string> = new Set(WIRE_TAGS);
const TOKEN_PATTERN = /\{([A-Za-z]+)\}/g;

function normaliseTags(raw: unknown[] | null | undefined): WireTag[] {
  const out: WireTag[] = [];
  for (const value of raw ?? []) {
    if (typeof value !== "string") continue;
    const tag = value.trim().toUpperCase();
    if (TAG_SET.has(tag) && !out.includes(tag as WireTag)) out.push(tag as WireTag);
  }
  return out.length > 0 ? out : ["REPORTED"];
}

/** Violations for the global string: the card check, plus clean language and no slot tokens. */
function globalViolations(text: string, card: WireFactCard): string[] {
  const violations = [...verifyTake(text, card).violations];
  const { words } = countProfanity(text);
  if (words.length > 0) violations.push(`profanity: ${words.join(", ")}`);
  for (const token of templateTokens(text)) violations.push(`slot_token_in_global: {${token}}`);
  return violations;
}

/**
 * Violations for a variant template: unknown tokens, length, language, and the card check run on
 * the template with its slots blanked (so `{nflTeam}` is not read as a field name and `{team}` is
 * not read as a proper noun).
 */
function variantViolations(text: string, card: WireFactCard): string[] {
  const violations: string[] = [];
  for (const token of templateTokens(text)) if (!isSlotToken(token)) violations.push(`unknown_token: {${token}}`);
  const { words } = countProfanity(text);
  if (words.length > 0) violations.push(`profanity: ${words.join(", ")}`);
  const blanked = text.replace(TOKEN_PATTERN, "slot");
  violations.push(...verifyTake(blanked, card).violations);
  return violations;
}

function cleanVariant(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Turns the model's tool call into one result per input. Missing → `take_missing`; a global that
 * fails verification → no take, the violations as flags; a variant that fails → that variant
 * dropped, flagged with its name. Never throws.
 */
export function parseWireTakes(message: WireModelMessage, inputs: WireTakeInput[]): WireTakeResult[] {
  const truncated = message.stop_reason === "max_tokens";
  const toolUse = message.content.find(block => block.type === "tool_use" && block.name === WIRE_TAKES_TOOL_NAME) ??
    message.content.find(block => block.type === "tool_use");

  const items = new Map<string, z.infer<typeof LenientTakeItem>>();
  const batchFlags: string[] = [];
  if (!toolUse) {
    batchFlags.push("no_tool_call");
  } else {
    const parsed = LenientTakes.safeParse(toolUse.input);
    if (!parsed.success) {
      batchFlags.push("parse_error: takes[] missing");
    } else {
      for (const raw of parsed.data.takes) {
        const item = LenientTakeItem.safeParse(raw);
        if (!item.success) {
          batchFlags.push("parse_error: bad take entry");
          continue;
        }
        if (!items.has(item.data.postId)) items.set(item.data.postId, item.data);
      }
    }
  }
  if (truncated) batchFlags.push("max_tokens");

  return inputs.map(input => {
    const item = items.get(input.postId);
    if (!item) return { postId: input.postId, flags: ["take_missing", ...batchFlags] };

    const global = item.global.trim();
    const violations = globalViolations(global, input.card);
    if (violations.length > 0) return { postId: input.postId, flags: violations };

    const flags: string[] = [];
    const take: WireTakeSet = { global, tags: normaliseTags(item.tags) };
    const variants: Array<["owner" | "opponent" | "freeAgent", string | undefined]> = [
      ["owner", cleanVariant(item.owner)],
      ["opponent", cleanVariant(item.opponent)],
      ["freeAgent", cleanVariant(item.freeAgent)],
    ];
    for (const [name, text] of variants) {
      if (!text) continue;
      const problems = variantViolations(text, input.card);
      if (problems.length > 0) {
        for (const problem of problems) flags.push(`${name}: ${problem}`);
        continue;
      }
      take[name] = text;
    }
    return { postId: input.postId, take, flags };
  });
}

/* ------------------------------------------------------------------------------------------- *
 * Generation
 * ------------------------------------------------------------------------------------------- */

/**
 * One model call for every card in `inputs`, as `persona`. Throws only for transport/auth errors;
 * a bad model output is returned as flags. An empty batch costs nothing and makes no call.
 */
export async function generateWireTakes(
  inputs: WireTakeInput[],
  persona: WirePersona,
  apiKey: string
): Promise<WireTakeBatchResult> {
  const route = resolveWireRoute();
  if (inputs.length === 0) return { results: [], costUsd: 0, model: route.model, effort: route.effort };

  const { params } = prepareWireTakeRequest(inputs, persona, route);
  const anthropic = new Anthropic({ apiKey });

  let message: Anthropic.Message;
  try {
    message = await anthropic.messages.create(params);
  } catch (error) {
    if (error instanceof Anthropic.BadRequestError && /strict/i.test(error.message)) {
      console.warn("Strict tool schema rejected by the API; retrying the wire batch without strict:", error.message);
      message = await anthropic.messages.create(withoutStrictTools(params));
    } else {
      throw error;
    }
  }

  return {
    results: parseWireTakes(message, inputs),
    costUsd: computeCostUsd(message.model, message.usage),
    model: message.model,
    effort: route.effort,
  };
}
