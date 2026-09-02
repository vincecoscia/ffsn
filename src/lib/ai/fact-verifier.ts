// Deterministic post-generation verifier. No LLM, no network, no I/O.
//
// Everything here compares the model's structured output against the FACTS block that was in its
// prompt. A violation is either a `block` (regenerate the section), a `strip` (delete the offending
// sentence) or a `warn` (publish, flag for the commissioner).

import type { FactsBlock, FactsPlayer } from "./facts";
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
  /** Far fewer sections or words than the template calls for; held for review, never published as-is. */
  | "thin_article";

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

export function verifyArticle(article: GeneratedArticleT, facts: FactsBlock): Violation[] {
  const violations: Violation[] = [];

  const teamById = new Map(facts.teams.map(team => [team.id, team]));
  const teamNames = new Set(facts.teams.map(team => team.name.toLowerCase()));
  const managers = new Set(
    facts.teams.map(team => (team.manager ?? "").toLowerCase()).filter(name => name.length > 0)
  );
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
  const quoteById = new Map(facts.quotes.map(quote => [quote.id, quote]));
  const ledgerTexts = facts.quotes.map(quote => normalizeQuote(quote.text));
  const silentSpeakers = new Set(facts.nonRespondents.map(entry => entry.speaker.toLowerCase()));
  const numberStrings = collectNumbers(facts, new Set<string>());
  const numberValues = [...numberStrings].map(Number).filter(Number.isFinite);

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
      if (playerNames.has(lower) || teamNames.has(lower) || managers.has(lower)) continue;
      if (NFL_TEAMS.has(lower) || lower.split(/\s+/).every(word => COMMON_WORDS.has(word))) continue;
      if ([...playerNames, ...teamNames, ...managers].some(known => known.includes(lower) || lower.includes(known))) {
        continue;
      }
      violations.push({ kind: "unknown_player", detail: noun, section: section.name, severity: "warn" });
    }
  }

  return violations;
}
