// Deterministic post-generation verifier. No LLM, no network, no I/O.
//
// Everything here compares the model's structured output against the FACTS block that was in its
// prompt. A violation is either a `block` (regenerate the section), a `strip` (delete the offending
// sentence) or a `warn` (publish, flag for the commissioner).

import type { FactsBlock, FactsPlayer } from "./facts";
import type { ContentTemplate } from "./content-templates";
import type { GeneratedArticleT } from "./content-generation-service";

export type ViolationKind =
  | "unknown_player"
  | "unknown_team"
  | "unverified_number"
  | "bad_quote"
  | "ghost_speaker"
  | "bad_source_path"
  | "wrong_fantasy_team"
  /** `:::quote{id=…}` naming a quote that is not in the ledger (spec §8.3). */
  | "unknown_quote_directive"
  /** A `quotes[]` entry that never appears as a directive in the body (spec §8.3). */
  | "quote_not_placed"
  /** A claim whose team ids do not resolve against FACTS (spec §8.4). */
  | "bad_claim"
  /** Optional Sonnet 5 pass: the body contradicts FACTS (spec §8.6). */
  | "llm_contradicted"
  /** Optional Sonnet 5 pass: the body states something FACTS neither supports nor denies. */
  | "llm_unsupported"
  /** A `$N` dollar figure in the body does not match any `facts.waivers` claim or budget line. */
  | "faab_amount_unverified"
  /** Far fewer sections or words than the template calls for; held for review, never published as-is. */
  | "thin_article"
  /** Every section the template calls required is present, but an optional one is not (spec §11.2.5). */
  | "sections_missing"
  /** Prompt-layer register in the prose: a FACTS field name, an internal id, a timestamp (§11.2.4). */
  | "data_speak"
  /** Editor pass scored the facts below 3; the article is held for review (spec §11.2.7). */
  | "editor_hold"
  /** Editor pass scored the voice below 3. A warning; voice never blocks (spec §11.2.7). */
  | "editor_voice"
  /** The editor pass was enabled but did not run (API error, bad schema); the article shipped on the deterministic checks alone. */
  | "editor_unavailable";

export interface Violation {
  kind: ViolationKind;
  detail: string;
  section?: string;
  severity: "block" | "strip" | "warn";
}

/**
 * Inline pull-quote directive (spec §8.3): `:::quote{id=Q1}` alone on its line. The writer places
 * one for every ledger quote printed in the body; `MarkdownPreview` renders it as a `<PullQuote>`.
 *
 * This pattern must stay character-identical to `QUOTE_DIRECTIVE_LINE` in
 * `src/components/MarkdownPreview.tsx`. Anything looser would let the verifier pass a directive
 * the renderer silently drops.
 */
const QUOTE_DIRECTIVE_LINE = /^[ \t]*:::quote\{id=([A-Za-z0-9_-]+)\}[ \t]*$/gm;

/** Every quote id placed as a directive in this text, in order of appearance. */
export function parseQuoteDirectives(content: string): string[] {
  const ids: string[] = [];
  for (const match of content.matchAll(QUOTE_DIRECTIVE_LINE)) ids.push(match[1]);
  return ids;
}

/** Removes the directive lines naming any of `ids`, leaving the surrounding prose alone. */
export function stripQuoteDirectives(content: string, ids: Set<string>): string {
  if (ids.size === 0) return content;
  return content
    .split("\n")
    .filter(line => {
      const match = /^[ \t]*:::quote\{id=([A-Za-z0-9_-]+)\}[ \t]*$/.exec(line);
      return !(match && ids.has(match[1]));
    })
    .join("\n");
}

