// The Wire — writer replies (spec §17.3). With take.ts, the only module in src/lib/ai/wire that
// may import the Anthropic SDK; nothing else in the folder imports this file, so the Convex default
// runtime never sees it. The "use node" Convex action calls `generateWriterReply`.
//
// One call per reply: a manager's words in, one tool call out with the writer's answer (at most
// MAX_POST_CHARS) and a classification of how the manager's text read toward the writer. The answer
// is verified deterministically before it is returned; a failed answer posts nothing, but the
// sentiment still counts — the relationship meter moves on what the manager said, not on whether
// the desk found the words.
//
// Never throws for a bad model output — every problem becomes a flag on the result. Throws only for
// transport/auth errors so the caller can record "generation_error".

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { computeCostUsd } from "../content-generation-service";
import { findRegisterLeaks } from "../fact-verifier";
import { countProfanity, MILD_PROFANITY, type LanguageRating } from "../language";
import { effectiveLanguageRange, fnv1a, getPersona, type PersonaPrompt, type RelationshipTier } from "../persona-prompts";
import { GROUNDING_CONTRACT, buildWhoYouAreBlock, voiceSamplesFor } from "../prompt-builder";
import { cardNames, cardNumbers, extractNumbers, properNouns } from "./card";
import { modelCardView, resolveWireRoute, withoutStrictTools, type WireModelMessage, type WireRoute } from "./take";
import {
  MAX_POST_CHARS,
  MAX_THREAD_CONTEXT,
  type WirePersona,
  type WriterReplyInput,
  type WriterReplyResult,
  type WriterReplySentiment,
} from "./types";
import { reporterViolations, timetableViolations, unknownNames } from "./verify";

/* ------------------------------------------------------------------------------------------- *
 * Constants
 * ------------------------------------------------------------------------------------------- */

export const WIRE_REPLY_TOOL_NAME = "wire_reply";

/** Output budget: one short post, a one-word classification, and headroom for the model's thinking. */
export const WIRE_REPLY_MAX_TOKENS = 400;

/** Sam is the only writer who chases a standalone manager post (spec §17.3). */
export const CHASE_PERSONA: WirePersona = "sam-ortega";

const RELATIONSHIP_TIERS: ReadonlySet<string> = new Set(["feud", "cold", "neutral", "warm", "favorite"]);
const SENTIMENTS: ReadonlySet<string> = new Set(["jab", "thanks", "neutral"]);
const MILD_SET: ReadonlySet<string> = new Set(MILD_PROFANITY);

/* ------------------------------------------------------------------------------------------- *
 * Input helpers
 * ------------------------------------------------------------------------------------------- */

/** The tier as the posture table knows it; anything else reads as neutral rather than throwing. */
export function relationshipTierOf(value: string): RelationshipTier {
  return RELATIONSHIP_TIERS.has(value) ? (value as RelationshipTier) : "neutral";
}

/** The persona that actually answers: Sam in chase mode, whoever was replied to otherwise. */
export function replyPersona(input: WriterReplyInput): WirePersona {
  return input.mode === "chase" ? CHASE_PERSONA : input.persona;
}

/** Clean when the manager opted their team down, else the league's rating. */
export function effectiveReplyRating(input: WriterReplyInput): LanguageRating {
  return input.cleanTeam ? "clean" : input.languageRating;
}

/** The last MAX_THREAD_CONTEXT turns, oldest first. */
function threadContext(input: WriterReplyInput): WriterReplyInput["thread"] {
  return input.thread.slice(-MAX_THREAD_CONTEXT);
}

/**
 * The seed every language choice for one reply shares (the reserved desk's one, sample rotation):
 * derived from the thread and the manager's words, so the same thread always gets the same answer
 * to "is this one of the pieces where the one is available" and a new thread rolls again.
 */
export function replyLanguageSeed(input: WriterReplyInput): string {
  const text = [...threadContext(input).map(turn => turn.text), input.managerText].join("\n");
  return `wire-${input.mode}:${fnv1a(text)}`;
}

/** Every piece of text the writer was shown besides the card: the thread, the manager, their own post, the history. */
function contextTexts(input: WriterReplyInput): string[] {
  const out = threadContext(input).map(turn => turn.text);
  out.push(input.managerText);
  if (input.writerPostText) out.push(input.writerPostText);
  out.push(...input.manager.recentEvidence);
  return out;
}

/* ------------------------------------------------------------------------------------------- *
 * Prompt
 * ------------------------------------------------------------------------------------------- */

