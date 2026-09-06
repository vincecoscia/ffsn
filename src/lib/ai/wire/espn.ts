// The Wire — ESPN payload → fact card parsing rules (spec §6, §12.1). Pure and strict: a shape
// that does not parse yields nothing, never a bad card. Shared by the eval script and available to
// the Convex pollers so both build cards the same way.
//
// ESPN's site-API injuries feed omits `athlete.id`; the id lives in `athlete.links[].href`
// ("/nfl/player/_/id/{id}/…") and matches `playersEnhanced.espnId`. News carries athlete ids in
// `categories[].athleteId`.

import { extractTimetable } from "./timetable";
import { MAX_NOTE_CHARS, type WireCardPlayer, type WireFactCard } from "./types";

/* ------------------------------------------------------------------------------------------- *
 * Narrowing helpers
 * ------------------------------------------------------------------------------------------- */

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asTimestamp(value: unknown): number | undefined {
  const text = asString(value);
  if (!text) return undefined;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** `note`/`headline` fields carry ESPN's text verbatim, trimmed to MAX_NOTE_CHARS. */
export function trimNote(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return undefined;
  return collapsed.length <= MAX_NOTE_CHARS ? collapsed : collapsed.slice(0, MAX_NOTE_CHARS).trimEnd();
}

/** The words a sentence must carry to be about this player: the last name, or the whole name. */
function nameKeys(name: string): string[] {
  const words = name
    .replace(/\b(?:Jr|Sr|II|III|IV)\.?$/i, "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const keys = new Set<string>([name.toLowerCase()]);
  if (words.length > 0) keys.add(words[words.length - 1].toLowerCase());
  return [...keys].filter(key => key.length >= 3);
}

/**
 * Sentence boundaries in ESPN prose: ". ", "! ", "? " followed by a capital or an opening quote,
 * but never after an initial ("C.J. Stroud") or a suffix/abbreviation ("Etienne Jr. is", "vs. the").
 */
export function splitProseSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?]["”’)]*)(?<!\b[A-Z]\.)(?<!\b(?:Jr|Sr|Mr|Dr|St|No|vs|Mt)\.)\s+(?=["“(]?[A-Z0-9])/)
    .map(sentence => sentence.trim())
    .filter(sentence => sentence.length > 0);
}

/**
 * The timetable in `text` that is about one of `names` — read sentence by sentence, and only
 * from a sentence that names the player. ESPN's long comments routinely describe a teammate's
 * season-ending injury in the same blurb, and that timetable must never land on this card.
 */
