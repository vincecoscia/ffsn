// Language rating (owner ask, Sept 2026): a league-level dial — clean | salty | unfiltered — plus a
// per-manager opt-down, so FFSN's desk can swear on air without a manager who asked for clean
// coverage ever reading (or hearing) profanity about their own team. Pure TypeScript: no Anthropic
// SDK import, no Convex import — `prompt-builder.ts` and `disputed/*` both read this module, and a
// second build will wire the Convex plumbing that supplies these values on top of it.
//
// Slurs are deliberately absent from every list below. The prompt forbids them at every rating
// (see `buildHouseStyleBlock` in prompt-builder.ts); this module's job is profanity tiers and
// mention counting, never a slur inventory.

export type LanguageRating = "clean" | "salty" | "unfiltered";

export const DEFAULT_LANGUAGE_RATING: LanguageRating = "clean";

/**
 * The mild tier: allowed at `salty` and above. Owner ask (2026-09-03): nothing short of a slur is
 * off the table, so both tiers are wide — the persona's own LANGUAGE trait (persona-prompts.ts)
 * decides how much of this any one writer actually uses, and the house-style block renders these
 * exact lists so the prompt and the counter always agree on what is in a tier.
 */
export const MILD_PROFANITY: ReadonlyArray<string> = [
  "damn",
  "hell",
  "ass",
  "crap",
  "piss",
  "pissed",
  "bastard",
  "screwed",
  "sucks",
  "jackass",
  "dumbass",
  "badass",
  "half-assed",
];

/** The strong tier: allowed only at `unfiltered`. */
export const STRONG_PROFANITY: ReadonlyArray<string> = [
  "fuck",
  "fucking",
  "fucked",
  "fucker",
  "motherfucker",
  "motherfucking",
  "shit",
  "shitty",
  "shits",
  "shitshow",
  "shithead",
  "dipshit",
  "bullshit",
  "horseshit",
  "asshole",
  "assholes",
  "goddamn",
  "dick",
  "dickhead",
  "prick",
  "pussy",
  "bitch",
  "bitches",
];

/**
 * The profanity allowance a persona carries at each rating above clean: the most tracked words one
 * piece (an article, or a whole episode of the show) may contain from that writer. The producer
 * enforces it per episode; the article eval reports against it. `0` means the writer never swears
 * at that rating.
 */
export interface LanguageAllowance {
  salty: number;
  unfiltered: number;
}

/** A writer's range at one rating: `floor` is character (fewer is out of it), `ceiling` is a count. */
export interface LanguageRange {
  floor: number;
  ceiling: number;
}

/** Every tracked profanity word, lower-case, mild tier first. */
export const PROFANITY_WORDS: ReadonlyArray<string> = [...MILD_PROFANITY, ...STRONG_PROFANITY];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whole-word, case-insensitive occurrences of `word` in `text`. */
function wholeWordCount(text: string, word: string): number {
  const pattern = new RegExp(`\\b${escapeRegExp(word)}\\b`, "gi");
  return text.match(pattern)?.length ?? 0;
}

/**
 * Whole-word, case-insensitive profanity counts. Only the exact forms listed in
 * {@link MILD_PROFANITY} / {@link STRONG_PROFANITY} are matched — "fucking" and "fucked" are their
 * own listed forms rather than a stem the function derives, so there is no suffix-stripping logic
 * to get wrong. `words` carries one entry per occurrence found (so `words.length === mild + strong`).
 */
/**
 * Phrases that are facts, not the writer's words (team names above all: a league can name a team
 * anything), removed before counting so "GLORY ASSHOLE" is not two strong hits per mention.
 * Whole-phrase, word-bounded (same convention `mentionRatio`'s `countAlternatives` already uses for
 * team names below) — an exempt phrase never eats into a larger word it merely happens to sit inside
 * (a team called "Ace" must not corrupt "Space").
 */