/** Whitespace- and curly-quote-insensitive comparison key for quote text. */
export function normalizeQuote(text: string): string {
  return text
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * `section` on a violation that came out of the title rather than a section body. The title has no
 * heading of its own, so the finalize step recognises this sentinel and re-titles instead of
 * regenerating a section (spec §11.2.4).
 */
export const TITLE_SECTION = "__title__";

/* -------------------------------------------------------------------------- */
/* Register check (spec §11.2.4)                                               */
/*                                                                             */
/* The writer is handed a machine-readable FACTS block and is expected to speak */
/* like a broadcaster. When the two leak into each other the article says       */
/* "T7 posted a pointsFor of 812.4" instead of "the Grinders have scored more   */
/* than anyone". Every pattern below is a phrase no human broadcaster says.     */
/* -------------------------------------------------------------------------- */

/** FACTS field names. Matched as whole identifiers, so "would have replaced" in prose is fine. */
const FACTS_FIELD_NAMES = [
  "benchImpact",
  "available_players",
  "fantasyTeamId",
  "fantasyTeamName",
  "nflTeam",
  "pointsFor",
  "wouldHaveReplaced",
  "pointGain",
  "questionTopic",
  "priorClaims",
];

/** What a leak is, for the regeneration prompt: the phrase plus why it is not English. */
export interface RegisterLeak {
  phrase: string;
  why: string;
}

const REGISTER_PATTERNS: Array<{ pattern: RegExp; why: string }> = [
  {
    pattern: new RegExp(`\\b(?:${FACTS_FIELD_NAMES.join("|")})\\b`, "gi"),
    why: "a FACTS field name",
  },
  { pattern: /\b(?:ledger|payload|JSON)\b/gi, why: "prompt-layer jargon" },
  { pattern: /\bdata feed\b/gi, why: "prompt-layer jargon" },
  { pattern: /\bthe sheet\b/gi, why: "prompt-layer jargon" },
  // "FACTS" only as the block's own name: the ordinary word "facts" is perfectly good English and
  // a case-insensitive match on it would block half the desk.
  { pattern: /<\/?FACTS>|\bFACTS\b|\b[Ff]acts (?:block|blob|ledger)\b/g, why: "the name of the prompt block" },
  // "came through" is only data-speak when the subject is the data. "Halyard Bay came through in
  // the fourth" is exactly the sentence this desk exists to write, so the pipeline nouns are
  // required for a match.
  {
    pattern:
      /\b(?:nothing|none|no comment|no response|quotes?|comments?|responses?|replies|answers?|data|numbers|feed|ledger|payload)\b[^.!?]{0,24}?\bcame through\b/gi,
    why: "pipeline talk",
  },
  {
    pattern: /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/g,
    why: "an ISO-8601 timestamp",
  },
  // Internal ids (T3, M1, Q2, U1, D19, X4, TR2, W3, B2). Never preceded by a letter or a digit, so
  // player initials ("TJ") and ids inside longer tokens ("M1Pp204") do not match.
  { pattern: /(?<![A-Za-z0-9])(?:TR|[TMQUDXWB])\d+\b/g, why: "an internal id" },
];

/** Quote directives are markup for the renderer, not prose; their ids must not read as leaks. */
const QUOTE_DIRECTIVE_ANY = /^[ \t]*:::quote\{id=[A-Za-z0-9_-]+\}[ \t]*$/gm;

/** Every register leak in one piece of text, deduplicated, in order of appearance. */
export function findRegisterLeaks(text: string): RegisterLeak[] {
  if (!text) return [];
  const prose = text.replace(QUOTE_DIRECTIVE_ANY, "");
  const seen = new Map<string, RegisterLeak>();
  for (const { pattern, why } of REGISTER_PATTERNS) {
    for (const match of prose.matchAll(pattern)) {
      const phrase = match[0].trim();
      if (phrase.length === 0 || seen.has(phrase.toLowerCase())) continue;
      seen.set(phrase.toLowerCase(), { phrase, why });
    }
  }
  return [...seen.values()];
}

/** `data_speak` violations for one piece of text. `section` names where the finalize step looks. */
function registerViolations(text: string, section: string): Violation[] {
  return findRegisterLeaks(text).map(leak => ({
    kind: "data_speak" as const,
    detail: `"${leak.phrase}" is ${leak.why}, not something a broadcaster says. Remove it and write the same point in plain English.`,
    section,
    severity: "block" as const,
  }));
}

/* -------------------------------------------------------------------------- */
/* Required sections (spec §11.2.5)                                            */
/* -------------------------------------------------------------------------- */

/**
 * The model titles its sections in its own voice, so a name-by-name match against the template is
 * meaningless. What is checkable is the count: an article with fewer sections than the template has
 * *required* sections is definitionally missing a required one.
 *
 * Fewer sections than the template has in total, but at least the required count, is a `warn`.
 */
export function verifyRequiredSections(
  article: Pick<GeneratedArticleT, "sections">,
  template: ContentTemplate | undefined
): Violation[] {
  const total = template?.sections?.length ?? 0;
  if (total === 0) return [];
  const required = template!.sections.filter(section => section.required).length;
  const got = article.sections?.length ?? 0;

  if (got < required) {
    return [
      {
        kind: "thin_article",
        detail: `${got} section(s) for a template with ${required} required section(s) (${total} in all); a required section is missing`,
        severity: "strip",
      },
    ];
  }
  if (got < total) {
    return [
      {
        kind: "sections_missing",
        detail: `${got} of ${total} template sections; every required section is present`,
        severity: "warn",
      },
    ];
  }
  return [];
}

const COMMON_WORDS = new Set([
  "the", "and", "but", "for", "week", "sunday", "monday", "tuesday", "wednesday", "thursday",
  "friday", "saturday", "january", "february", "march", "april", "may", "june", "july", "august",
  "september", "october", "november", "december", "fantasy", "football", "league", "playoff",
  "playoffs", "championship", "bench", "starter", "waiver", "faab", "adp", "ppr", "nfl", "espn",
  "ffsn", "round", "pick", "draft", "points", "manager", "commissioner", "good", "evening",
]);

const NFL_TEAMS = new Set([
  "arizona", "atlanta", "baltimore", "buffalo", "carolina", "chicago", "cincinnati", "cleveland",
  "dallas", "denver", "detroit", "green bay", "houston", "indianapolis", "jacksonville",
  "kansas city", "las vegas", "los angeles", "miami", "minnesota", "new england", "new orleans",
  "new york", "philadelphia", "pittsburgh", "san francisco", "seattle", "tampa bay", "tennessee",
  "washington", "cardinals", "falcons", "ravens", "bills", "panthers", "bears", "bengals",
  "browns", "cowboys", "broncos", "lions", "packers", "texans", "colts", "jaguars", "chiefs",
  "raiders", "rams", "chargers", "dolphins", "vikings", "patriots", "saints", "giants", "jets",
  "eagles", "steelers", "49ers", "niners", "seahawks", "buccaneers", "titans", "commanders",
]);

function collectNumbers(value: unknown, sink: Set<string>): Set<string> {
  if (typeof value === "number" && Number.isFinite(value)) {
    sink.add(String(value));
    sink.add(value.toFixed(1));
  } else if (Array.isArray(value)) {
    value.forEach(entry => collectNumbers(entry, sink));
  } else if (value && typeof value === "object") {
    Object.values(value as Record<string, unknown>).forEach(entry => collectNumbers(entry, sink));
  }
  return sink;
}

/** Accepts a decimal derivable as the sum or difference of any two FACTS numbers (±0.05). */
function isDerivable(candidate: number, numbers: number[]): boolean {
  for (let i = 0; i < numbers.length; i++) {
    for (let j = i; j < numbers.length; j++) {
      if (Math.abs(numbers[i] + numbers[j] - candidate) <= 0.05) return true;
      if (Math.abs(numbers[i] - numbers[j] - candidate) <= 0.05) return true;
      if (Math.abs(numbers[j] - numbers[i] - candidate) <= 0.05) return true;
    }
  }
  return false;
}

/** Walks a dotted path like `matchups.M1.players.M1P3.points` or `teams.T3.pointsFor`. */
export function resolvePath(facts: FactsBlock, path: string): unknown {
  let current: unknown = facts;
  for (const segment of path.split(".")) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const byId = current.find(entry => {
        const row = entry as Record<string, unknown>;
        return row?.id === segment || row?.teamId === segment;
      });
      if (byId !== undefined) {
        current = byId;
        continue;
      }
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return undefined;
      current = current[index];
      continue;
    }
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function looseNumEq(resolved: unknown, asserted: string): boolean {
  const assertedNumber = Number(String(asserted).replace(/[^0-9.\-]/g, ""));
  if (typeof resolved === "number" && Number.isFinite(assertedNumber)) {
    return Math.abs(resolved - assertedNumber) <= 0.05;
  }
  return normalizeQuote(String(resolved)) === normalizeQuote(String(asserted));
}

function properNouns(text: string): string[] {
  const matches = text.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z'’]+)+/g) ?? [];
  return [...new Set(matches)];
}

function splitSentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/);
}