export function timetableAbout(text: string | undefined, names: ReadonlyArray<string>): string | undefined {
  if (!text) return undefined;
  const keys = names.flatMap(nameKeys);
  if (keys.length === 0) return undefined;
  for (const sentence of splitProseSentences(text)) {
    const lower = sentence.toLowerCase();
    if (!keys.some(key => new RegExp(`\\b${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(lower))) continue;
    const found = extractTimetable(sentence);
    if (found) return found;
  }
  return undefined;
}

/* ------------------------------------------------------------------------------------------- *
 * Injuries
 * ------------------------------------------------------------------------------------------- */

export interface EspnInjuryEntry {
  id: string;
  status: string;
  /** ISO timestamp as ESPN wrote it, e.g. "2026-09-04T21:36Z". */
  date?: string;
  shortComment?: string;
  longComment?: string;
  /** `type.abbreviation`: A / Q / O / IR / D / SUSP. */
  typeAbbreviation?: string;
  athlete: {
    espnId: string;
    name: string;
    position?: string;
    nflTeam?: string;
  };
}

/** The athlete id from ESPN's player links, or undefined when no link carries one. */
export function espnAthleteIdFromLinks(links: unknown): string | undefined {
  for (const link of asArray(links)) {
    const href = asString(asRecord(link)?.href);
    const match = href?.match(/\/id\/(\d+)(?:\/|$|\?)/);
    if (match) return match[1];
  }
  return undefined;
}

/** One entry of `injuries[team].injuries[]`, or undefined when it lacks an id, status or athlete id. */
export function parseEspnInjuryEntry(raw: unknown): EspnInjuryEntry | undefined {
  const entry = asRecord(raw);
  if (!entry) return undefined;
  const id = asString(entry.id);
  const status = asString(entry.status);
  const athlete = asRecord(entry.athlete);
  if (!id || !status || !athlete) return undefined;
  const espnId = asString(athlete.id) ?? espnAthleteIdFromLinks(athlete.links);
  const name = asString(athlete.displayName) ?? [asString(athlete.firstName), asString(athlete.lastName)].filter(Boolean).join(" ");
  if (!espnId || !name) return undefined;
  return {
    id,
    status,
    date: asString(entry.date),
    shortComment: asString(entry.shortComment),
    longComment: asString(entry.longComment),
    typeAbbreviation: asString(asRecord(entry.type)?.abbreviation),
    athlete: {
      espnId,
      name,
      position: asString(asRecord(athlete.position)?.abbreviation),
      nflTeam: asString(asRecord(athlete.team)?.abbreviation),
    },
  };
}

/** Every parseable entry in an injuries payload, with the team it was listed under. */
export function parseEspnInjuriesPayload(payload: unknown): Array<{ teamName: string; entry: EspnInjuryEntry }> {
  const out: Array<{ teamName: string; entry: EspnInjuryEntry }> = [];
  for (const team of asArray(asRecord(payload)?.injuries)) {
    const record = asRecord(team);
    const teamName = asString(record?.displayName) ?? "";
    for (const raw of asArray(record?.injuries)) {
      const entry = parseEspnInjuryEntry(raw);
      if (entry) out.push({ teamName, entry });
    }
  }
  return out;
}

export interface InjuryCardOptions {
  fetchedAt: number;
  /**
   * The status the poller last saw for this entry. Unknown (a first sighting) → a non-Active entry
   * is treated as a change from "Active"; an Active one is a note.
   */
  statusFrom?: string;
  /** Roster context when the poller has it. */
  percentOwned?: number;
  adpPositionRank?: number;
}

/** An injuries entry as a fact card: `injury_status` when the designation changed, else `injury_note`. */
export function injuryEntryToCard(entry: EspnInjuryEntry, opts: InjuryCardOptions): WireFactCard {
  const statusFrom = opts.statusFrom ?? "Active";
  const changed = statusFrom.trim().toLowerCase() !== entry.status.trim().toLowerCase();
  const note = trimNote(entry.shortComment);
  const timetable = timetableAbout(entry.shortComment, [entry.athlete.name]) ?? timetableAbout(entry.longComment, [entry.athlete.name]);
  const player: WireCardPlayer = {
    espnId: entry.athlete.espnId,
    name: entry.athlete.name,
    ...(entry.athlete.position ? { position: entry.athlete.position } : {}),
    ...(entry.athlete.nflTeam ? { nflTeam: entry.athlete.nflTeam } : {}),
    ...(opts.percentOwned !== undefined ? { percentOwned: opts.percentOwned } : {}),
    ...(opts.adpPositionRank !== undefined ? { adpPositionRank: opts.adpPositionRank } : {}),
  };
  return {
    kind: changed ? "injury_status" : "injury_note",
    observedAt: asTimestamp(entry.date) ?? opts.fetchedAt,
    players: [player],
    ...(entry.athlete.nflTeam ? { nflTeam: entry.athlete.nflTeam } : {}),
    ...(changed ? { statusFrom, statusTo: entry.status } : { statusTo: entry.status }),
    ...(note ? { note } : {}),
    ...(timetable ? { timetable } : {}),
    source: { type: "espn_injuries", id: entry.id, fetchedAt: opts.fetchedAt },
  };
}

/* ------------------------------------------------------------------------------------------- *
 * News
 * ------------------------------------------------------------------------------------------- */

export interface EspnNewsArticle {
  id: string;
  /** ESPN's own article type - "Story", "HeadlineNews", "Media", … `newsRelevance` treats
   *  "HeadlineNews" as relevant on its own (ESPN's short wire items, not features). */
  type?: string;
  headline: string;
  description?: string;
  published?: string;
  url?: string;
  athletes: Array<{ espnId: string; name: string }>;
}

/** One `articles[]` item, or undefined without an id and headline. */
export function parseEspnNewsArticle(raw: unknown): EspnNewsArticle | undefined {
  const article = asRecord(raw);
  if (!article) return undefined;
  const id = article.id !== undefined && article.id !== null ? String(article.id) : undefined;
  const headline = asString(article.headline);
  if (!id || !headline) return undefined;
  const type = asString(article.type);
  const athletes: Array<{ espnId: string; name: string }> = [];
  for (const raw of asArray(article.categories)) {
    const category = asRecord(raw);
    if (!category || category.type !== "athlete") continue;
    const nested = asRecord(category.athlete);
    const espnId =
      category.athleteId !== undefined && category.athleteId !== null
        ? String(category.athleteId)
        : nested?.id !== undefined && nested.id !== null
          ? String(nested.id)
          : undefined;
    const name = asString(nested?.description) ?? asString(category.description);
    if (espnId && name && !athletes.some(athlete => athlete.espnId === espnId)) athletes.push({ espnId, name });
  }
  const links = asRecord(article.links);
  const url = asString(asRecord(links?.web)?.href);
  return {
    id,
    ...(type ? { type } : {}),
    headline: headline.trim(),
    description: asString(article.description),
    published: asString(article.published),
    url,
    athletes,
  };
}

export function parseEspnNewsPayload(payload: unknown): EspnNewsArticle[] {
  const out: EspnNewsArticle[] = [];
  for (const raw of asArray(asRecord(payload)?.articles)) {
    const article = parseEspnNewsArticle(raw);
    if (article) out.push(article);
  }
  return out;
}

/**
 * A story is untagged noise past this many athletes (a fantasy rankings dump, a cheat sheet) - not
 * the relevance bar itself. Matches `LISTICLE_ATHLETE_LIMIT` in convex/intel.ts: both exist to keep a
 * mega-post from posing as a single-player card, not to decide whether the story is worth a card at
 * all (that's `newsRelevance` below - spec update 2026-09-06, "athlete count is the wrong proxy").
 */
export const NEWS_MAX_ATHLETES = 6;

/** How many players a news card ever carries, whatever `NEWS_MAX_ATHLETES` allows through. */
const NEWS_CARD_MAX_PLAYERS = 3;

export interface NewsRelevanceResult {
  relevant: boolean;
  signal?: "timetable" | "status" | "role" | "transaction" | "headline_news";
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Word-boundaried, case-insensitive. Deliberately no bare "return" (a WR "back with New York" is not
// news; "returns to practice" is) and no bare "trade" rumor-mill words beyond the transaction list.
const STATUS_SIGNAL_PATTERNS: ReadonlyArray<RegExp> = [
  // "out" only in its status sense - never the idiom ("stands out", "figure out", "out of the gate").
  /\b(?:is|are|was|were|be|been|remains?|remained|ruled|listed|declared|expected|likely|still|officially)\s+out\b/i,
  /\bout\s+(?:for|indefinitely|until|through|at least|week|weeks|\d|the (?:season|year|game|opener|rest|remainder))\b/i,
  /\bquestionable\b/i,
  /\bdoubtful\b/i,
  /\binjur(?:y|ed|ies)\b/i,
  /\binjured reserve\b/i,
  /\bIR\b/,
  /\bPUP\b/,
  /\bsurgery\b/i,
  /\bconcussion\b/i,
  /\bhamstring\b/i,
  /\bankle\b/i,
  /\bknee\b/i,
  /\bMRI\b/,
  /\bcarted\b/i,
  /\bsidelined\b/i,
  /\blimited\b/i,
  /\bdid not practice\b/i,
  /\bDNP\b/,
  /\bactivated\b/i,
  /\bcleared\b/i,
  /\binactive\b/i,
  /\bweek[- ]to[- ]week\b/i,
  /\bday[- ]to[- ]day\b/i,
  /\bgame-time decision\b/i,
  /\bexpected to (?:play|miss|sit|start)\b/i,
  /\bwill (?:miss|play|sit|start)\b/i,
  /\breturn(?:s|ed|ing)? (?:from|to)\b/i,
];

const ROLE_SIGNAL_PATTERNS: ReadonlyArray<RegExp> = [
  // "starting" only about a job - never "starting to click"; "starter" only as a role.
  /\bstarters\b/i,
  /\b(?:the|a|new|his|as|named|becomes?|became)\s+starter\b/i,
  /\bstarting\s+(?:job|role|spot|nod|lineup|running back|receiver|wide receiver|quarterback|tight end|RB|WR|QB|TE|left|right|center|guard|tackle)\b/i,
  /\bstart(?:s|ed)?\s+(?:at|in place of|over|ahead of|for the)\b/i,
  /\bnamed the starter\b/i,
  /\bdepth chart\b/i,
  /\b(?:RB1|WR1|QB1|TE1)\b/i,
  /\bbenched\b/i,
  /\bdemoted\b/i,
  /\bpromoted\b/i,
  /\bsnap counts?\b/i,
  /\bworkhorse\b/i,
  /\bcommittee\b/i,
  /\bfirst-team\b/i,
];

const TRANSACTION_SIGNAL_PATTERNS: ReadonlyArray<RegExp> = [
  /\bsigned\b/i,
  /\bsigns\b/i,
  /\bagrees to (?:a )?deal\b/i,
  /\breleased\b/i,
  /\bwaived\b/i,
  /\btraded\b/i,
  /\btrade\b/i,
  /\bclaimed\b/i,
  // "cut" only as a roster move - never "cut it close" or "cut back".
  /\b(?:was|were|been|be|get|gets|got|being)\s+cut\b/i,
  /\bcut\s+(?:by|from|loose|ties|(?:RB|WR|QB|TE|K|DE|LB|CB|S|OL|DL|veteran|rookie)\b)/i,
  /\bsuspended\b/i,
  /\bsuspension\b/i,
  /\breinstated\b/i,
  /\bextension\b/i,
  /\bcontract\b/i,
  /\brestructur\w*\b/i,
  /\bfranchise tag\b/i,
  /\bholdout\b/i,
  /\bretire(?:s|d|ment)?\b/i,
];

function matchesAny(text: string, patterns: ReadonlyArray<RegExp>): boolean {
  return patterns.some(pattern => pattern.test(text));
}

/**
 * Is this article worth a wire card at all? Athlete count alone is the wrong relevance proxy (spec
 * update 2026-09-06): a four-athlete "what will the Patriots do if Henderson is out" question is
 * exactly the kind of story the Wire exists for, while a three-athlete feature ("the story behind
 * the Steelers' field blessing") is not. Evaluated on the headline + description, case-insensitive,
 * word-boundaried so "outlooks" never reads as the status word "out". `type === "HeadlineNews"` is
 * relevant on its own - ESPN's own short wire items, as opposed to a longer "Story" feature.
 */
export function newsRelevance(article: EspnNewsArticle): NewsRelevanceResult {
  const names = article.athletes.map(athlete => athlete.name);
  if (timetableAbout(article.headline, names) ?? timetableAbout(article.description, names)) {
    return { relevant: true, signal: "timetable" };
  }
  const text = `${article.headline} ${article.description ?? ""}`;
  if (matchesAny(text, STATUS_SIGNAL_PATTERNS)) return { relevant: true, signal: "status" };
  if (matchesAny(text, ROLE_SIGNAL_PATTERNS)) return { relevant: true, signal: "role" };
  if (matchesAny(text, TRANSACTION_SIGNAL_PATTERNS)) return { relevant: true, signal: "transaction" };
  if (article.type === "HeadlineNews") return { relevant: true, signal: "headline_news" };
  return { relevant: false };
}

/** Does `headline` name this player, by full name or last name (reuses `nameKeys`'s matching rule)? */
function athleteNamedInHeadline(headline: string, name: string): boolean {
  const lower = headline.toLowerCase();
  return nameKeys(name).some(key => new RegExp(`\\b${escapeRegExp(key)}\\b`).test(lower));
}

/** Athletes the headline names first (in their given order), then the rest - so a listicle-shaped
 *  tag list still leads with whoever the story is actually about once capped to three. */
function orderAthletesForCard(
  headline: string,
  athletes: EspnNewsArticle["athletes"]
): EspnNewsArticle["athletes"] {
  const named: EspnNewsArticle["athletes"] = [];
  const rest: EspnNewsArticle["athletes"] = [];
  for (const athlete of athletes) (athleteNamedInHeadline(headline, athlete.name) ? named : rest).push(athlete);
  return [...named, ...rest];
}

/**
 * A news article as a card, or undefined when it is untagged, too broadly tagged (> NEWS_MAX_ATHLETES,
 * a rankings dump), or not relevant (`newsRelevance`). `players` is capped to NEWS_CARD_MAX_PLAYERS,
 * headline-named athletes first, so a card never lists more people than a post can credit.
 */
export function newsArticleToCard(article: EspnNewsArticle, opts: { fetchedAt: number }): WireFactCard | undefined {
  if (article.athletes.length === 0 || article.athletes.length > NEWS_MAX_ATHLETES) return undefined;
  if (!newsRelevance(article).relevant) return undefined;

  const ordered = orderAthletesForCard(article.headline, article.athletes).slice(0, NEWS_CARD_MAX_PLAYERS);
  const note = trimNote(article.description);
  const names = ordered.map(athlete => athlete.name);
  const timetable = timetableAbout(article.headline, names) ?? timetableAbout(article.description, names);
  return {
    kind: "news",
    observedAt: asTimestamp(article.published) ?? opts.fetchedAt,
    players: ordered.map(athlete => ({ espnId: athlete.espnId, name: athlete.name })),
    headline: article.headline,
    ...(note ? { note } : {}),
    ...(timetable ? { timetable } : {}),
    source: { type: "espn_news", id: article.id, ...(article.url ? { url: article.url } : {}), fetchedAt: opts.fetchedAt },
  };
}
