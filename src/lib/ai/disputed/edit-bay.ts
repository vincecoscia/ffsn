// The "Disputed" edit bay — pass two. Pass one (`producer.ts`) is the source of truth for every
// fact, claim and mention, verified per turn; its transcripts read stiff because each turn is
// written in isolation and run long. This module takes a finished pass-one transcript and, per
// segment, asks a model for a LIVE-RADIO EDIT: cut for time, sound like real people talking over
// each other, under a deterministic guard that makes it impossible for the edit to add a fact.
//
// No Anthropic SDK import here — `call` is injected by the caller (`anthropic-caller.ts` in this
// package, or a fake in tests), so this module stays pure TypeScript and testable offline.

import { computeCostUsd } from "../content-generation-service";
import type { FactsBlock } from "../facts";
import { verifyArticle } from "../fact-verifier";
import { DEFAULT_LANGUAGE_RATING, PROFANITY_WORDS, STRONG_PROFANITY, mentionRatio } from "../language";
import type { LanguageRating } from "../language";
import { getPersonaDisplay, personaPrompts } from "../persona-prompts";
import { buildEditSystemPrompt, buildEditUserPrompt } from "./prompts";
import { CATCHPHRASE_PATTERN, DESK_NAME_WORDS, relevantViolations, wrapAsArticle } from "./producer";
import type {
  EditedSegment,
  EditedTurn,
  ShowSegment,
  ShowTranscript,
  ShowTurn,
  TurnOutput,
} from "./types";

export interface EditCallRequest {
  segmentId: string;
  model: "claude-sonnet-5" | "claude-opus-5";
  effort: "low" | "medium";
  /** Stable across every segment of the episode — send it as one cached system block. */
  system: string;
  /** Changes every call — never cached. */
  user: string;
  maxTokens: number;
}

export interface EditCallResult {
  output: EditedSegment;
  usage: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
  model: string;
}

export interface EditCaller {
  (req: EditCallRequest): Promise<EditCallResult>;
}

export interface NaturalizeOptions {
  call: EditCaller;
  /** Cut each segment to about this fraction of its original word count. Default 0.7. */
  targetRatio?: number;
  /** When given, guard step (e) runs `verifyArticle` on each edited segment's rewritten text. */
  facts?: FactsBlock;
  model?: EditCallRequest["model"];
  effort?: EditCallRequest["effort"];
  /**
   * Guard step (f): at "clean" (the default when this is absent AND `transcript.language` is
   * absent), an edit may not introduce a profanity word the original segment did not already have.
   * When omitted, falls back to `transcript.language`, then to "clean".
   */
  languageRating?: LanguageRating;
}

export interface NaturalizeStats {
  segmentsEdited: number;
  segmentsRejected: number;
  /** Segments whose first edit failed the guard and got one retry with the reason fed back. */
  segmentsRetried: number;
  wordsBefore: number;
  wordsAfter: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  modelsUsed: string[];
  rejections: Array<{ segment: string; reason: string }>;
}

export interface NaturalizeResult {
  transcript: ShowTranscript;
  stats: NaturalizeStats;
}

/** Cut each segment to this fraction of its pass-one words (0.7 on the first live run read as a trim, not a cut). */
const DEFAULT_TARGET_RATIO = 0.6;
const DEFAULT_MODEL: EditCallRequest["model"] = "claude-sonnet-5";
const DEFAULT_EFFORT: EditCallRequest["effort"] = "medium";
const EDIT_MAX_TOKENS = 4000;

function wordCount(text: string): number {
  const trimmed = text.trim();
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
}

