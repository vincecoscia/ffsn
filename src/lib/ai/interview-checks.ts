/**
 * Deterministic, network-free checks for Sam Ortega's interview turns (spec §5).
 *
 * The interview engine (`conversation-service.ts`) lets a model write the opener and the one
 * follow-up. Last season managers complained that follow-ups were redundant and that questions
 * got facts wrong. Everything here is a pure function of the text and the `ConversationContext`
 * so it can run in unit tests and inside `scripts/interview-harness.ts` without a model.
 *
 * The ground truth for "is this fact real" is the CONTEXT block Sam is actually shown, which
 * `factBlockFor` returns (the service's own builder, exported). A fact that lives in the context
 * object but is not on that block is still unsupported: Sam never saw it.
 */
import {
  buildInterviewFactBlock,
  keepVerbatimSegments,
  managerFirstName,
  type AIConversationResult,
  type ConversationContext,
} from './conversation-service';

/* -------------------------------------------------------------------------- */
/* Types                                                                       */
/* -------------------------------------------------------------------------- */

export interface Finding {
  code: string;
  severity: 'block' | 'warn' | 'info';
  detail: string;
}

export type NumberKind = 'number' | 'money' | 'record';

/** One number as it appears in a question or in the CONTEXT block. */
export interface NumberToken {
  /** The text as matched, e.g. "$17", "4-3", "3.02", "6th". */
  raw: string;
  /** `raw` without the dollar sign, thousands separators or ordinal suffix, e.g. "17", "4-3", "3.02", "6". */
  key: string;
  kind: NumberKind;
  /** Numeric value; for a record, the first part (wins). */
  value: number;
  /** Every integer of a record ("5-2-1" -> [5, 2, 1]); a single-element array otherwise. */
  parts: number[];
  index: number;
}

export interface NumberAudit {
  raw: string;
  grounded: boolean;
  /** How it was grounded: "exact", "approx", "record part", "derived (a + b)"; or why not. */
  via: string;
}

export interface NameAudit {
  name: string;
  kind: 'multi' | 'known' | 'single';
  grounded: boolean;
  via: string;
}

export interface VocabularyAudit {
  word: string;
  category: 'nfl_team' | 'injury' | 'rookie' | 'bye' | 'suspended' | 'trade_rumor';
  inBlock: boolean;
}

/** A question that names a player who left his game hurt with start/regret/why wording (spec §16.1). */
export interface InjuryBlameAudit {
  player: string;
  /** The wording that makes it the manager's call: "why did you start", "regret", "walk me through starting". */
  phrase: string;
}

/** Everything `checkQuestionGrounding` looked at, for a reviewer's fact audit. */
export interface QuestionAudit {
  numbers: NumberAudit[];
  names: NameAudit[];
  vocabulary: VocabularyAudit[];
  injuryBlame: InjuryBlameAudit[];
}

/* -------------------------------------------------------------------------- */
/* The CONTEXT block                                                           */
/* -------------------------------------------------------------------------- */

function fmt(n: number | undefined, digits = 1): string {
  if (n === undefined || Number.isNaN(n)) return '';
  return Number.isInteger(n) ? String(n) : n.toFixed(digits);
}

/**
 * The CONTEXT block Sam is given: the real one, through the service's exported
 * `buildInterviewFactBlock`, so these checks can never drift from the text the model saw.
 * (An earlier draft mirrored the private `buildFactBlock`; the export replaced it.)
 */
export function factBlockFor(context: ConversationContext): string {
  return buildInterviewFactBlock(context);
}

/* -------------------------------------------------------------------------- */
/* Text helpers                                                                */
/* -------------------------------------------------------------------------- */

function foldPunctuation(text: string): string {
  return text
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”‟]/g, '"')
    .replace(/[–—]/g, '-');
}

