// The Wire — deterministic verification (spec §8.1, §11). No model, no I/O.
//
// `verifyTake` checks a global take against its fact card: register leaks, length, every number,
// every multi-word name, reporter credits, and timetable talk without a card timetable. A failed
// take falls back to the plain card; it never holds for review.
//
// `verifyLeagueText` checks a filled league line against the league's language rating and the
// teams whose managers opted down to clean coverage.

import { findRegisterLeaks } from "../fact-verifier";
import { cleanTeamViolations, countProfanity, MILD_PROFANITY, type LanguageRating } from "../language";
import { personaPrompts } from "../persona-prompts";
import { cardNames, cardNumbers, extractNumbers, properNouns } from "./card";
import { extractTimetable } from "./timetable";
import { MAX_POST_CHARS, type WireFactCard } from "./types";

/* ------------------------------------------------------------------------------------------- *
 * Name exemptions — the same sets the article verifier uses (fact-verifier.ts keeps them
 * private, so they are copied here rather than exported from a file this module does not own).
 * ------------------------------------------------------------------------------------------- */

/** A capitalised run that starts with one of these is a sentence opener, not a name. */
const LEADING_NOISE_WORDS: ReadonlySet<string> = new Set([
  "the", "because", "here", "and", "but", "so", "now", "once", "when", "after", "before", "if", "then",
  "with", "without", "unless", "until", "while", "every", "no", "not", "take", "write", "put", "watch",
]);

const COMMON_WORDS: ReadonlySet<string> = new Set([
  "the", "and", "but", "for", "week", "sunday", "monday", "tuesday", "wednesday", "thursday",
  "friday", "saturday", "january", "february", "march", "april", "may", "june", "july", "august",
  "september", "october", "november", "december", "fantasy", "football", "league", "playoff",
  "playoffs", "championship", "bench", "starter", "waiver", "faab", "adp", "ppr", "nfl", "espn",
  "ffsn", "round", "pick", "draft", "points", "manager", "commissioner", "good", "evening",
  // Wire furniture: tag words, the desk, and the feed itself.
  "reported", "stated", "opinion", "live", "final", "update", "stand", "by", "back", "to", "you",
  "sleeper", "wire", "injured", "reserve", "questionable", "doubtful", "out", "active", "class",
]);

const NFL_TEAMS: ReadonlySet<string> = new Set([
  "arizona", "atlanta", "baltimore", "buffalo", "carolina", "chicago", "cincinnati", "cleveland",
  "dallas", "denver", "detroit", "green bay", "houston", "indianapolis", "jacksonville",
  "kansas city", "las vegas", "los angeles", "miami", "minnesota", "new england", "new orleans",
  "new york", "philadelphia", "pittsburgh", "san francisco", "seattle", "tampa bay", "tennessee",
  "washington", "cardinals", "falcons", "ravens", "bills", "panthers", "bears", "bengals",
  "browns", "cowboys", "broncos", "lions", "packers", "texans", "colts", "jaguars", "chiefs",
  "raiders", "rams", "chargers", "dolphins", "vikings", "patriots", "saints", "giants", "jets",
  "eagles", "steelers", "49ers", "niners", "seahawks", "buccaneers", "titans", "commanders",
]);

/** The desk's own names — a toss ("Nina Sharpe has the numbers") is not an invented person. */
const DESK_NAMES: ReadonlyArray<string> = Object.values(personaPrompts).map(persona =>
  persona.name.replace(/"[^"]*"\s*/g, "").toLowerCase()
);

/* ------------------------------------------------------------------------------------------- *
 * Patterns
 * ------------------------------------------------------------------------------------------- */