/** The Wire's reply contract: what a reply is, what it may say, and what the classification means. */
export const WIRE_REPLY_CONTRACT = `THE WIRE REPLY CONTRACT — the live feed. Where this differs from the article rules above, this wins.

You are on The Wire, FFSN's live league feed, answering a manager in this league. This is not an
article: it is one post, at most ${MAX_POST_CHARS} characters, in your voice. The user message carries
everything you know — the post of yours they answered (if any), the fact card behind it (if any), the
thread so far, and the manager's own words. For this job that is your <FACTS> block; there is nothing
else.

1. At most ${MAX_POST_CHARS} characters. Shorter is better. One sentence can be the whole post.
2. The only facts you may state are on the fact card (when there is one) and in the thread as written.
   No stats, no history, no other players, no dates or days, no claims from anywhere else. If the
   manager asserts something that is not on the card, you may say you don't have it; you may not
   confirm it, and you may not correct it with a fact of your own.
3. Never a medical guess. A timetable ("6-8 weeks", "season-ending", "week-to-week") appears only if
   the card has one, and then quoted exactly as written. Injured reserve is a status, not a timetable.
   Attribute only to the card's source ("per ESPN"), never to a reporter or an outlet.
4. You sent this manager no request for comment and nobody declined one. Never print a non-response,
   a request day or "did not respond" — the manager is talking to you right now.
5. Quote at most a short fragment of the manager's own words back at them, never the whole post.
6. Your standing with this manager (THIS MANAGER, below) decides your posture, not your facts. Push
   back, tease, concede — in character — but the receipts stay on the card.
7. Language: the league's rating applies exactly as WHO YOU ARE describes it. Where that block sets no
   range, you write clean. A manager who opted their team down to clean coverage gets clean, whatever
   the league runs — you will have been told.
8. Broadcast register, as always: no field names, no ids, no timestamps, no JSON in the prose, no
   {slot} tokens.
9. Modes (the mode is named under THIS MANAGER):
   - reply: answer the manager in voice, one to three sentences.
   - chase (Sam Ortega only): you have read either a manager's standalone post or a plain
     description of a move they just made (the mode line under THIS MANAGER says which), and you ask
     EXACTLY ONE question about it. No opinion, no numbers, no second question. Present tense,
     reporter's notebook — "I ask …" is your register — and the question mark is the only one in the
     post. When it is a move, the description is not the manager's words: ask about the decision, and
     never quote the description back as if they said it.
10. Also classify how the MANAGER's text reads toward you: "jab" (hostile, mocking or dismissive of
   you or your work), "thanks" (friendly, appreciative, giving you credit), or "neutral" (everything
   else, including a plain question or a disagreement on the merits). Classify their words, not your
   reply.

Return the post and the classification through the ${WIRE_REPLY_TOOL_NAME} tool.`;

/**
 * The stable part of the system prompt for one persona at one rating: contract, identity (with the
 * language trait for this seed), voice samples, the reply contract. Cached; nothing per-manager here.
 */
export function buildWireReplySystemPrompt(persona: PersonaPrompt, rating: LanguageRating, seed: string): string {
  const samples = voiceSamplesFor(persona, rating, seed);
  const parts = [GROUNDING_CONTRACT, buildWhoYouAreBlock(persona, rating, seed)];
  if (samples.length > 0) {
    parts.push(`VOICE SAMPLES — style only. The braces are placeholders, not content. Never copy a
placeholder, a number, or a name out of these lines into a post.
${samples.map(sample => `- ${sample}`).join("\n")}`);
  }
  parts.push(WIRE_REPLY_CONTRACT);
  return parts.join("\n\n");
}

/**
 * The per-manager part of the system prompt, after the cache breakpoint: who they are, the standing,
 * this persona's posture at that tier verbatim, the shared history, and the mode.
 */
export function buildStandingBlock(persona: PersonaPrompt, input: WriterReplyInput): string {
  const tier = relationshipTierOf(input.manager.relationshipTier);
  const lines = [
    "THIS MANAGER",
    `The manager is ${input.manager.displayName} of ${input.manager.teamName}. Your standing with them is ${tier}.`,
    `How you treat a manager at ${tier}: ${persona.relationshipPosture[tier]}`,
  ];
  if (input.manager.recentEvidence.length > 0) {
    lines.push("Your history with them — the only past you may refer to:");
    for (const evidence of input.manager.recentEvidence) lines.push(`- ${evidence}`);
  }
  if (input.cleanTeam) {
    lines.push("This manager opted their team down to clean coverage: write clean, whatever the league runs.");
  }
  lines.push(
    input.mode === "chase"
      ? isMoveChase(input)
        ? "Mode: chase — the text under \"move\" describes a move this manager just made; it is not their words. Ask exactly one question about the decision: no opinion, no numbers, nothing else."
        : "Mode: chase — exactly one question about what they just posted, nothing else."
      : "Mode: reply — answer them in voice, one to three sentences."
  );
  return lines.join("\n");
}