/** Sentences of a question. Decimals ("112.9") and quoted lines (`air." Anything`) do not split. */
export function splitSentences(text: string): string[] {
  return foldPunctuation(text)
    .split(/(?<=[.!?]+["')\]]*)(?=\s)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const STOPWORDS = new Set([
  'that', 'this', 'with', 'what', 'when', 'where', 'which', 'while', 'about', 'your', 'yours',
  'from', 'have', 'having', 'were', 'they', 'them', 'their', 'there', 'then', 'than', 'into',
  'just', 'like', 'also', 'been', 'being', 'does', 'did', 'would', 'could', 'should', 'will',
  'still', 'back', 'going', 'gets', 'give', 'gave', 'take', 'took', 'make', 'made', 'much',
  'many', 'more', 'most', 'some', 'such', 'only', 'over', 'very', 'want', 'wanted', 'thing',
  'things', 'here', 'know', 'knew', 'think', 'thought', 'really', 'because', 'through', 'after',
  'before', 'again', 'other', 'those', 'these', 'each', 'every', 'both', 'same', 'anything',
  'something', 'nothing', 'everything', 'else', 'walk', 'tell', 'told', 'said', 'says', 'yeah',
  'okay', 'sure', 'honestly', 'guess', 'kind', 'kinda', 'sort', 'little', 'well', 'right',
  'down', 'away', 'until', 'since', 'though', 'even', 'ever', 'never', 'always', 'maybe',
  'probably', 'around', 'between', 'behind', 'against', 'under', 'above', 'week', 'weeks',
  'record', 'question', 'time', 'today', 'done', 'doing', 'come', 'came', 'went', 'goes',
  'look', 'looked', 'looking', 'feel', 'felt', 'feels', 'mean', 'means', 'meant', 'need', 'needs',
  'needed', 'point', 'points', 'game', 'games', 'team', 'teams', 'play', 'played', 'call',
  'called', 'name', 'named', 'manager', 'mind', 'people', 'sideline', 'story', 'reporter',
  'ortega', 'ffsn', 'simone',
]);

/** Light stemming so "benched", "benching" and "benches" line up with "bench". */
function stem(word: string): string {
  let w = word;
  if (w.length >= 5 && w.endsWith('ies')) w = `${w.slice(0, -3)}y`;
  else if (w.length >= 5 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
  if (w.length >= 7 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length >= 6 && w.endsWith('ed')) w = w.slice(0, -2);
  return w;
}

/**
 * Content words of a passage: lowercased, possessives stripped, stopwords and anything shorter
 * than four characters removed, lightly stemmed. Numbers with four or more characters ("22.6")
 * survive so they can anchor a follow-up to a reply.
 */
export function contentWords(text: string): Set<string> {
  const tokens = foldPunctuation(text).toLowerCase().match(/[a-z0-9][a-z0-9.'-]*/g) ?? [];
  const words = new Set<string>();
  for (const token of tokens) {
    const bare = token.replace(/'s$/, '').replace(/[.'-]+$/, '');
    if (bare.length < 4 || STOPWORDS.has(bare)) continue;
    words.add(/^[0-9.]+$/.test(bare) ? bare : stem(bare));
  }
  return words;
}

function intersect<T>(a: Set<T>, b: Set<T>): T[] {
  return [...a].filter((x) => b.has(x));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  const shared = intersect(a, b).length;
  return shared / (a.size + b.size - shared);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function containsPhrase(haystack: string, phrase: string): boolean {
  const needle = foldPunctuation(phrase).replace(/\s+/g, ' ').trim();
  if (!needle) return false;
  const pattern = new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(needle).replace(/ /g, '\\s+')}(?![A-Za-z0-9])`, 'i');
  return pattern.test(foldPunctuation(haystack));
}

/* -------------------------------------------------------------------------- */
/* Numbers                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Every number in `text`: "12.5", "12", "$47", "1,200", "6th", a record like "2-1" (or "5-2-1")
 * and a draft slot like "3.02". "49ers" is not a number (nickname check handles it) and neither
 * is the "500" in ".500". Words like "nineteen" are not numbers.
 */
export function extractNumbers(text: string): NumberToken[] {
  const tokens: NumberToken[] = [];
  const re = /(?<![A-Za-z0-9.$])(\$)?(?:(\d+(?:-\d+)+)(?![.\d])|(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?)(?:st|nd|rd|th)?(?![A-Za-z0-9])/g;
  for (const match of foldPunctuation(text).matchAll(re)) {
    const [raw, dollar, record, whole, decimals] = match;
    if (record) {
      const parts = record.split('-').map(Number);
      tokens.push({ raw, key: record, kind: 'record', value: parts[0], parts, index: match.index ?? 0 });
      continue;
    }
    const key = `${whole.replace(/,/g, '')}${decimals ? `.${decimals}` : ''}`;
    const value = Number(key);
    tokens.push({
      raw,
      key,
      kind: dollar ? 'money' : 'number',
      value,
      parts: [value],
      index: match.index ?? 0,
    });
  }
  return tokens;
}

const TOLERANCE = 0.05 + 1e-9;

function auditNumbers(question: string, block: string): NumberAudit[] {
  const blockTokens = extractNumbers(block);
  const blockKeys = new Set(blockTokens.map((t) => t.key));
  const blockValues = blockTokens.flatMap((t) => t.parts.map((part) => ({ part, token: t })));
  const plainValues = blockTokens.filter((t) => t.kind !== 'record').map((t) => t.value);

  return extractNumbers(question).map((token) => {
    if (blockKeys.has(token.key)) return { raw: token.raw, grounded: true, via: 'exact' };
    if (token.kind === 'record') return { raw: token.raw, grounded: false, via: 'record not in CONTEXT' };

    const near = blockValues.find(({ part }) => Math.abs(part - token.value) <= TOLERANCE);
    if (near) {
      return {
        raw: token.raw,
        grounded: true,
        via: near.token.kind === 'record' ? `record part of ${near.token.raw}` : `approx ${near.token.raw}`,
      };
    }

    // "a 98-point bench" for 98.2: the number exists, Sam rounded it. Grounded, but flagged
    // as a warning - the rule is to quote numbers exactly as CONTEXT has them.
    if (Number.isInteger(token.value)) {
      const rounded = plainValues.find((v) => !Number.isInteger(v) && Math.round(v) === token.value);
      if (rounded !== undefined) return { raw: token.raw, grounded: true, via: `rounded from ${fmt(rounded)}` };
    }

    for (let i = 0; i < plainValues.length; i++) {
      for (let j = i + 1; j < plainValues.length; j++) {
        const a = plainValues[i];
        const b = plainValues[j];
        if (Math.abs(a + b - token.value) <= TOLERANCE) {
          return { raw: token.raw, grounded: true, via: `derived (${fmt(a)} + ${fmt(b)})` };
        }
        if (Math.abs(Math.abs(a - b) - token.value) <= TOLERANCE) {
          return { raw: token.raw, grounded: true, via: `derived (${fmt(Math.max(a, b))} - ${fmt(Math.min(a, b))})` };
        }
      }
    }
    return { raw: token.raw, grounded: false, via: 'not in CONTEXT' };
  });
}

/* -------------------------------------------------------------------------- */
/* Names                                                                       */
/* -------------------------------------------------------------------------- */

/** Names the context object knows about, whether or not they made it onto the CONTEXT block. */
export function knownNamesFor(context: ConversationContext): { players: string[]; teams: string[]; people: string[] } {
  const players = new Set<string>();
  const teams = new Set<string>();
  const people = new Set<string>();
  const add = (set: Set<string>, value: string | undefined) => {
    const trimmed = value?.trim();
    if (trimmed) set.add(trimmed);
  };

  const tp = context.teamPerformance;
  add(players, context.topBenchPlayer?.player);
  for (const d of context.lineupDecisions ?? []) {
    add(players, d.benchedPlayer);
    add(players, d.startedPlayer);
  }
  for (const p of [...tp.underperformers, ...tp.overperformers]) add(players, p.player);
  for (const entry of context.inGameInjuries ?? []) add(players, entry.name);
  for (const tx of context.transactionsThisWeek ?? []) {
    tx.playersAdded.forEach((p) => add(players, p));
    tx.playersDropped.forEach((p) => add(players, p));
  }
  for (const trade of context.tradesThisWeek ?? []) {
    add(teams, trade.withTeam);
    trade.gave.forEach((p) => add(players, p));
    trade.received.forEach((p) => add(players, p));
  }
  for (const claim of context.waiverClaimsThisRun ?? []) {
    add(players, claim.player);
    claim.competingBids.forEach((b) => add(teams, b.teamName));
  }
  const highlights = context.waiverSeasonHighlights;
  if (highlights) {
    add(players, highlights.biggestBid?.player);
    add(teams, highlights.biggestBid?.teamName);
    add(teams, highlights.mostActive?.teamName);
    highlights.lowestRemaining.forEach((t) => add(teams, t.teamName));
  }
  for (const pick of [...(context.draftData?.userDraftPicks ?? []), ...(context.draftData?.allDraftPicks ?? [])]) {
    add(players, pick.playerName);
    add(teams, pick.teamName);
    add(people, pick.teamOwner);
  }
  add(teams, context.teamName);
  add(teams, tp.teamName);
  add(teams, context.opponentName);
  add(teams, context.rivalry?.opponent);
  add(teams, context.leagueName);
  for (const s of context.leagueContext.standings) add(teams, s.teamName);
  for (const r of context.leagueContext.rivalries ?? []) {
    add(teams, r.team1);
    add(teams, r.team2);
  }
  for (const t of context.leagueContext.recentTrades ?? []) {
    t.teams.forEach((team) => add(teams, team));
    t.players.forEach((p) => add(players, p));
  }
  add(people, context.managerName);
  add(people, context.writerContext?.name);

  return { players: [...players], teams: [...teams], people: [...people] };
}

/** Names Sam may use without them being in CONTEXT: herself, the desk, the parties, "Week". */
export function allowlistFor(context: ConversationContext): Set<string> {
  const words = new Set([
    'sam', 'simone', 'ortega', 'ffsn', 'week', 'i',
    // Capitalized for grammar, not because they are facts.
    "i'll", "i'm", "i'd", "i've", 'anything',
    'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
    'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december',
    // Fantasy shorthand that rides along with a name ("$3 FAAB Jaguars D/ST", "ADP 170").
    'faab', 'adp', 'dst', 'd/st', 'ppr', 'mnf', 'snf', 'tnf', 'wr1', 'rb1', 'qb1', 'te1',
  ]);
  const first = managerFirstName(context.managerName);
  if (first) words.add(first.toLowerCase());
  for (const word of (context.writerContext?.name ?? '').split(/\s+/)) {
    if (word) words.add(word.toLowerCase().replace(/[^a-z'-]/g, ''));
  }
  return words;
}

interface WordToken {
  text: string;
  start: number;
  end: number;
  capitalized: boolean;
  sentenceInitial: boolean;
}

function wordTokens(sentence: string): WordToken[] {
  const tokens: WordToken[] = [];
  const re = /[A-Za-z][A-Za-z'.-]*|\$?\d[\d.,-]*/g;
  let first = true;
  for (const match of sentence.matchAll(re)) {
    const text = match[0];
    const start = match.index ?? 0;
    // A word that opens a quoted clause (`You said "Got cute"`) is capitalized for the same
    // reason a sentence opener is, so it gets the same benefit of the doubt.
    const before = sentence.slice(0, start).trimEnd();
    const quoteInitial = /["'(]$/.test(before);
    tokens.push({
      text,
      start,
      end: start + text.length,
      capitalized: /^[A-Z]/.test(text),
      sentenceInitial: first || quoteInitial,
    });
    first = false;
  }
  return tokens;
}

function stripPossessive(word: string): string {
  return word.replace(/'s$/i, '').replace(/[.'-]+$/, '');
}

function isAllCaps(word: string): boolean {
  return word.length >= 2 && word === word.toUpperCase() && /[A-Z]/.test(word);
}

function blockWords(block: string): Set<string> {
  return new Set((foldPunctuation(block).toLowerCase().match(/[a-z][a-z'.-]*/g) ?? []).map(stripPossessive));
}

function auditNames(question: string, context: ConversationContext, block: string): NameAudit[] {
  const allow = allowlistFor(context);
  const known = knownNamesFor(context);
  const knownWords = new Set<string>();
  const knownFull = new Set<string>();
  for (const name of [...known.players, ...known.teams, ...known.people]) {
    knownFull.add(name.toLowerCase().replace(/\s+/g, ' '));
    for (const word of name.split(/\s+/)) {
      const w = stripPossessive(word).toLowerCase();
      if (w.length >= 3 && !STOPWORDS.has(w)) knownWords.add(w);
    }
  }
  const inBlock = blockWords(block);
  const audits: NameAudit[] = [];
  const seen = new Set<string>();

  const record = (audit: NameAudit) => {
    const key = `${audit.kind}:${audit.name.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    audits.push(audit);
  };

  const nicknames = new Set(NFL_TEAM_NICKNAMES.map((n) => n.toLowerCase()));

  const evaluate = (run: WordToken[]): void => {
    // Peel allowlisted words off both ends ("Sam Ortega", "Week", "Thanks Priya").
    while (run.length && allow.has(stripPossessive(run[0].text).toLowerCase())) run = run.slice(1);
    while (run.length && allow.has(stripPossessive(run[run.length - 1].text).toLowerCase())) run = run.slice(0, -1);
    if (run.length === 0) return;

    const phrase = run.map((t) => stripPossessive(t.text)).join(' ');
    if (run.length >= 2) {
      if (containsPhrase(block, phrase)) {
        record({ name: phrase, kind: 'multi', grounded: true, via: 'in CONTEXT' });
      } else if (knownFull.has(phrase.toLowerCase())) {
        record({ name: phrase, kind: 'known', grounded: false, via: 'known to the context object but not on the CONTEXT block' });
      } else if (run[0].sentenceInitial) {
        // "Did Mahomes ..." - the sentence opener is not part of the name.
        evaluate(run.slice(1));
      } else {
        record({ name: phrase, kind: 'multi', grounded: false, via: 'not in CONTEXT' });
      }
      return;
    }

    const single = run[0];
    const word = stripPossessive(single.text);
    const lower = word.toLowerCase();
    if (single.sentenceInitial || lower === 'i' || isAllCaps(word) || word.length < 2) return;
    if (nicknames.has(lower)) return; // the vocabulary audit owns NFL nicknames
    if (inBlock.has(lower) || allow.has(lower)) {
      record({ name: word, kind: 'single', grounded: true, via: 'in CONTEXT' });
    } else if (knownWords.has(lower)) {
      record({ name: word, kind: 'known', grounded: false, via: 'known to the context object but not on the CONTEXT block' });
    } else {
      record({ name: word, kind: 'single', grounded: false, via: 'not in CONTEXT' });
    }
  };

  for (const sentence of splitSentences(question)) {
    const tokens = wordTokens(sentence);
    let i = 0;
    while (i < tokens.length) {
      if (!tokens[i].capitalized || /^\$?\d/.test(tokens[i].text)) {
        i++;
        continue;
      }
      // A run of capitalized words separated only by whitespace ("Kittle Me This").
      let j = i;
      while (
        j + 1 < tokens.length &&
        tokens[j + 1].capitalized &&
        !/^\$?\d/.test(tokens[j + 1].text) &&
        /^\s+$/.test(sentence.slice(tokens[j].end, tokens[j + 1].start))
      ) {
        j++;
      }
      evaluate(tokens.slice(i, j + 1));
      i = j + 1;
    }
  }
  return audits;
}

/* -------------------------------------------------------------------------- */
/* Vocabulary that implies a fact                                              */
/* -------------------------------------------------------------------------- */

/** All 32 NFL nicknames plus the common short forms. Capitalized whole-word matches only. */
export const NFL_TEAM_NICKNAMES = [
  'Cardinals', 'Falcons', 'Ravens', 'Bills', 'Panthers', 'Bears', 'Bengals', 'Browns',
  'Cowboys', 'Broncos', 'Lions', 'Packers', 'Texans', 'Colts', 'Jaguars', 'Jags', 'Chiefs',
  'Raiders', 'Chargers', 'Rams', 'Dolphins', 'Vikings', 'Patriots', 'Pats', 'Saints', 'Giants',
  'Jets', 'Eagles', 'Steelers', '49ers', 'Niners', 'Seahawks', 'Buccaneers', 'Bucs', 'Titans',
  'Commanders',
] as const;

const VOCABULARY: Array<{ category: VocabularyAudit['category']; pattern: RegExp }> = [
  { category: 'nfl_team', pattern: new RegExp(`(?<![A-Za-z0-9])(${NFL_TEAM_NICKNAMES.join('|')})(?![A-Za-z0-9])`, 'g') },
  { category: 'injury', pattern: /\b(injur(?:y|ies|ed)|hurt)\b/gi },
  { category: 'rookie', pattern: /\b(rookies?)\b/gi },
  { category: 'bye', pattern: /\b(bye)\b/gi },
  { category: 'suspended', pattern: /\b(suspend(?:ed|sion))\b/gi },
  { category: 'trade_rumor', pattern: /\b(trade rumou?rs?)\b/gi },
];

function auditVocabulary(question: string, block: string): VocabularyAudit[] {
  const audits: VocabularyAudit[] = [];
  for (const { category, pattern } of VOCABULARY) {
    for (const match of question.matchAll(pattern)) {
      const word = match[1];
      const inBlock = new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(word)}(?![A-Za-z0-9])`, 'i').test(block);
      if (!audits.some((a) => a.word.toLowerCase() === word.toLowerCase())) audits.push({ word, category, inBlock });
    }
  }
  return audits;
}

/* -------------------------------------------------------------------------- */
/* Question checks                                                             */
/* -------------------------------------------------------------------------- */

export interface GroundingOptions {
  /**
   * What the manager has said so far. Sam may quote it back ("you said 7-6 better become
   * 8-6"), so numbers, names and vocabulary in a reply are grounded for the questions that
   * follow it.
   */
  replies?: string[];
}

/** The text a question is grounded against: the CONTEXT block plus anything the manager said. */
function groundingText(context: ConversationContext, options?: GroundingOptions): string {
  const replies = (options?.replies ?? []).filter((r) => r && r.trim().length > 0);
  return replies.length ? `${factBlockFor(context)}\nMANAGER SAID:\n${replies.join('\n')}` : factBlockFor(context);
}

/**
 * The wording that makes starting a player the manager's call (spec §16.1): a why-did-you-start,
 * a regret, a should-have, a mistake, points left on the bench behind him, "walk me through
 * starting", the decision to start. "Who covers the slot now" and "how do you replace him" are
 * the sanctioned questions and match none of these.
 */
const INJURY_BLAME_QUESTION_RE =
  /\b(why\b[^?]{0,40}\b(?:start|play|went with|go with|roll(?:ed)? with|in (?:your|the) lineup)|regret|second[- ]guess|should(?:n't| not)?(?: you)? have\b|mistake|blunder|indefensible|inexcusable|left [^?]{0,30}\bon the bench|lineup (?:call|decision|error|mistake)|(?:walk|talk|take) me through (?:starting|the (?:call|decision) to start)|the (?:call|decision) to start|start(?:ing|ed)? (?:him|her) over|(?:his|your|her) fault)\b/i;

function auditInjuryBlame(question: string, context: ConversationContext): InjuryBlameAudit[] {
  const audits: InjuryBlameAudit[] = [];
  const injuries = context.inGameInjuries ?? [];
  if (injuries.length === 0) return audits;
  for (const sentence of splitSentences(question)) {
    const blame = INJURY_BLAME_QUESTION_RE.exec(sentence);
    if (!blame) continue;
    for (const entry of injuries) {
      if (!mentionsName(sentence, entry.name)) continue;
      if (audits.some((a) => a.player === entry.name)) continue;
      audits.push({ player: entry.name, phrase: blame[1] });
    }
  }
  return audits;
}

/**
 * A question that asks why the manager started a player who left his game hurt, or whether
 * they regret it, is the one question no reporter would ask (owner, 2026-09-05). Blocks.
 */
export function checkInjuryBlameQuestion(question: string, context: ConversationContext): Finding[] {
  return auditInjuryBlame(question, context).map((audit) => {
    const entry = (context.inGameInjuries ?? []).find((e) => e.name === audit.player);
    const status = entry ? ` (${entry.status})` : '';
    return {
      code: 'injury_blame_question',
      severity: 'block' as const,
      detail: `${audit.player} left his game hurt${status}; "${audit.phrase}" asks about the lineup call, not the replacement`,
    };
  });
}

/** Everything the grounding check looked at, for a reviewer to verify by hand. */
export function auditQuestion(question: string, context: ConversationContext, options?: GroundingOptions): QuestionAudit {
  const block = groundingText(context, options);
  return {
    numbers: auditNumbers(question, block),
    names: auditNames(question, context, block),
    vocabulary: auditVocabulary(question, block),
    injuryBlame: auditInjuryBlame(question, context),
  };
}

/**
 * A score must read manager-first, as CONTEXT writes it ("lost 107.6-143.8 to Team Rive").
 * "You dropped 143.8 to 107.6" reverses it, and a reader hears the wrong result.
 */
export function checkScoreOrder(question: string, context: ConversationContext): Finding[] {
  const mine = context.teamPerformance.score;
  const theirs = context.opponentScore;
  if (!(mine > 0) || theirs === undefined || Math.abs(mine - theirs) <= TOLERANCE) return [];
  const findings: Finding[] = [];
  const pair = /(\d+(?:\.\d+)?)\s*(?:-|–|—|\bto\b)\s*(\d+(?:\.\d+)?)/g;
  for (const match of foldPunctuation(question).matchAll(pair)) {
    const a = Number(match[1]);
    const b = Number(match[2]);
    if (Math.abs(a - theirs) <= TOLERANCE && Math.abs(b - mine) <= TOLERANCE) {
      findings.push({
        code: 'score_order_reversed',
        severity: 'block',
        detail: `"${match[0]}" puts the opponent's ${fmt(theirs)} before the manager's ${fmt(mine)}; CONTEXT writes it ${fmt(mine)}-${fmt(theirs)}`,
      });
    }
  }
  return findings;
}

/**
 * Every number in the question must be in the CONTEXT block (exact, within 0.05, a part of a
 * record on the block, or the sum/difference of two block numbers - the last is reported as info
 * so a reviewer can see the arithmetic). Every multi-word proper noun and every known player or
 * team name must be on the block or in the allowlist. Vocabulary that implies a fact (NFL
 * nicknames, injuries, rookies, byes, suspensions, trade rumors) is a warning unless the block
 * contains it. Unsupported numbers and names block; vocabulary warns.
 */
export function checkQuestionGrounding(question: string, context: ConversationContext, options?: GroundingOptions): Finding[] {
  const findings: Finding[] = [];
  const audit = auditQuestion(question, context, options);

  for (const number of audit.numbers) {
    if (!number.grounded) {
      findings.push({ code: 'unsupported_number', severity: 'block', detail: `"${number.raw}" is ${number.via}` });
    } else if (number.via.startsWith('derived')) {
      findings.push({ code: 'number_derived', severity: 'info', detail: `"${number.raw}" is only grounded as ${number.via}` });
    } else if (number.via.startsWith('rounded')) {
      findings.push({ code: 'number_rounded', severity: 'warn', detail: `"${number.raw}" is ${number.via}; CONTEXT numbers are quoted exactly` });
    }
  }
  findings.push(...checkScoreOrder(question, context));

  for (const name of audit.names) {
    if (name.grounded) continue;
    if (name.kind === 'single') {
      findings.push({ code: 'unknown_proper_noun', severity: 'warn', detail: `"${name.name}" is capitalized mid-sentence and ${name.via}` });
    } else {
      findings.push({ code: 'unsupported_name', severity: 'block', detail: `"${name.name}" is ${name.via}` });
    }
  }

  for (const entry of audit.vocabulary) {
    if (entry.inBlock) continue;
    findings.push({
      code: `vocab_${entry.category}`,
      severity: 'warn',
      detail: `"${entry.word}" implies a ${entry.category.replace(/_/g, ' ')} fact that is not in CONTEXT`,
    });
  }

  findings.push(...checkInjuryBlameQuestion(question, context));

  return findings;
}

const EMOJI = /\p{Extended_Pictographic}/u;

/**
 * Exactly one question mark (0 or 2+ block). At most three sentences for the opener and two
 * otherwise, no exclamation points, no emoji (warn). The opener must introduce Sam by name and
 * say "record" so the manager knows this is on the record (warn if missing).
 */
export function checkQuestionShape(question: string, options: { isOpener: boolean }): Finding[] {
  const findings: Finding[] = [];
  const marks = (question.match(/\?/g) ?? []).length;
  // "Walk me through it" is Sam's sanctioned phrasing (system prompt rule 5): an imperative
  // interview prompt counts as the one question, just without the mark.
  const imperativePrompt = /\b(walk|talk|take) me through\b|\btell me\b|\bgive me\b|\bexplain\b|\bdescribe\b/i.test(question);
  if (marks === 0 && !imperativePrompt) {
    findings.push({ code: 'no_question', severity: 'block', detail: 'contains no question mark and no "walk me through" prompt' });
  } else if (marks === 0) {
    findings.push({ code: 'imperative_prompt', severity: 'info', detail: 'asks with an imperative ("walk me through") rather than a question mark' });
  }
  if (marks >= 2) findings.push({ code: 'multiple_questions', severity: 'block', detail: `contains ${marks} question marks` });

  const sentences = splitSentences(question);
  const limit = options.isOpener ? 3 : 2;
  if (sentences.length > limit) {
    findings.push({ code: 'too_many_sentences', severity: 'warn', detail: `${sentences.length} sentences (limit ${limit})` });
  }
  if (question.includes('!')) findings.push({ code: 'exclamation', severity: 'warn', detail: 'contains an exclamation point' });
  if (EMOJI.test(question)) findings.push({ code: 'emoji', severity: 'warn', detail: 'contains an emoji' });

  if (options.isOpener) {
    if (!/\b(Sam|Ortega)\b/.test(question)) {
      findings.push({ code: 'opener_no_intro', severity: 'warn', detail: 'opener does not introduce Sam Ortega by name' });
    }
    if (!/\brecord\b/i.test(question)) {
      findings.push({ code: 'opener_no_record_disclosure', severity: 'warn', detail: 'opener does not say this is on the record' });
    }
  }
  return findings;
}

/* -------------------------------------------------------------------------- */
/* Follow-up redundancy                                                        */
/* -------------------------------------------------------------------------- */

function nameAliases(name: string): string[] {
  const aliases = [name];
  for (const word of name.split(/\s+/)) {
    const w = stripPossessive(word);
    if (w.length >= 4 && !STOPWORDS.has(w.toLowerCase())) aliases.push(w);
  }
  return aliases;
}

function mentionsName(text: string, name: string): boolean {
  return nameAliases(name).some((alias) => containsPhrase(text, alias));
}

/**
 * The follow-up must dig into something the manager actually said (spec §5 rule 6).
 *  (a) restates a specific fact (a number or a known name) that was in the opener but not in the
 *      reply - warn "restates_opener_fact";
 *  (b) shares no content word with the reply - block "not_anchored";
 *  (c) is the opener again (Jaccard of content words >= 0.5) - block "same_question";
 *  (d) asks what the reply already answered: the interrogative sentence's content words are at
 *      least 70% contained in the reply - warn "already_answered".
 */
export function checkFollowUpRedundancy(
  opener: string,
  reply: string,
  followUp: string,
  context: ConversationContext
): Finding[] {
  const findings: Finding[] = [];

  // (a) restated facts. A "Week 1" or a "$0 left" is framing, not a fact worth counting.
  const replyNumbers = new Set(extractNumbers(reply).map((t) => t.key));
  const openerNumbers = new Set(extractNumbers(opener).map((t) => t.key));
  const restated: string[] = [];
  const folded = foldPunctuation(followUp);
  for (const token of extractNumbers(followUp)) {
    if (token.kind !== 'record' && token.value < 2) continue;
    if (/\bweek\s*$/i.test(folded.slice(Math.max(0, token.index - 6), token.index))) continue;
    if (openerNumbers.has(token.key) && !replyNumbers.has(token.key) && !restated.includes(token.raw)) restated.push(token.raw);
  }
  const known = knownNamesFor(context);
  for (const name of [...known.players, ...known.teams]) {
    if (mentionsName(followUp, name) && mentionsName(opener, name) && !mentionsName(reply, name)) restated.push(name);
  }
  if (restated.length > 0) {
    findings.push({
      code: 'restates_opener_fact',
      severity: 'warn',
      detail: `restates opener fact${restated.length > 1 ? 's' : ''} the manager did not bring up: ${restated.map((r) => `"${r}"`).join(', ')}`,
    });
  }

  // (b) anchor. Sam may also offer the manager a writer's line about them (system prompt
  // rule 10); a follow-up built on that line is anchored in CONTEXT rather than the reply.
  const replyWords = contentWords(reply);
  const followWords = contentWords(followUp);
  const anchors = intersect(followWords, replyWords);
  const followLower = foldPunctuation(followUp).toLowerCase();
  const quotesWriter = (context.writerContext?.recentMentions ?? []).some((m) => {
    const evidence = foldPunctuation(m.evidence).toLowerCase();
    if (evidence.length < 20) return false;
    for (let start = 0; start + 20 <= evidence.length; start += 5) {
      if (followLower.includes(evidence.slice(start, start + 20))) return true;
    }
    return false;
  });
  if (anchors.length === 0 && quotesWriter) {
    findings.push({ code: 'anchored_by_writer_mention', severity: 'info', detail: "built on the writer's line from CONTEXT rather than on the reply" });
  } else if (anchors.length === 0) {
    findings.push({ code: 'not_anchored', severity: 'block', detail: 'not anchored in reply: shares no content word with what the manager said' });
  }

  // (c) same question
  const openerWords = contentWords(opener);
  const similarity = jaccard(openerWords, followWords);
  if (similarity >= 0.5) {
    findings.push({ code: 'same_question', severity: 'block', detail: `re-asks the opener (content-word Jaccard ${similarity.toFixed(2)})` });
  }

  // (d) already answered
  const interrogatives = splitSentences(followUp).filter((s) => s.includes('?'));
  const asked = contentWords(interrogatives.length ? interrogatives.join(' ') : followUp);
  if (asked.size >= 3) {
    const covered = intersect(asked, replyWords).length / asked.size;
    if (covered >= 0.7) {
      findings.push({
        code: 'already_answered',
        severity: 'warn',
        detail: `asks something the reply already covered (${Math.round(covered * 100)}% of its content words are in the reply)`,
      });
    }
  }

  return findings;
}

/* -------------------------------------------------------------------------- */
/* Quotes and declines                                                         */
/* -------------------------------------------------------------------------- */

const DECLINE_PATTERNS = [
  /\bno comment\b/i,
  /^\s*(?:i'?ll\s+)?pass\b/i,
  /\bnot today\b/i,
  /\bi'?d rather not\b/i,
  /\bi decline\b/i,
  /\bno thanks\b/i,
  /\bnothing to say\b/i,
  /\bnot going to comment\b/i,
  /\bwon'?t (?:be )?comment/i,
  /\bnot commenting\b/i,
  /\bdon'?t want to (?:talk|comment|get into)/i,
  /\bleave me out\b/i,
  /\boff the record\b/i,
];

/** "No comment", "pass", "not today", "I'd rather not" and their neighbours. */
export function isDeclineReply(reply: string): boolean {
  const text = foldPunctuation(reply);
  return DECLINE_PATTERNS.some((pattern) => pattern.test(text));
}

const VERBISH = new Set([
  'is', 'am', 'are', 'was', 'were', 'be', 'been', 'had', 'has', 'have', 'got', 'get', 'did', 'do',
  'does', 'think', 'thought', 'feel', 'felt', 'knew', 'know', 'should', 'could', 'would', 'can',
  'will', 'went', 'go', 'made', 'make', 'stick', 'print', 'need', 'blame', 'benched', 'started',
  'start', 'sit', 'play', 'played', 'lost', 'won', 'win', 'lose', 'wanted', 'want', 'said', 'say',
  'trust', 'trusted', 'regret', 'hate', 'love', 'run', 'ran', "don't", 'not', 'no', 'never',
]);

function isVerbish(word: string): boolean {
  const w = word.toLowerCase().replace(/[^a-z']/g, '');
  if (VERBISH.has(w)) return true;
  if (/'(s|m|re|ve|d|ll)$/.test(w) || /n't$/.test(w)) return true;
  return w.length >= 4 && w.endsWith('ed');
}

/**
 * Every quotable segment must be verbatim in the reply (`keepVerbatimSegments` decides, so the
 * check matches what storage would keep); a segment of fewer than three words with nothing
 * verb-like is a topic label, not a quote; and a substantive reply (eight words or more, not a
 * decline) should yield at least one segment.
 */
export function checkQuotes(reply: string, quotableSegments: string[]): Finding[] {
  const findings: Finding[] = [];
  for (const segment of quotableSegments) {
    if (keepVerbatimSegments(reply, [segment]).length === 0) {
      findings.push({ code: 'quote_not_verbatim', severity: 'block', detail: `"${segment}" is not a verbatim span of the reply` });
      continue;
    }
    const words = segment.trim().split(/\s+/).filter(Boolean);
    if (words.length < 3 && !words.some(isVerbish)) {
      findings.push({ code: 'quote_topic_label', severity: 'warn', detail: `"${segment}" reads as a topic label, not a quote` });
    }
  }
  const replyWords = reply.trim().split(/\s+/).filter(Boolean).length;
  if (quotableSegments.length === 0 && replyWords >= 8 && !isDeclineReply(reply)) {
    findings.push({ code: 'no_quotes', severity: 'warn', detail: `no quotable segment from a ${replyWords}-word reply` });
  }
  return findings;
}

/**
 * When the manager declined, Sam's next turn must record the decline and close (spec §5 rule 8).
 * When they did not decline but Sam recorded one anyway, that is reported as info so a reviewer
 * can decide whether "gave nothing on substance" applied.
 */
export function checkDecline(
  reply: string,
  result: Pick<AIConversationResult, 'shouldRecordDecline' | 'intent'>
): Finding[] {
  const findings: Finding[] = [];
  if (isDeclineReply(reply)) {
    if (!result.shouldRecordDecline) {
      findings.push({ code: 'decline_not_recorded', severity: 'block', detail: 'the manager declined but shouldRecordDecline is false' });
    }
    if (result.intent !== 'closing') {
      findings.push({ code: 'decline_not_closed', severity: 'block', detail: `the manager declined but intent is "${result.intent}", not "closing"` });
    }
  } else if (result.shouldRecordDecline) {
    findings.push({ code: 'decline_recorded', severity: 'info', detail: 'shouldRecordDecline is true on a reply that does not read as a decline' });
  }
  return findings;
}
