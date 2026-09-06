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

/** A story is about a player when it is tagged to this many athletes or fewer (spec §5.1). */
export const NEWS_MAX_ATHLETES = 3;

/** A news article as a card, or undefined when it is untagged or a listicle (too many athletes). */
export function newsArticleToCard(article: EspnNewsArticle, opts: { fetchedAt: number }): WireFactCard | undefined {
  if (article.athletes.length === 0 || article.athletes.length > NEWS_MAX_ATHLETES) return undefined;
  const note = trimNote(article.description);
  const names = article.athletes.map(athlete => athlete.name);
  const timetable = timetableAbout(article.headline, names) ?? timetableAbout(article.description, names);
  return {
    kind: "news",
    observedAt: asTimestamp(article.published) ?? opts.fetchedAt,
    players: article.athletes.map(athlete => ({ espnId: athlete.espnId, name: athlete.name })),
    headline: article.headline,
    ...(note ? { note } : {}),
    ...(timetable ? { timetable } : {}),
    source: { type: "espn_news", id: article.id, ...(article.url ? { url: article.url } : {}), fetchedAt: opts.fetchedAt },
  };
}