/** Chase mode over a move description (spec §18 sam_question) rather than the manager's own post. */
export function isMoveChase(input: WriterReplyInput): boolean {
  return input.mode === "chase" && input.chaseSubject === "move";
}

/** The input as the model sees it: the words and the card, minus ids, timestamps and plumbing. */
export function modelReplyView(input: WriterReplyInput): Record<string, unknown> {
  return {
    mode: input.mode,
    week: input.week,
    writerPost: input.writerPostText,
    card: input.card ? modelCardView(input.card) : undefined,
    thread: threadContext(input).map(turn => ({ author: turn.author, text: turn.text })),
    manager: { displayName: input.manager.displayName, teamName: input.manager.teamName },
    // A move description is not something the manager said, so it never travels under managerText.
    ...(isMoveChase(input) ? { move: input.managerText } : { managerText: input.managerText }),
  };
}

export const WireReplyToolSchema = z.object({
  text: z.string().describe(`The post, at most ${MAX_POST_CHARS} characters, in your voice. Plain prose.`),
  sentiment: z
    .enum(["jab", "thanks", "neutral"])
    .describe("How the MANAGER's text reads toward you: jab (hostile or dismissive), thanks (friendly, appreciative), neutral (everything else)."),
});

export interface PreparedWriterReplyRequest {
  params: Anthropic.MessageCreateParamsNonStreaming;
  route: WireRoute;
  persona: PersonaPrompt;
  /** The cached block. */
  systemPrompt: string;
  /** The per-manager block after the breakpoint. */
  standing: string;
}

/** Exactly what `generateWriterReply` sends, for the eval script and tests. No network. */
export function prepareWriterReplyRequest(input: WriterReplyInput, route: WireRoute = resolveWireRoute()): PreparedWriterReplyRequest {
  const persona = getPersona(replyPersona(input));
  const rating = effectiveReplyRating(input);
  const seed = replyLanguageSeed(input);
  const systemPrompt = buildWireReplySystemPrompt(persona, rating, seed);
  const standing = buildStandingBlock(persona, input);
  const params: Anthropic.MessageCreateParamsNonStreaming = {
    model: route.model,
    max_tokens: WIRE_REPLY_MAX_TOKENS,
    output_config: { effort: route.effort },
    system: [
      { type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } },
      { type: "text", text: standing },
    ],
    messages: [{ role: "user", content: JSON.stringify(modelReplyView(input), null, 2) }],
    tools: [
      {
        name: WIRE_REPLY_TOOL_NAME,
        strict: true,
        description: "Return the writer's reply for The Wire and how the manager's text read",
        input_schema: { ...zodToJsonSchema(WireReplyToolSchema, { $refStrategy: "none" }), type: "object" } as const,
      },
    ],
    tool_choice: { type: "tool", name: WIRE_REPLY_TOOL_NAME },
  };
  return { params, route, persona, systemPrompt, standing };
}

/* ------------------------------------------------------------------------------------------- *
 * Verification
 * ------------------------------------------------------------------------------------------- */

/**
 * Every reason a reply may not post. Register leaks, length, numbers not on the card or in the
 * thread, names not on the card / the manager / the thread / the desk, language over the persona's
 * allowance at the effective rating (clean allows nothing), and in chase mode exactly one question.
 */
