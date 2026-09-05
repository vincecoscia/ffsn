// The Wire — manager text moderation (spec §17.2). Pure: language.ts and the shared contract only.
// The Convex default runtime imports this before every manager post/reply insert, so nothing here
// may touch Node built-ins or the Anthropic SDK.
//
// Two checks and nothing else: length, and the league's language rating. Clean allows no tracked
// word; salty allows the mild tier only; unfiltered allows anything tracked. Slurs are not in any
// list (see language.ts) and are not this module's job. The violation names the word as the author
// typed it — the UI shows it to the author only, never to the league.

import { countProfanity, MILD_PROFANITY, type LanguageRating } from "../language";
import { MANAGER_POST_MAX_CHARS, type ModerationResult } from "./types";

const MILD_SET: ReadonlySet<string> = new Set(MILD_PROFANITY);

/** C0/C1 control characters except tab and newline; tabs become spaces below. */
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

/**
 * The text as it is stored: trimmed, every run of horizontal whitespace one space, every run of
 * blank lines one newline, control characters gone. Content is otherwise unchanged.
 */
export function normalizeManagerText(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
    .replace(CONTROL_CHARS, "")
    .replace(/[^\S\n]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The first occurrence of a tracked word in `text`, spelled the way the author typed it. */
function asTyped(text: string, word: string): string {
  const match = new RegExp(`\\b${escapeRegExp(word)}\\b`, "i").exec(text);
  return match ? match[0] : word;
}

function quoteList(words: string[]): string {
  return words.map(word => `'${word}'`).join(", ");
}

const RATING_LABEL: Record<LanguageRating, string> = { clean: "Clean", salty: "Salty", unfiltered: "Unfiltered" };

/**
 * What a manager may post at this league's rating. `text` is the normalized text to store when
 * `ok`; `violations` are human-readable reasons for the author when it is not.
 */
export function moderateManagerText(text: string, rating: LanguageRating): ModerationResult {
  const normalized = normalizeManagerText(text);
  const violations: string[] = [];

  if (normalized.length === 0) violations.push("Nothing to post");
  if (normalized.length > MANAGER_POST_MAX_CHARS) {
    violations.push(`Too long (${normalized.length}/${MANAGER_POST_MAX_CHARS})`);
  }

  const { words } = countProfanity(normalized);
  const distinct = [...new Set(words)];
  const mild = distinct.filter(word => MILD_SET.has(word)).map(word => asTyped(normalized, word));
  const strong = distinct.filter(word => !MILD_SET.has(word)).map(word => asTyped(normalized, word));

  if (rating === "clean" && distinct.length > 0) {
    violations.push(`This league is rated ${RATING_LABEL.clean}: drop ${quoteList([...mild, ...strong])}`);
  } else if (rating === "salty" && strong.length > 0) {
    violations.push(`${RATING_LABEL.salty} allows the mild stuff, not ${quoteList(strong)}`);
  }

  return { ok: violations.length === 0, text: normalized, violations };
}