export function stripExemptPhrases(text: string, exemptPhrases: ReadonlyArray<string>): string {
  let stripped = text;
  for (const phrase of exemptPhrases) {
    const trimmed = phrase.trim();
    if (trimmed.length === 0) continue;
    stripped = stripped.replace(new RegExp(`\\b${escapeRegExp(trimmed)}\\b`, "gi"), " ");
  }
  return stripped;
}

export function countProfanity(
  rawText: string,
  exemptPhrases: ReadonlyArray<string> = []
): { mild: number; strong: number; words: string[] } {
  const text = stripExemptPhrases(rawText, exemptPhrases);
  let mild = 0;
  let strong = 0;
  const words: string[] = [];

  for (const word of MILD_PROFANITY) {
    const count = wholeWordCount(text, word);
    if (count === 0) continue;
    mild += count;
    for (let i = 0; i < count; i++) words.push(word);
  }
  for (const word of STRONG_PROFANITY) {
    const count = wholeWordCount(text, word);
    if (count === 0) continue;
    strong += count;
    for (let i = 0; i < count; i++) words.push(word);
  }

  return { mild, strong, words };
}

/** A name split into whitespace-separated words. */
function nameWords(name: string): string[] {
  return name.trim().split(/\s+/).filter(Boolean);
}

/**
 * Case-insensitive, whole-phrase count of every `phrase` in `patterns` against `text`, treating the
 * patterns as alternatives of a single regex (longest first) so a longer phrase's match "consumes"
 * the characters a shorter alternative sitting inside it would otherwise also match — the mechanism
 * that keeps a team's short form, or a manager's first/last name, from double-counting an occurrence
 * of the full phrase it is part of.
 */
function countAlternatives(text: string, patterns: ReadonlyArray<string>): number {
  const unique = [...new Set(patterns.filter((pattern) => pattern.length > 0))];
  if (unique.length === 0) return 0;
  const alternation = unique
    .slice()
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join("|");
  const pattern = new RegExp(`\\b(?:${alternation})\\b`, "gi");
  return text.match(pattern)?.length ?? 0;
}

/**
 * How often a piece of prose names the TEAM versus the MANAGER (house-style eval number, owner ask
 * Sept 2026: the desk should be writing the team as the subject, the manager only as its GM).
 *
 * - `teamMentions`: every team's name, whole phrase, case-insensitive. A 3+ word team name also
 *   counts its last two words as a short form (e.g. "Sable Ridge Sentinels" also counts "Ridge
 *   Sentinels") — counted once per occurrence, never twice for the same words.
 * - `managerMentions`: every manager's full name, plus their first name alone and last name alone,
 *   whole word, case-insensitive — except a first or last name that is also a word inside ANY team
 *   name in `teams` is never counted alone (only the manager's full name still counts there), since
 *   a lone occurrence of that word is ambiguous with the team name.
 * - `ratio`: `teamMentions / managerMentions`, or `null` when no manager was mentioned at all.
 */
export function mentionRatio(
  text: string,
  teams: Array<{ name: string; manager?: string }>
): { teamMentions: number; managerMentions: number; ratio: number | null } {
  const teamNameWords = new Set<string>();
  for (const team of teams) {
    for (const word of nameWords(team.name)) teamNameWords.add(word.toLowerCase());
  }

  let teamMentions = 0;
  let managerMentions = 0;

  for (const team of teams) {
    const words = nameWords(team.name);
    const patterns = [team.name];
    if (words.length >= 3) patterns.push(words.slice(-2).join(" "));
    teamMentions += countAlternatives(text, patterns);

    if (!team.manager) continue;
    const managerWords = nameWords(team.manager);
    if (managerWords.length === 0) continue;
    const first = managerWords[0];
    const last = managerWords[managerWords.length - 1];
    const variants = new Set<string>([team.manager]);
    if (!teamNameWords.has(first.toLowerCase())) variants.add(first);
    if (!teamNameWords.has(last.toLowerCase())) variants.add(last);
    managerMentions += countAlternatives(text, [...variants]);
  }

  return { teamMentions, managerMentions, ratio: managerMentions === 0 ? null : teamMentions / managerMentions };
}