export function verifyWriterReply(text: string, input: WriterReplyInput): string[] {
  const violations: string[] = [];
  const trimmed = text.trim();
  if (trimmed.length === 0) return ["empty"];
  if (trimmed.length > MAX_POST_CHARS) violations.push(`too_long: ${trimmed.length} > ${MAX_POST_CHARS}`);

  for (const leak of findRegisterLeaks(trimmed)) violations.push(`register_leak: "${leak.phrase}" (${leak.why})`);
  violations.push(...reporterViolations(trimmed));
  if (input.card) violations.push(...timetableViolations(trimmed, input.card));

  const context = contextTexts(input);
  const allowedNumbers = new Set<string>(input.card ? cardNumbers(input.card) : []);
  for (const source of context) for (const number of extractNumbers(source)) allowedNumbers.add(number);
  if (input.week !== undefined) allowedNumbers.add(String(input.week));
  for (const number of extractNumbers(trimmed)) {
    if (!allowedNumbers.has(number)) violations.push(`unverified_number: ${number}`);
  }

  const allowedNames = [...(input.card ? cardNames(input.card) : []), input.manager.displayName, input.manager.teamName];
  for (const source of context) allowedNames.push(...properNouns(source));
  for (const noun of unknownNames(trimmed, allowedNames)) violations.push(`unknown_name: ${noun}`);

  const rating = effectiveReplyRating(input);
  const { mild, strong, words } = countProfanity(trimmed, [input.manager.teamName]);
  if (rating === "clean") {
    if (words.length > 0) violations.push(`language_over_rating: ${words.join(", ")} at clean`);
  } else {
    if (rating === "salty" && strong > 0) {
      violations.push(`language_over_rating: ${words.filter(word => !MILD_SET.has(word)).join(", ")} at salty`);
    }
    const range = effectiveLanguageRange(getPersona(replyPersona(input)), rating, replyLanguageSeed(input));
    if (mild + strong > range.ceiling) violations.push(`language_over_allowance: ${mild + strong} > ${range.ceiling}`);
  }

  if (input.mode === "chase") {
    const questions = (trimmed.match(/\?/g) ?? []).length;
    if (questions !== 1) violations.push(`chase_questions: ${questions}`);
  }

  return violations;
}

/* ------------------------------------------------------------------------------------------- *
 * Parsing
 * ------------------------------------------------------------------------------------------- */

// Lenient shape: a missing or odd sentiment costs the classification, never the whole reply.
const LenientReply = z.object({ text: z.string().nullish(), sentiment: z.unknown() });

export interface ParsedWriterReply {
  /** Absent when the model's answer failed verification. */
  text?: string;
  sentiment: WriterReplySentiment;
  flags: string[];
}

/**
 * Turns the model's tool call into a reply. No tool call → `no_tool_call`; a text that fails
 * verification → no text, the violations as flags; a sentiment the tool did not fill in → neutral
 * plus `sentiment_missing`. `max_tokens` is recorded but is not by itself a reason to drop a text
 * that parsed and verified. Never throws.
 */
export function parseWriterReply(message: WireModelMessage, input: WriterReplyInput): ParsedWriterReply {
  const flags: string[] = [];
  if (message.stop_reason === "max_tokens") flags.push("max_tokens");

  const toolUse =
    message.content.find(block => block.type === "tool_use" && block.name === WIRE_REPLY_TOOL_NAME) ??
    message.content.find(block => block.type === "tool_use");
  if (!toolUse) return { sentiment: "neutral", flags: ["no_tool_call", ...flags] };

  const parsed = LenientReply.safeParse(toolUse.input);
  if (!parsed.success) return { sentiment: "neutral", flags: ["parse_error", ...flags] };

  let sentiment: WriterReplySentiment = "neutral";
  const rawSentiment = typeof parsed.data.sentiment === "string" ? parsed.data.sentiment.trim().toLowerCase() : "";
  if (SENTIMENTS.has(rawSentiment)) sentiment = rawSentiment as WriterReplySentiment;
  else flags.push("sentiment_missing");

  const text = parsed.data.text?.trim() ?? "";
  const violations = verifyWriterReply(text, input);
  flags.push(...violations);
  return violations.length > 0 ? { sentiment, flags } : { text, sentiment, flags };
}

/* ------------------------------------------------------------------------------------------- *
 * Generation
 * ------------------------------------------------------------------------------------------- */

/**
 * One model call for one manager's words. Throws only for transport/auth errors; a bad model output
 * comes back as flags with no text, the sentiment still trusted.
 */
export async function generateWriterReply(input: WriterReplyInput, apiKey: string): Promise<WriterReplyResult> {
  const route = resolveWireRoute();
  const { params } = prepareWriterReplyRequest(input, route);
  const anthropic = new Anthropic({ apiKey });

  let message: Anthropic.Message;
  try {
    message = await anthropic.messages.create(params);
  } catch (error) {
    if (error instanceof Anthropic.BadRequestError && /strict/i.test(error.message)) {
      console.warn("Strict tool schema rejected by the API; retrying the wire reply without strict:", error.message);
      message = await anthropic.messages.create(withoutStrictTools(params));
    } else {
      throw error;
    }
  }

  return {
    ...parseWriterReply(message, input),
    costUsd: computeCostUsd(message.model, message.usage),
    model: message.model,
    effort: route.effort,
  };
}