/** "Schefter of ESPN reports", "Ian Rapoport of NFL Network reported", "per Adam Schefter", "according to …". */
const REPORTER_PATTERNS: ReadonlyArray<RegExp> = [
  // "Schefter of ESPN reports", "Alexander of the Houston Chronicle reported"
  /\b\w+ of (?:the )?[A-Z][\w .'’-]*? report(?:s|ed)\b/,
  // "the Houston Chronicle reports", "NFL Network reported" — an outlet that is not the card's source
  /\b(?!ESPN\b|Sleeper\b)[A-Z][\w.'’-]+(?:\s+(?!ESPN\b|Sleeper\b)[A-Z][\w.'’-]+)*\s+report(?:s|ed)\b/,
  /\b(?:[Pp]er|[Aa]ccording to|[Vv]ia)\s+(?:the\s+)?(?!ESPN\b|Sleeper\b)[A-Z][\w.'’-]*(?:\s+[A-Z][\w.'’-]*)+/,
  /\b(?:ESPN|Sleeper)['’]s\s+[A-Z][a-z]+\s+[A-Z][a-z]+/,
  /\b(?:league sources|sources say|sources tell|sources close to|word is|i'm hearing|hearing is)\b/i,
];

/** Timetable talk that must not appear unless the card carries a timetable. */
const TIMETABLE_WORDS =
  /\b(?:weeks|season[- ]ending|out for the (?:year|season)|week[- ]to[- ]week|day[- ]to[- ]day|multiple weeks|indefinitely|(?:rest|remainder) of the season)\b/i;

function normaliseTimetable(value: string): string {
  return value.toLowerCase().replace(/\s*[-–]\s*|\s+to\s+/g, "-").replace(/\s+/g, " ").trim();
}

/* ------------------------------------------------------------------------------------------- *
 * verifyTake
 * ------------------------------------------------------------------------------------------- */

export interface VerifyResult {
  ok: boolean;
  violations: string[];
}

function nameIsKnown(noun: string, allowed: ReadonlyArray<string>): boolean {
  const lower = noun.toLowerCase();
  const words = lower.split(/\s+/);
  if (LEADING_NOISE_WORDS.has(words[0])) return true;
  if (words.every(word => COMMON_WORDS.has(word))) return true;
  if (NFL_TEAMS.has(lower) || words.every(word => NFL_TEAMS.has(word) || COMMON_WORDS.has(word))) return true;
  if (DESK_NAMES.some(name => name.includes(lower) || lower.includes(name))) return true;
  return allowed.some(known => {
    const knownLower = known.toLowerCase();
    return knownLower === lower || knownLower.includes(lower) || lower.includes(knownLower);
  });
}

/**
 * The multi-word proper nouns in `text` that are neither wire furniture, an NFL team, the desk's
 * own names, nor (a part of) anything in `allowed`. Shared by the take verifier (allowed = the
 * card) and the writer-reply verifier (allowed = the card, the manager, the thread).
 */
export function unknownNames(text: string, allowed: ReadonlyArray<string>): string[] {
  return properNouns(text).filter(noun => !nameIsKnown(noun, allowed));
}

/** A global take against its card. Any violation means the take is dropped for the plain card. */
export function verifyTake(text: string, card: WireFactCard): VerifyResult {
  const violations: string[] = [];
  const trimmed = text.trim();

  if (trimmed.length === 0) violations.push("empty");
  if (trimmed.length > MAX_POST_CHARS) violations.push(`too_long: ${trimmed.length} > ${MAX_POST_CHARS}`);

  for (const leak of findRegisterLeaks(trimmed)) violations.push(`register_leak: "${leak.phrase}" (${leak.why})`);

  const allowedNumbers = new Set(cardNumbers(card));
  for (const number of extractNumbers(trimmed)) {
    if (!allowedNumbers.has(number)) violations.push(`unverified_number: ${number}`);
  }

  for (const noun of unknownNames(trimmed, cardNames(card))) violations.push(`unknown_name: ${noun}`);

  violations.push(...reporterViolations(trimmed), ...timetableViolations(trimmed, card));

  return { ok: violations.length === 0, violations };
}

/** A reporter, outlet or unnamed-source credit in `text` — at most one violation, the first match. */
export function reporterViolations(text: string): string[] {
  for (const pattern of REPORTER_PATTERNS) {
    const match = text.match(pattern);
    if (match) return [`reporter_attribution: "${match[0]}"`];
  }
  return [];
}

/** Timetable talk the card does not carry, or a timetable that is not the card's, in `text`. */
export function timetableViolations(text: string, card: WireFactCard): string[] {
  if (!card.timetable) {
    const match = text.match(TIMETABLE_WORDS);
    return match ? [`timetable_without_card: "${match[0]}"`] : [];
  }
  const found = extractTimetable(text);
  if (found && normaliseTimetable(found) !== normaliseTimetable(card.timetable)) {
    return [`timetable_mismatch: "${found}" is not "${card.timetable}"`];
  }
  return [];
}

/* ------------------------------------------------------------------------------------------- *
 * verifyLeagueText
 * ------------------------------------------------------------------------------------------- */

/**
 * A filled league line against the league's rating and its opted-down teams. Persona-agnostic:
 * clean allows no tracked word at all, salty allows the mild tier only, unfiltered allows both.
 * The persona's own ceiling is enforced where the line is chosen (stock-lines.ts).
 */
export function verifyLeagueText(text: string, rating: LanguageRating, cleanTeamNames: string[]): VerifyResult {
  const violations: string[] = [];
  const trimmed = text.trim();

  if (trimmed.length === 0) violations.push("empty");
  if (trimmed.length > MAX_POST_CHARS) violations.push(`too_long: ${trimmed.length} > ${MAX_POST_CHARS}`);

  const { mild, strong, words } = countProfanity(trimmed, cleanTeamNames);
  if (rating === "clean" && mild + strong > 0) violations.push(`language_over_rating: ${words.join(", ")} at clean`);
  if (rating === "salty" && strong > 0) {
    violations.push(`language_over_rating: ${words.filter(word => !isMild(word)).join(", ")} at salty`);
  }

  for (const violation of cleanTeamViolations(
    trimmed,
    cleanTeamNames.map(name => ({ name })),
    cleanTeamNames
  )) {
    violations.push(`clean_team_language: ${violation.team}`);
  }

  return { ok: violations.length === 0, violations };
}

const MILD_SET: ReadonlySet<string> = new Set(MILD_PROFANITY);
function isMild(word: string): boolean {
  return MILD_SET.has(word);
}
