// The only file in `disputed/` that imports the Anthropic SDK. Every other module in this package
// (types, question, prompts, producer) stays pure TypeScript so the show can be produced, tested and
// eval'd offline; this file is the thin adapter that turns a `TurnCallRequest` into a real API call.
//
// Mirrors `runEditorPass` (content-generation-service.ts ~756) and `withRetriesAndFallback`
// (conversation-service.ts ~699): non-streaming `messages.create`, one forced tool with a
// Zod-derived `input_schema`, `output_config.effort`, no temperature/top_p, retry-without-strict on
// the SDK's strict-schema 400, and a model fallback with jittered backoff on 5xx/overloaded.

import Anthropic from "@anthropic-ai/sdk";
import { zodToJsonSchema } from "zod-to-json-schema";
import { TurnOutputSchema } from "./types";
import type { TurnCallRequest, TurnCallResult, TurnCaller } from "./producer";

const TOOL_NAME = "speak_turn";

/** Wraps one string as a text block with its own ephemeral cache breakpoint. */
function cachedBlock(text: string): Anthropic.TextBlockParam {
  return { type: "text", text, cache_control: { type: "ephemeral" } };
}

/** Opus 5 occasionally wraps a forced tool call's arguments in a single container key. */
const WRAPPER_KEYS = new Set(["parameters", "input", "arguments", TOOL_NAME]);
function unwrapToolInput(input: unknown): unknown {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const keys = Object.keys(input as Record<string, unknown>);
    if (keys.length === 1 && WRAPPER_KEYS.has(keys[0])) {
      const inner = (input as Record<string, unknown>)[keys[0]];
      if (inner && typeof inner === "object") return inner;
    }
  }
  return input;
}

/** Same request with `strict` removed from every tool definition. */
function withoutStrictTools(
  params: Anthropic.MessageCreateParamsNonStreaming
): Anthropic.MessageCreateParamsNonStreaming {
  if (!params.tools) return params;
  return {
    ...params,
    tools: params.tools.map((tool) => ("strict" in tool ? ({ ...tool, strict: undefined } as typeof tool) : tool)),
  };
}

/** Opus routes fall back to Sonnet; Sonnet routes fall back to Opus. */
function fallbackModelFor(model: string): string {
  return model === "claude-sonnet-5" ? "claude-opus-5" : "claude-sonnet-5";
}

/** Errors worth retrying / falling back on: model not found, server errors, overloaded. */
function shouldFallback(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("status" in error)) return false;
  const status = (error as { status?: unknown }).status;
  return status === 404 || status === 500 || status === 503 || status === 529;
}

function buildParams(req: TurnCallRequest, model: string): Anthropic.MessageCreateParamsNonStreaming {
  return {
    model,
    max_tokens: req.maxTokens,
    output_config: { effort: req.effort },
    // FACTS (`systemPrefix`) is the FIRST system block, byte-identical for every turn of the episode
    // and every speaker on this model, with its own ephemeral breakpoint; the per-speaker prompt
    // (`system`) is the second block, also cached (small — contract, voice, relationships, show
    // rules, role). Ordering it this way lets every speaker share one FACTS cache entry per model
    // (pilot follow-up, 2026-09-03: keyed after the per-speaker prompt instead, FACTS was a separate
    // ~30k-token write per speaker — seven writes an episode instead of two, one per model). Two
    // breakpoints total, under the API's limit of four. The user turn (transcript so far, tonight's
    // instruction, the output contract) changes every call and carries nothing worth caching.
    system: [cachedBlock(req.systemPrefix), cachedBlock(req.system)],
    messages: [{ role: "user" as const, content: req.user }],
    tools: [
      {
        name: TOOL_NAME,
        strict: true,
        description: "Speak this one turn of the Disputed transcript.",
        input_schema: { ...zodToJsonSchema(TurnOutputSchema, { $refStrategy: "none" }), type: "object" } as const,
      },
    ],
    tool_choice: { type: "tool" as const, name: TOOL_NAME },
  };
}

/** One call attempt: send the request, retry once without `strict` on that specific 400. */
async function createMessage(anthropic: Anthropic, req: TurnCallRequest, model: string): Promise<Anthropic.Message> {
  const params = buildParams(req, model);
  try {
    return await anthropic.messages.create(params);
  } catch (error) {
    if (error instanceof Anthropic.BadRequestError && /strict/i.test(error.message)) {
      return await anthropic.messages.create(withoutStrictTools(params));
    }
    throw error;
  }
}

function parseTurn(message: Anthropic.Message): TurnCallResult["output"] {
  const toolUse = message.content.find((block): block is Anthropic.ToolUseBlock => block.type === "tool_use");
  if (!toolUse) {
    throw new Error(`No ${TOOL_NAME} tool call in the response (stop_reason ${message.stop_reason})`);
  }
  const parsed = TurnOutputSchema.safeParse(unwrapToolInput(toolUse.input));
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 3).map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
    throw new Error(`Unusable ${TOOL_NAME} output: ${issues.join("; ")}`);
  }
  return parsed.data;
}

/**
 * `createAnthropicTurnCaller(apiKey)` returns a `TurnCaller`: one `new Anthropic({ apiKey })`, reused
 * across every turn of the episode. Walks `[req.model, its fallback]`, retrying overloaded/5xx on
 * each with jittered backoff before moving to the next.
 */
export function createAnthropicTurnCaller(apiKey: string): TurnCaller {
  const anthropic = new Anthropic({ apiKey });

  return async function callTurn(req: TurnCallRequest): Promise<TurnCallResult> {
    const models = [req.model, fallbackModelFor(req.model)];
    const maxRetries = 3;
    const baseDelay = 1000;
    let lastError: Error | null = null;

    for (const model of models) {
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          const message = await createMessage(anthropic, req, model);
          const output = parseTurn(message);
          const usage = message.usage;
          return {
            output,
            usage: {
              input: usage?.input_tokens ?? 0,
              output: usage?.output_tokens ?? 0,
              cacheRead: usage?.cache_read_input_tokens ?? undefined,
              cacheWrite: usage?.cache_creation_input_tokens ?? undefined,
            },
            model: message.model || model,
          };
        } catch (error) {
          lastError = error as Error;
          if (shouldFallback(error) && attempt < maxRetries) {
            const delay = baseDelay * Math.pow(2, attempt) + Math.random() * 1000;
            console.warn(
              `[disputed] ${model} overloaded for ${req.speaker}'s turn (attempt ${attempt + 1}/${maxRetries + 1}); retrying in ${Math.round(delay)}ms`
            );
            await new Promise((resolve) => setTimeout(resolve, delay));
            continue;
          }
          break;
        }
      }
    }

    throw new Error(`Disputed turn call failed for ${req.speaker}: ${lastError?.message ?? "unknown error"}`);
  };
}