/**
 * Proper-noun warnings that are almost always the start of an ordinary sentence rather than a name
 * the writer invented (spec §11.3.11). "The Grinders had it won" must not read as an unknown
 * player, or the real warnings drown.
 */
const LEADING_NOISE_WORDS = new Set(["the", "because", "here", "and", "but", "so", "now"]);

export interface VerifyOptions {
  /**
   * The template this article was written from. Given it, the verifier also reports missing
   * required sections (spec §11.2.5); without it that check is simply skipped, which is what the
   * recorded eval samples and the batch path rely on.
   */
  template?: ContentTemplate;
}

export function verifyArticle(
  article: GeneratedArticleT,
  facts: FactsBlock,
  options?: VerifyOptions
): Violation[] {
  const violations: Violation[] = [];

  const teamById = new Map(facts.teams.map(team => [team.id, team]));
  const teamNames = new Set(facts.teams.map(team => team.name.toLowerCase()));
  const managers = new Set(
    facts.teams.map(team => (team.manager ?? "").toLowerCase()).filter(name => name.length > 0)
  );
  // Division names are proper nouns a writer legitimately prints ("the East", "Team X leads the
  // West") and must never read as an unknown team or player (spec: format audit).
  const divisionNames = new Set(facts.format.divisions.map(division => division.name.toLowerCase()));
  const playerById = new Map<string, FactsPlayer>(
    facts.matchups.flatMap(matchup => matchup.players).map(player => [player.id, player])
  );
  // Draft articles feature players by their pick id ("D19"); they have no matchup line, so index
  // them as players of the drafting team or every draft grade is blocked as an unknown player.
  for (const pick of facts.draftPicks ?? []) {
    if (playerById.has(pick.id)) continue;
    playerById.set(pick.id, {
      id: pick.id,
      name: pick.player,
      pos: pick.pos,
      fantasyTeamId: pick.teamId,
      points: 0,
      projected: pick.projected,
      lineup: "bench",
    });
  }
  const playerNames = new Set([...playerById.values()].map(player => player.name.toLowerCase()));
  // A bench swap names the starter it would have replaced; that starter is a real player in FACTS
  // even when he has no line of his own, so he must not read as an unknown proper noun.
  for (const player of playerById.values()) {
    if (player.benchImpact?.wouldHaveReplaced) playerNames.add(player.benchImpact.wouldHaveReplaced.toLowerCase());
  }
  // Waiver-ledger players (winners, competing bidders' targets, and drops) are real players in
  // FACTS even though they carry no matchup line; they must not read as unknown proper nouns.
  for (const claim of facts.waivers.latestRun?.claims ?? []) {
    if (claim.player.name) playerNames.add(claim.player.name.toLowerCase());
    if (claim.dropped?.name) playerNames.add(claim.dropped.name.toLowerCase());
  }
  const quoteById = new Map(facts.quotes.map(quote => [quote.id, quote]));
  const ledgerTexts = facts.quotes.map(quote => normalizeQuote(quote.text));
  const silentSpeakers = new Set(facts.nonRespondents.map(entry => entry.speaker.toLowerCase()));
  const numberStrings = collectNumbers(facts, new Set<string>());
  const numberValues = [...numberStrings].map(Number).filter(Number.isFinite);

  // Every dollar figure a waiver claim or budget can support (spec: FAAB ledger). A `$N` in the
  // body that matches none of these is either an invented bid or a mangled real one — dollar
  // amounts have no meaning in this app outside the waiver ledger, so this check runs unconditionally.
  const faabAmounts = new Set<number>();
  for (const claim of facts.waivers.latestRun?.claims ?? []) {
    faabAmounts.add(claim.bid);
    for (const bid of claim.competingBids) faabAmounts.add(bid.bid);
  }
  for (const budget of facts.waivers.budgets) {
    if (budget.budget !== undefined) faabAmounts.add(budget.budget);
    if (budget.spent !== undefined) faabAmounts.add(budget.spent);
    if (budget.remaining !== undefined) faabAmounts.add(budget.remaining);
  }
  if (facts.waivers.season.biggestBid) faabAmounts.add(facts.waivers.season.biggestBid.bid);
  if (facts.waivers.season.totalSpent !== undefined) faabAmounts.add(facts.waivers.season.totalSpent);
  if (facts.waivers.season.averageWinningBid !== undefined) faabAmounts.add(facts.waivers.season.averageWinningBid);

  // `facts.upcoming` needs no block kind of its own: its sides carry the same `T…` team ids as
  // everything else, so a featuredTeams entry for an upcoming opponent resolves through `teamById`
  // above; its projections and head-to-head counts are reached by `collectNumbers`, so they read as
  // known numbers in the prose sweep; and `keyStats[].source` paths like "upcoming.U1.home.projected"
  // resolve because `resolvePath` matches array entries by their `id`.

  // 1. Structured references must resolve.
  for (const team of article.featuredTeams ?? []) {
    if (!teamById.has(team.teamId)) {
      violations.push({ kind: "unknown_team", detail: `${team.teamName} (${team.teamId})`, severity: "block" });
    }
  }
  for (const player of article.featuredPlayers ?? []) {
    const known = playerById.get(player.playerId);
    if (!known) {
      violations.push({ kind: "unknown_player", detail: `${player.playerName} (${player.playerId})`, severity: "block" });
      continue;
    }
    if (player.fantasyTeamId && known.fantasyTeamId !== player.fantasyTeamId) {
      violations.push({
        kind: "wrong_fantasy_team",
        detail: `${player.playerName}: article says ${player.fantasyTeamId}, FACTS says ${known.fantasyTeamId} (${player.playerId})`,
        severity: "block",
      });
    }
  }

  // 2. Quotes must be verbatim, attributed to the speaker who actually said them.
  for (const quote of article.quotes ?? []) {
    const source = quoteById.get(quote.quoteId);
    if (!source) {
      violations.push({
        kind: "ghost_speaker",
        detail: `${quote.speaker}: no ledger entry for ${quote.quoteId}`,
        section: quote.sectionName,
        severity: "block",
      });
      continue;
    }
    if (normalizeQuote(quote.text) !== normalizeQuote(source.text)) {
      violations.push({
        kind: "bad_quote",
        detail: `${quote.speaker}: "${quote.text}" != ledger "${source.text}"`,
        section: quote.sectionName,
        severity: "block",
      });
    }
    if (quote.speaker.toLowerCase() !== source.speaker.toLowerCase()) {
      violations.push({
        kind: "ghost_speaker",
        detail: `quote ${quote.quoteId} attributed to ${quote.speaker}, said by ${source.speaker}`,
        section: quote.sectionName,
        severity: "block",
      });
    }
    if (silentSpeakers.has(quote.speaker.toLowerCase())) {
      violations.push({
        kind: "ghost_speaker",
        detail: `${quote.speaker} did not respond but is quoted`,
        section: quote.sectionName,
        severity: "block",
      });
    }
  }

  // 2b. Inline pull-quote directives (spec §8.3). An unknown id blocks; a ledger quote the writer
  // reported using but never placed in the body only warns — it still renders in the trailing
  // "From the sideline" block, but the writer was asked to place it.
  const placedQuoteIds = new Set<string>();
  for (const section of article.sections ?? []) {
    for (const id of parseQuoteDirectives(section.content ?? "")) {
      placedQuoteIds.add(id);
      if (!quoteById.has(id)) {
        violations.push({
          kind: "unknown_quote_directive",
          detail: `:::quote{id=${id}} has no ledger entry`,
          section: section.name,
          severity: "block",
        });
      }
    }
  }
  for (const quote of article.quotes ?? []) {
    if (!quoteById.has(quote.quoteId)) continue; // already blocked above as a ghost quote
    if (placedQuoteIds.has(quote.quoteId)) continue;
    violations.push({
      kind: "quote_not_placed",
      detail: `${quote.quoteId} (${quote.speaker}) is in quotes[] but no :::quote{id=${quote.quoteId}} directive appears in the body`,
      section: quote.sectionName,
      severity: "warn",
    });
  }

  // 2c. Claims must name teams that exist. The claim is stripped; the section around it stands.
  for (const claim of article.claims ?? []) {
    const teamFields: Array<[string, string | undefined]> = [
      ["subjectTeamId", claim.subjectTeamId],
      ["opponentTeamId", claim.opponentTeamId],
    ];
    for (const [field, id] of teamFields) {
      if (!id) continue;
      if (teamById.has(id)) continue;
      violations.push({
        kind: "bad_claim",
        detail: `claim "${claim.text}" ${field} ${id} is not a FACTS team id`,
        severity: "strip",
      });
    }
  }

  // 3. Every keyStat must name a FACTS path that resolves to the asserted value.
  for (const stat of article.keyStats ?? []) {
    const resolved = resolvePath(facts, stat.source);
    if (resolved === undefined) {
      violations.push({ kind: "bad_source_path", detail: `${stat.stat}: ${stat.source}`, severity: "strip" });
    } else if (!looseNumEq(resolved, stat.value)) {
      violations.push({
        kind: "unverified_number",
        detail: `${stat.stat}=${stat.value} but ${stat.source}=${String(resolved)}`,
        severity: "strip",
      });
    }
  }

  // 4. Prose sweep.
  for (const section of article.sections ?? []) {
    const content = section.content ?? "";

    for (const decimal of content.match(/\b\d+\.\d\b/g) ?? []) {
      if (!numberStrings.has(decimal) && !isDerivable(Number(decimal), numberValues)) {
        violations.push({ kind: "unverified_number", detail: decimal, section: section.name, severity: "warn" });
      }
    }

    for (const match of content.matchAll(/\$(\d+(?:\.\d+)?)/g)) {
      const amount = Number(match[1]);
      if (!faabAmounts.has(amount)) {
        violations.push({
          kind: "faab_amount_unverified",
          detail: `$${match[1]}`,
          section: section.name,
          severity: "warn",
        });
      }
    }

    for (const span of content.match(/["“]([^"“”]{25,})["”]/g) ?? []) {
      const inner = normalizeQuote(span.replace(/^["“]|["”]$/g, ""));
      if (!ledgerTexts.some(text => text.includes(inner))) {
        violations.push({ kind: "bad_quote", detail: span.slice(0, 60), section: section.name, severity: "strip" });
      }
    }

    for (const sentence of splitSentences(content)) {
      if (!/["“”]/.test(sentence)) continue;
      for (const speaker of silentSpeakers) {
        if (sentence.toLowerCase().includes(speaker)) {
          violations.push({
            kind: "ghost_speaker",
            detail: `${speaker} did not respond but appears beside quoted text`,
            section: section.name,
            severity: "block",
          });
        }
      }
    }

    for (const noun of properNouns(content)) {
      const lower = noun.toLowerCase();
      // "The Grinders", "Here Comes", "But Nobody" — a sentence opener, not a name (spec §11.3.11).
      if (LEADING_NOISE_WORDS.has(lower.split(/\s+/)[0])) continue;
      if (playerNames.has(lower) || teamNames.has(lower) || managers.has(lower) || divisionNames.has(lower)) continue;
      if (NFL_TEAMS.has(lower) || lower.split(/\s+/).every(word => COMMON_WORDS.has(word))) continue;
      if ([...playerNames, ...teamNames, ...managers, ...divisionNames].some(known => known.includes(lower) || lower.includes(known))) {
        continue;
      }
      violations.push({ kind: "unknown_player", detail: noun, section: section.name, severity: "warn" });
    }
  }

  // 5. Register check (spec §11.2.4). The title carries the sentinel section name so the finalize
  //    step re-titles instead of hunting for a heading that does not exist.
  violations.push(...registerViolations(article.title ?? "", TITLE_SECTION));
  for (const section of article.sections ?? []) {
    violations.push(...registerViolations(section.content ?? "", section.name));
  }

  // 6. Required sections (spec §11.2.5), when the caller told us which template this is.
  violations.push(...verifyRequiredSections(article, options?.template));

  return violations;
}