function normalizeWhitespace(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

function segmentText(turns: Array<{ text: string }>): string {
  return turns.map((turn) => turn.text).join(" ");
}

/**
 * Every turn a segment's edit may not touch: `grade`/`ledger`/`close` turns (Nina's verdict, the
 * season ledger, Curtis's sign-off), and any turn — of any kind — that carries Reggie's catchphrase,
 * which pass one already restricted to his last jab.
 */
function lockedIndexesFor(segment: ShowSegment): number[] {
  const indexes: number[] = [];
  segment.turns.forEach((turn, index) => {
    if (turn.kind === "grade" || turn.kind === "ledger" || turn.kind === "close" || CATCHPHRASE_PATTERN.test(turn.text)) {
      indexes.push(index);
    }
  });
  return indexes;
}

/**
 * One word, lower-cased, with trailing punctuation and a possessive stripped, so "November.",
 * "AIR." and "Coscia's" compare as "november", "air" and "coscia" on both sides of the guard.
 * (First live edit run, 2026-09-03: the word set kept the sentence-final period and the name
 * extractor did not, so every name that closed a sentence in the original read as new.)
 */
function normalizeWord(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/['’]s$/, "")
    .replace(/[.'’-]+$/, "")
    .replace(/^[.'’-]+/, "");
}

/** Every "word" (letters, apostrophes, hyphens, periods) in a piece of text, normalized. */
function allWordsLower(text: string): Set<string> {
  const matches = text.match(/[A-Za-z][A-Za-z'’.-]*/g) ?? [];
  return new Set(matches.map(normalizeWord).filter((word) => word.length > 0));
}

/** Every numeric token a turn's text asserts, e.g. "116.9", "4-3", "$76", "1,094.2", "20%". */
const NUMBER_TOKEN_PATTERN = /\$?\d[\d,]*(?:\.\d+)?(?:-\d+(?:-\d+)?)?%?/g;

function normalizeNumberToken(raw: string): string {
  return raw.replace(/,/g, "").replace(/[.,;:!?]+$/, "");
}

/**
 * Capitalized words that are never a fabricated name: first-person forms, and spelled-out
 * numbers (the editor writes "FIVE" for emphasis; the digit guard above is what polices
 * quantities, and a spelled-out number cannot hide a new score from it).
 */
const NAME_STOPLIST = new Set([
  "i", "i'm", "i'll", "i'd", "i've",
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen",
  "nineteen", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety",
  "hundred", "thousand", "first", "second", "third", "fourth", "fifth", "sixth", "seventh",
  "eighth", "ninth", "tenth", "half", "quarter",
]);

/**
 * Lower-cases the first word after every sentence boundary — the start of the text, a `.!?` +
 * whitespace, an em dash, or a quotation mark — so a legitimately capitalized sentence (or
 * clause) opener never reads as an invented name.
 */
function lowercaseSentenceStarts(text: string): string {
  return text.replace(
    /(^|[.!?]\s+|—\s*|["“”'’]\s*)([A-Za-z][A-Za-z'’.-]*)/g,
    (_match, boundary: string, word: string) => `${boundary}${word.toLowerCase()}`
  );
}

/**
 * Every number and every (non-sentence-initial) capitalized name a piece of text asserts, for the
 * no-new-facts guard (step d). Names are lower-cased and stripped of the small first-person
 * stoplist; numbers are normalized by stripping commas.
 */
export function extractFactTokens(text: string): { numbers: Set<string>; names: Set<string> } {
  const numbers = new Set<string>();
  for (const match of text.matchAll(NUMBER_TOKEN_PATTERN)) {
    const normalized = normalizeNumberToken(match[0]);
    if (normalized.length > 0) numbers.add(normalized);
  }

  const names = new Set<string>();
  const adjusted = lowercaseSentenceStarts(text);
  for (const match of adjusted.matchAll(/\b[A-Z][a-zA-Z'’.-]+\b/g)) {
    const lower = normalizeWord(match[0]);
    if (lower.length > 0 && !NAME_STOPLIST.has(lower)) names.add(lower);
  }

  return { numbers, names };
}

export type GuardResult = { ok: true } | { ok: false; reason: string };

/**
 * The edit-bay guard: deterministic, all steps must pass, in order. On the first failure this
 * returns immediately with a reason naming the offending turn or token; `naturalizeTranscript` keeps
 * the original segment whenever this returns `{ ok: false }`.
 */
/**
 * The editor is told to return slugs, but the first live run (2026-09-03) returned the display
 * label it saw in the turn listing ("Mel Diaper (The Draft Disaster)"). A slug passes through;
 * a label that contains a desk member's display name resolves to that member's slug; anything
 * else is returned as-is and fails the speaker check.
 */
function resolveSpeakerSlug(raw: string): string {
  const trimmed = raw.trim();
  if (personaPrompts[trimmed]) return trimmed;
  const lower = trimmed.toLowerCase();
  for (const persona of Object.values(personaPrompts)) {
    const fullName = persona.name.replace(/["“”]/g, "").toLowerCase();
    const displayName = getPersonaDisplay(persona.slug).name.replace(/["“”]/g, "").toLowerCase();
    if (lower.includes(persona.slug) || lower.includes(fullName) || lower.includes(displayName)) {
      return persona.slug;
    }
  }
  return trimmed;
}

/** Whole-word, case-insensitive: does `word` appear in `text` at all? */
function wholeWordPresent(text: string, word: string): boolean {
  const pattern = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
  return pattern.test(text);
}

export function checkEditedSegment(
  original: ShowSegment,
  edited: EditedSegment,
  opts: { facts?: FactsBlock; languageRating?: LanguageRating } = {}
): GuardResult {
  const turns = original.turns;

  // a. Every sourceTurn is a valid index into `turns`, and its speaker matches. Turns may be reused
  //    (a split for an interruption) or dropped, but the first and last original turns must survive.
  const usedIndexes = new Set<number>();
  for (let i = 0; i < edited.turns.length; i++) {
    const editedTurn = edited.turns[i];
    if (!Number.isInteger(editedTurn.sourceTurn) || editedTurn.sourceTurn < 0 || editedTurn.sourceTurn >= turns.length) {
      return {
        ok: false,
        reason: `edited turn ${i}: sourceTurn ${editedTurn.sourceTurn} is not a valid index into this ${turns.length}-turn segment`,
      };
    }
    const source = turns[editedTurn.sourceTurn];
    if (resolveSpeakerSlug(editedTurn.speaker) !== source.speaker) {
      return {
        ok: false,
        reason: `edited turn ${i}: speaker "${editedTurn.speaker}" does not match sourceTurn ${editedTurn.sourceTurn}'s speaker "${source.speaker}"`,
      };
    }
    usedIndexes.add(editedTurn.sourceTurn);
  }
  if (turns.length > 0 && !usedIndexes.has(0)) {
    return { ok: false, reason: `the segment's first turn (index 0, ${turns[0].speaker}) is not represented in the edit` };
  }
  if (turns.length > 0 && !usedIndexes.has(turns.length - 1)) {
    return {
      ok: false,
      reason: `the segment's last turn (index ${turns.length - 1}, ${turns[turns.length - 1].speaker}) is not represented in the edit`,
    };
  }

  // b. Locked turns (grade/ledger/close, or the catchphrase) come back verbatim, whitespace-
  //    normalized, exactly once — never split, merged, dropped, or reworded.
  for (const index of lockedIndexesFor(original)) {
    const source = turns[index];
    const matches = edited.turns.filter((turn) => turn.sourceTurn === index);
    if (matches.length !== 1 || normalizeWhitespace(matches[0].text) !== normalizeWhitespace(source.text)) {
      return {
        ok: false,
        reason: `locked turn ${index} (${source.speaker}, kind "${source.kind}") must come back verbatim and exactly once; the edit changed, split, merged or dropped it`,
      };
    }
  }

  // c. No growth.
  const originalWords = turns.reduce((sum, turn) => sum + wordCount(turn.text), 0);
  const editedWords = edited.turns.reduce((sum, turn) => sum + wordCount(turn.text), 0);
  if (editedWords > originalWords) {
    return { ok: false, reason: `edited segment grew: ${editedWords} words vs ${originalWords} in the original` };
  }

  // d. No new facts: every number and every name the edit asserts must already be in the original.
  const originalText = segmentText(turns);
  const editedText = segmentText(edited.turns);
  const originalTokens = extractFactTokens(originalText);
  const editedTokens = extractFactTokens(editedText);

  for (const number of editedTokens.numbers) {
    if (!originalTokens.numbers.has(number)) {
      return { ok: false, reason: `edited segment introduces a number not in the original: "${number}"` };
    }
  }

  const originalWordSet = allWordsLower(originalText);
  for (const name of editedTokens.names) {
    if (originalWordSet.has(name) || DESK_NAME_WORDS.has(name)) continue;
    return { ok: false, reason: `edited segment introduces a name not in the original: "${name}"` };
  }

  // e. Optional verifier pass, only when the caller gave us FACTS to check against.
  if (opts.facts) {
    const sanitized: TurnOutput = { text: editedText, jab: false, factsCited: [] };
    const violations = relevantViolations(verifyArticle(wrapAsArticle(original.id, sanitized), opts.facts));
    const blocks = violations.filter((violation) => violation.severity === "block");
    if (blocks.length > 0) {
      return {
        ok: false,
        reason: `verifier blocked the edited segment: ${blocks.map((violation) => `[${violation.kind}] ${violation.detail}`).join("; ")}`,
      };
    }
  }

  // f. At "clean" (the default when no rating is given at all), the edit may not introduce a
  //    profanity word the original segment's text did not already contain — the edit bay never
  //    adds profanity on its own, it can only keep what pass one already wrote.
  const languageRating = opts.languageRating ?? DEFAULT_LANGUAGE_RATING;
  const forbiddenToAdd =
    languageRating === "clean" ? PROFANITY_WORDS : languageRating === "salty" ? STRONG_PROFANITY : [];
  for (const word of forbiddenToAdd) {
    if (wholeWordPresent(editedText, word) && !wholeWordPresent(originalText, word)) {
      return { ok: false, reason: `edited segment introduces profanity at ${languageRating} rating: "${word}"` };
    }
  }

  // g. Team-first survives the cut: the edit may not drop team names faster than it drops words.
  //    (First house-style run, 2026-09-03: the editor trimmed every long team name and kept the
  //    manager's first name, taking the team/manager ratio from 1.24 to 0.72.) Only when FACTS is
  //    available, since the team names come from it.
  if (opts.facts) {
    const teams = opts.facts.teams.map((team) => ({ name: team.name, manager: team.manager }));
    const before = mentionRatio(originalText, teams);
    const after = mentionRatio(editedText, teams);
    const wordFraction = originalWords === 0 ? 1 : editedWords / originalWords;
    const floor = Math.floor(before.teamMentions * wordFraction * 0.8);
    if (before.teamMentions > 0 && after.teamMentions < floor) {
      return {
        ok: false,
        reason: `edited segment cuts team names harder than words: ${before.teamMentions} team-name mentions became ${after.teamMentions} while keeping ${Math.round(wordFraction * 100)}% of the words; keep the team as the subject and cut elsewhere`,
      };
    }
  }

  return { ok: true };
}

const LOCKED_KINDS = new Set(["grade", "ledger", "close"]);

/**
 * Deterministic clean-up of an accepted edit, after the guard has passed it (so nothing here can
 * add a fact): consecutive turns by the same speaker are merged back into one (a split that nobody
 * cut into is just a paragraph break), and a turn marked `interrupts` must follow a DIFFERENT
 * speaker whose line ends with an em dash — the dash is added when missing, unless that line is a
 * locked turn, in which case the flag is dropped instead of touching the locked text.
 */
export function tidyEditedTurns(turns: ShowTurn[], sourceIndexes?: number[]): ShowTurn[] {
  const isLocked = (turn: ShowTurn) => LOCKED_KINDS.has(turn.kind) || CATCHPHRASE_PATTERN.test(turn.text);
  const merged: ShowTurn[] = [];
  const mergedSources: Array<number | undefined> = [];
  turns.forEach((turn, index) => {
    const previous = merged[merged.length - 1];
    const source = sourceIndexes?.[index];
    const previousSource = mergedSources[mergedSources.length - 1];
    // Only the two halves of ONE original turn merge back together. Two different original turns
    // by the same speaker in a row (a witness line, then her locked grade) stay separate.
    const sameOrigin = sourceIndexes === undefined || (source !== undefined && source === previousSource);
    if (previous && previous.speaker === turn.speaker && sameOrigin && !isLocked(previous) && !isLocked(turn)) {
      merged[merged.length - 1] = { ...previous, text: `${previous.text.trim()} ${turn.text.trim()}` };
      return;
    }
    merged.push({ ...turn });
    mergedSources.push(source);
  });

  for (let i = 0; i < merged.length; i++) {
    const turn = merged[i];
    if (!turn.interrupts) continue;
    const previous = i > 0 ? merged[i - 1] : undefined;
    const previousLocked =
      !previous || LOCKED_KINDS.has(previous.kind) || CATCHPHRASE_PATTERN.test(previous.text);
    if (previousLocked) {
      merged[i] = { ...turn, interrupts: undefined };
      continue;
    }
    if (!/[—–-]\s*$/.test(previous.text)) {
      merged[i - 1] = { ...previous, text: `${previous.text.trim().replace(/[.!?…]+$/, "")}—` };
    }
  }

  return merged;
}

/** One final `ShowTurn`: everything from the source turn except `text` and `interrupts`, which come from the edit. */
function buildEditedTurn(source: ShowTurn, edited: EditedTurn): ShowTurn {
  return { ...source, text: edited.text, interrupts: edited.interrupts };
}

/**
 * Runs the edit bay over a finished pass-one transcript, one segment at a time. Every segment gets
 * its own call and its own guard check; a segment that fails the guard (or whose call itself throws)
 * keeps its original turns and is recorded in `stats.rejections` — one bad segment never costs the
 * rest of the episode its edit.
 */
export async function naturalizeTranscript(transcript: ShowTranscript, options: NaturalizeOptions): Promise<NaturalizeResult> {
  const targetRatio = options.targetRatio ?? DEFAULT_TARGET_RATIO;
  const model = options.model ?? DEFAULT_MODEL;
  const effort = options.effort ?? DEFAULT_EFFORT;
  const languageRating = options.languageRating ?? transcript.language ?? DEFAULT_LANGUAGE_RATING;
  const system = buildEditSystemPrompt();

  const stats: NaturalizeStats = {
    segmentsEdited: 0,
    segmentsRejected: 0,
    segmentsRetried: 0,
    wordsBefore: 0,
    wordsAfter: 0,
    promptTokens: 0,
    completionTokens: 0,
    costUsd: 0,
    modelsUsed: [],
    rejections: [],
  };
  const modelsUsed = new Set<string>();

  const newSegments: ShowSegment[] = [];

  for (const segment of transcript.segments) {
    const originalWords = segment.turns.reduce((sum, turn) => sum + wordCount(turn.text), 0);
    stats.wordsBefore += originalWords;

    if (segment.turns.length === 0) {
      newSegments.push(segment);
      continue;
    }

    const targetWords = Math.max(1, Math.round(originalWords * targetRatio));
    const lockedIndexes = lockedIndexesFor(segment);
    const user = buildEditUserPrompt({ segment, targetWords, lockedIndexes });

    let editedTurns: ShowTurn[] | undefined;
    let rejectionReason: string | undefined;

    const attemptEdit = async (prompt: string) => {
      const result = await options.call({ segmentId: segment.id, model, effort, system, user: prompt, maxTokens: EDIT_MAX_TOKENS });
      stats.promptTokens += result.usage.input;
      stats.completionTokens += result.usage.output;
      stats.costUsd += computeCostUsd(result.model, {
        input_tokens: result.usage.input,
        output_tokens: result.usage.output,
        cache_read_input_tokens: result.usage.cacheRead ?? 0,
        cache_creation_input_tokens: result.usage.cacheWrite ?? 0,
      });
      modelsUsed.add(result.model);
      const check = checkEditedSegment(segment, result.output, { facts: options.facts, languageRating });
      return { result, check };
    };

    try {
      let { result, check } = await attemptEdit(user);
      if (!check.ok) {
        // One retry with the guard's own reason fed back (first live runs, 2026-09-03: the editor
        // most often failed by touching a locked grade or dropping Curtis's sign-off, both of
        // which it fixes when told exactly that). A second failure keeps pass one.
        stats.segmentsRetried++;
        const retryPrompt = `${user}\n\nYOUR PREVIOUS EDIT WAS REJECTED: ${check.reason}\nReturn a corrected edit of the same segment that fixes exactly that problem and keeps everything else as you had it.`;
        ({ result, check } = await attemptEdit(retryPrompt));
      }
      if (check.ok) {
        editedTurns = tidyEditedTurns(
          result.output.turns.map((turn) => buildEditedTurn(segment.turns[turn.sourceTurn], turn)),
          result.output.turns.map((turn) => turn.sourceTurn)
        );
      } else {
        rejectionReason = check.reason;
      }
    } catch (error) {
      rejectionReason = error instanceof Error ? error.message : String(error);
    }

    if (editedTurns) {
      newSegments.push({ ...segment, turns: editedTurns });
      stats.segmentsEdited++;
      stats.wordsAfter += editedTurns.reduce((sum, turn) => sum + wordCount(turn.text), 0);
    } else {
      newSegments.push(segment);
      stats.segmentsRejected++;
      stats.wordsAfter += originalWords;
      stats.rejections.push({ segment: segment.id, reason: rejectionReason ?? "unknown failure" });
    }
  }

  stats.modelsUsed = [...modelsUsed];

  const newTranscript: ShowTranscript = {
    ...transcript,
    segments: newSegments,
    edited: {
      pass: "edit-bay-v1",
      wordsBefore: stats.wordsBefore,
      wordsAfter: stats.wordsAfter,
      segmentsEdited: stats.segmentsEdited,
      segmentsRejected: stats.segmentsRejected,
      rejections: stats.rejections,
    },
  };

  return { transcript: newTranscript, stats };
}
