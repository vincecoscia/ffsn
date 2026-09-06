// The Wire — the fact card (spec §3.1, §8.1): validation, the plain no-model rendering the reader
// sees when there is no take, and the numbers/names a take is allowed to use.
//
// Pure: zod and the shared contract only. Imported by the Convex default runtime, so nothing here
// may touch Node built-ins or the Anthropic SDK.

import { z } from "zod";
import {
  BIG_LINE_PASS_YARDS,
  BIG_LINE_RUSH_REC_YARDS,
  BIG_LINE_TD,
  BUST_WATCH_MAX_POINTS,
  GLOBAL_EVENT_KINDS,
  MAX_NOTE_CHARS,
  MAX_POST_CHARS,
  TRENDING_BOARD_SIZE,
  type WireCardLine,
  type WireCardRelated,
  type WireFactCard,
  type WireSourceType,
  type WireTag,
} from "./types";

/* ------------------------------------------------------------------------------------------- *
 * Validation
 * ------------------------------------------------------------------------------------------- */

const SOURCE_TYPES = [
  "espn_injuries",
  "espn_news",
  "espn_scoreboard",
  "espn_summary",
  "espn_fantasy",
  "sleeper",
  "nflverse",
  "internal",
] as const satisfies ReadonlyArray<WireSourceType>;

const WireCardPlayerSchema = z.object({
  espnId: z.string().min(1, "espnId is required"),
  name: z.string().min(1, "name is required"),
  position: z.string().optional(),
  nflTeam: z.string().optional(),
  percentOwned: z.number().min(0).max(100).optional(),
  adpPositionRank: z.number().int().positive().optional(),
});

const WireSourceRefSchema = z.object({
  type: z.enum(SOURCE_TYPES),
  id: z.string().optional(),
  url: z.string().optional(),
  fetchedAt: z.number(),
});

// Live game engine (spec §19)
const WireCardGameSchema = z.object({
  eventId: z.string().min(1, "eventId is required"),
  home: z.string().min(1, "home is required"),
  away: z.string().min(1, "away is required"),
  homeScore: z.number().int().nonnegative(),
  awayScore: z.number().int().nonnegative(),
  period: z.number().int().positive().optional(),
  clock: z.string().optional(),
  kickoffAt: z.number().optional(),
});

const WireCardPlaySchema = z.object({
  text: z.string().min(1, "play text is required"),
  yards: z.number().finite().optional(),
  tdCountToday: z.number().int().nonnegative().optional(),
  scoreValue: z.number().int().nonnegative().optional(),
});

const WireCardLineSchema = z.object({
  rushYds: z.number().finite().optional(),
  recYds: z.number().finite().optional(),
  passYds: z.number().finite().optional(),
  td: z.number().int().nonnegative().optional(),
  fantasyPoints: z.number().finite().optional(),
});

// trending_board: the nightly Sleeper "most added" ranking (spec update 2026-09-06).
const WireCardBoardEntrySchema = z.object({
  espnId: z.string().min(1, "espnId is required"),
  name: z.string().min(1, "name is required"),
  position: z.string().optional(),
  nflTeam: z.string().optional(),
  percentOwned: z.number().min(0).max(100).optional(),
  trendingAdds: z.number().int().nonnegative(),
});

// trending: the wire event (if any) a spike plausibly answers, from another source.
const WireCardRelatedSchema = z.object({
  kind: z.enum(GLOBAL_EVENT_KINDS),
  players: z.array(z.string()),
  nflTeam: z.string().optional(),
  statusTo: z.string().optional(),
  headline: z.string().optional(),
  timetable: z.string().optional(),
  observedAt: z.number(),
  source: z.enum(SOURCE_TYPES),
});

/**
 * Mirrors {@link WireFactCard}. Unknown keys are dropped, never rejected. `related`/`trendingPrevAdds`
 * are only meaningful on a `trending` card but are never rejected on another kind - they simply go
 * unused (a detector building a card generically must not have to strip them per kind).
 */
export const WireFactCardSchema = z
  .object({
    kind: z.enum(GLOBAL_EVENT_KINDS),
    observedAt: z.number(),
    players: z.array(WireCardPlayerSchema).min(1, "a card needs at least one player"),
    nflTeam: z.string().optional(),
    statusFrom: z.string().optional(),
    statusTo: z.string().optional(),
    note: z.string().max(MAX_NOTE_CHARS, `note must be at most ${MAX_NOTE_CHARS} characters`).optional(),
    headline: z.string().optional(),
    timetable: z.string().optional(),
    depthOrderFrom: z.number().int().optional(),
    depthOrderTo: z.number().int().optional(),
    depthPosition: z.string().optional(),
    trendingAdds: z.number().int().nonnegative().optional(),
    trendingPrevAdds: z.number().int().nonnegative().optional(),
    related: WireCardRelatedSchema.optional(),
    board: z.array(WireCardBoardEntrySchema).min(1).max(TRENDING_BOARD_SIZE).optional(),
    ownershipChange: z.number().finite().optional(),
    game: WireCardGameSchema.optional(),
    play: WireCardPlaySchema.optional(),
    line: WireCardLineSchema.optional(),
    source: WireSourceRefSchema,
  })
  .superRefine((card, ctx) => {
    // trending_board is a ranking, not a single-player story - it needs the board itself, and
    // `players` (what the rest of the pipeline, e.g. cardNames/interest, reads) must mirror it.
    if (card.kind !== "trending_board") return;
    if (!card.board || card.board.length < 1 || card.board.length > TRENDING_BOARD_SIZE) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["board"],
        message: `trending_board needs 1-${TRENDING_BOARD_SIZE} board entries`,
      });
      return;
    }
    if (card.players.length !== card.board.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["players"],
        message: "trending_board's players must mirror its board entries",
      });
    }
  });

/** Parses an unknown value as a fact card; throws an Error whose message names every bad field. */
export function validateFactCard(input: unknown): WireFactCard {
  const result = WireFactCardSchema.safeParse(input);
  if (!result.success) {
    const detail = result.error.issues
      .map(issue => `${issue.path.length > 0 ? issue.path.join(".") : "card"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid wire fact card — ${detail}`);
  }
  return result.data;
}

/* ------------------------------------------------------------------------------------------- *
 * Source attribution
 * ------------------------------------------------------------------------------------------- */

/** What the reader is told the item came from. Never a reporter, never an outlet from the note. */
export function sourceLabel(type: WireSourceType): string {
  if (type.startsWith("espn")) return "ESPN";
  if (type === "sleeper") return "Sleeper";
  if (type === "nflverse") return "nflverse";
  return "FFSN";
}

/**
 * ESPN's notes end with a reporter credit — ", Darren Urban of the team's official site reports."
 * — which the Wire never repeats (the source chip says ESPN; the byline is not ours to relay).
 * Trailing credits are removed and the sentence re-terminated; a credit buried mid-sentence is left
 * alone rather than mangled.
 */
const REPORTER_TAIL_PATTERNS: ReadonlyArray<RegExp> = [
  // The comma may sit inside a closing quote — `is "progressing," Howard Balzer of Cards Wire reports.` —
  // so the quote is captured and kept.
  /,(["”’]?)\s*(?:[A-Z][\w.'’-]*\s+){1,4}of\s+[^,]*?\s+(?:reports|reported|relays|relayed|writes|wrote|tweets|tweeted|notes|noted|confirms|confirmed)(?:\s+(?:on\s+)?(?:Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day)?\.?\s*$/,
  /,(["”’]?)\s*(?:per|according to)\s+[A-Z][^,.]*\.?\s*$/,
  /()\s*\(via [^)]*\)\.?\s*$/,
];

export function stripReporterAttribution(text: string): string {
  let out = text.trim();
  for (const pattern of REPORTER_TAIL_PATTERNS) out = out.replace(pattern, (_match, quote: string) => quote);
  out = out.trim();
  if (out.length === 0) return out;
  const closingQuote = out.match(/["”’]$/);
  if (closingQuote) {
    const body = out.slice(0, -1).replace(/,$/, "");
    out = /[.!?]$/.test(body) ? `${body}${closingQuote[0]}` : `${body}.${closingQuote[0]}`;
  } else if (out.endsWith(",")) {
    out = `${out.slice(0, -1)}.`;
  } else if (!/[.!?)]$/.test(out)) {
    out = `${out}.`;
  }
  return out;
}

/* ------------------------------------------------------------------------------------------- *
 * Rendering (the no-model fallback)
 * ------------------------------------------------------------------------------------------- */

const ELLIPSIS = "…";

/** "1240" → "1,240". Hand-rolled so the output does not depend on the runtime's ICU data. */
export function formatCount(value: number): string {
  const rounded = Math.round(value);
  return String(Math.abs(rounded)).replace(/\B(?=(\d{3})+(?!\d))/g, ",").replace(/^/, rounded < 0 ? "-" : "");
}

function clampText(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= MAX_POST_CHARS) return collapsed;
  return `${collapsed.slice(0, MAX_POST_CHARS - 1).trimEnd()}${ELLIPSIS}`;
}

/** `prefix` + a quoted `quote` (+ `suffix`), with the quote cut on a word to fit MAX_POST_CHARS. */
function withQuote(prefix: string, quote: string, suffix = ""): string {
  const clean = quote.replace(/\s+/g, " ").trim();
  const frame = prefix.length + 2 + suffix.length;
  if (frame + clean.length <= MAX_POST_CHARS) return `${prefix}"${clean}"${suffix}`;
  const room = MAX_POST_CHARS - frame - ELLIPSIS.length;
  if (room <= 0) return clampText(prefix);
  let cut = clean.slice(0, room);
  const lastSpace = cut.lastIndexOf(" ");
  if (lastSpace > room * 0.6) cut = cut.slice(0, lastSpace);
  return `${prefix}"${cut.trimEnd()}${ELLIPSIS}"${suffix}`;
}

/**
 * `prefix` + `body` (+ `suffix`), with the body cut on a word and ellipsised so the whole line fits
 * MAX_POST_CHARS. The frame (prefix and suffix) is never cut: it carries the score and the clock.
 */
function withBody(prefix: string, body: string, suffix = ""): string {
  const clean = body.replace(/\s+/g, " ").trim();
  const frame = prefix.length + suffix.length;
  if (frame + clean.length <= MAX_POST_CHARS) return `${prefix}${clean}${suffix}`;
  const room = MAX_POST_CHARS - frame - ELLIPSIS.length;
  if (room <= 0) return clampText(`${prefix}${suffix}`);
  let cut = clean.slice(0, room);
  const lastSpace = cut.lastIndexOf(" ");
  if (lastSpace > room * 0.6) cut = cut.slice(0, lastSpace);
  return `${prefix}${cut.trimEnd()}${ELLIPSIS}${suffix}`;
}

/** A fantasy-point or yardage figure as the reader sees it: "112", "3.4" (one decimal when not whole). */
export function formatPoints(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/** "Joe Burrow (CIN · QB)", degrading gracefully when team or position is unknown. */
export function playerTag(card: WireFactCard, index = 0): string {
  const player = card.players[index] ?? card.players[0];
  const team = player.nflTeam ?? card.nflTeam;
  const parts = [team, player.position].filter((part): part is string => typeof part === "string" && part.length > 0);
  return parts.length > 0 ? `${player.name} (${parts.join(" · ")})` : player.name;
}

function playerNames(card: WireFactCard): string {
  return card.players.map(player => player.name).join(", ");
}

/** ownership_swing: "dropped" for a negative ESPN percentChange, "added" for a positive one. */
export function ownershipSwingDirection(change: number): "dropped" | "added" {
  return change < 0 ? "dropped" : "added";
}

/** ownership_swing: |change| as the reader sees it - "12%", or "0.5%" under a point. */
export function ownershipSwingPercent(change: number): string {
  const abs = Math.abs(change);
  const rounded = Math.round(abs);
  return rounded >= 1 ? `${rounded}%` : `${abs.toFixed(1)}%`;
}

/** "Joe Burrow", "Joe Burrow and Ja'Marr Chase", "A, B and C" — a plain English name list. */
function andJoin(names: ReadonlyArray<string>): string {
  if (names.length === 0) return "";
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * trending only: one context sentence explaining a spike, attributed to the RELATED event's own
 * source (never Sleeper's, since the related fact came from somewhere else) - `undefined` when the
 * related event does not carry what its own sentence needs (a status, a headline, a team).
 */
function relatedContext(related: WireCardRelated): string | undefined {
  const names = andJoin(related.players);
  if (!names) return undefined;
  const label = sourceLabel(related.source);
  switch (related.kind) {
    case "injury_status": {
      const status = related.statusTo?.trim();
      return status ? `after ${label} listed ${names} ${status}.` : undefined;
    }
    case "injury_note":
      return related.timetable
        ? `after ${label} put ${names} at ${related.timetable}.`
        : `after an ${label} note on ${names}.`;
    case "news": {
      const headline = related.headline?.trim();
      return headline ? `after ${label}'s "${headline}".` : undefined;
    }
    case "depth_chart":
      return related.nflTeam ? `after ${names} moved up the ${related.nflTeam} depth chart on ${label}.` : undefined;
    default:
      return undefined;
  }
}

const KIND_LABELS: Partial<Record<WireFactCard["kind"], string>> = {
  game_started: "kickoff",
  game_final: "final",
  scoring_play: "scoring play",
  big_line: "big line",
  bust_watch: "bust watch",
  weather: "weather",
};

/* ------------------------------------------------------------------------------------------- *
 * Live game engine (spec §19): the pieces the five live kinds render from
 * ------------------------------------------------------------------------------------------- */

/** "KC 10, CIN 14" — away first, as a scoreboard reads. */
function scoreLine(game: NonNullable<WireFactCard["game"]>): string {
  return `${game.away} ${game.awayScore}, ${game.home} ${game.homeScore}`;
}

/** "Q2 4:12", "Q3", or "" when the card carries no period. */
function clockLine(game: NonNullable<WireFactCard["game"]>): string {
  if (typeof game.period !== "number") return "";
  const clock = game.clock?.trim();
  return clock ? `Q${game.period} ${clock}` : `Q${game.period}`;
}

/** "Ja'Marr Chase (CIN)" — the scoring player with his NFL team, or the bare name. */
function playerWithTeam(card: WireFactCard): string {
  const player = card.players[0];
  const team = player.nflTeam ?? card.nflTeam;
  return team ? `${player.name} (${team})` : player.name;
}

/** Whether ESPN's play text already names the scoring player, so the card need not repeat him. */
function playTextNamesPlayer(text: string, name: string): boolean {
  const needle = name.trim().toLowerCase();
  return needle.length > 0 && text.toLowerCase().includes(needle);
}

/** "112 rushing yards, 3 TD" — only the metrics that crossed a big_line threshold (spec §19.1). */
export function bigLineMetrics(line: WireCardLine | undefined): string[] {
  if (!line) return [];
  const out: string[] = [];
  if (typeof line.rushYds === "number" && line.rushYds >= BIG_LINE_RUSH_REC_YARDS) out.push(`${formatPoints(line.rushYds)} rushing yards`);
  if (typeof line.recYds === "number" && line.recYds >= BIG_LINE_RUSH_REC_YARDS) out.push(`${formatPoints(line.recYds)} receiving yards`);
  if (typeof line.passYds === "number" && line.passYds >= BIG_LINE_PASS_YARDS) out.push(`${formatPoints(line.passYds)} passing yards`);
  if (typeof line.td === "number" && line.td >= BIG_LINE_TD) out.push(`${line.td} TD`);
  return out;
}

/**
 * The five live kinds (spec §19), rendered from their structured fields. No source label in the
 * line — the chip says ESPN — and nothing attributed to a reporter. `undefined` when the card lacks
 * the fields the kind needs, so the caller can fall back to the generic line.
 */
function renderLiveCard(card: WireFactCard): { text: string; tags: WireTag[] } | undefined {
  const game = card.game;
  switch (card.kind) {
    case "game_started": {
      if (!game) return undefined;
      return { text: clampText(`Kickoff: ${game.away} at ${game.home}. Let's go to the board.`), tags: ["LIVE"] };
    }
    case "game_final": {
      if (!game) return undefined;
      return { text: clampText(`Final: ${game.home} ${game.homeScore}, ${game.away} ${game.awayScore}.`), tags: ["FINAL"] };
    }
    case "scoring_play": {
      const play = card.play;
      if (!play) return undefined;
      const player = card.players[0];
      // ESPN's play text carries no reporter credit; stripping is the same defence every card gets.
      const playText = stripReporterAttribution(play.text).replace(/[.\s]+$/, "");
      const prefix = playTextNamesPlayer(playText, player.name) ? "" : `${playerWithTeam(card)}: `;
      const situation = game ? [scoreLine(game), clockLine(game)].filter(part => part.length > 0).join(", ") : "";
      const suffix = situation ? ` — ${situation}.` : ".";
      return { text: withBody(prefix, playText, suffix), tags: ["LIVE"] };
    }
    case "big_line": {
      const metrics = bigLineMetrics(card.line);
      if (metrics.length === 0) return undefined;
      return { text: clampText(`${playerTag(card)}: ${metrics.join(", ")} and counting.`), tags: ["LIVE"] };
    }
    case "bust_watch": {
      const player = card.players[0];
      const rank =
        typeof player.adpPositionRank === "number" ? ` (ADP ${player.position ?? ""}${player.adpPositionRank})` : "";
      const points = card.line?.fantasyPoints;
      const finish =
        typeof points === "number" && Number.isFinite(points)
          ? `finished with ${formatPoints(points)} fantasy points`
          : `finished under ${BUST_WATCH_MAX_POINTS} fantasy points`;
      return { text: clampText(`${player.name}${rank} ${finish}.`), tags: ["FINAL"] };
    }
    default:
      return undefined;
  }
}

/**
 * The plain wire line for a card, deterministic per kind, ≤ MAX_POST_CHARS. This is what the reader
 * sees when the card posts without a take (below the interest bar, or a take that failed verify),
 * so it reads like a ticker line rather than a dump of fields.
 */
export function renderCard(card: WireFactCard): { text: string; tags: WireTag[] } {
  const label = sourceLabel(card.source.type);
  const note = card.note ? stripReporterAttribution(card.note) : "";
  const who = playerTag(card);

  switch (card.kind) {
    case "injury_status": {
      const to = card.statusTo?.trim() || "status update";
      const from = card.statusFrom?.trim();
      const head = `${who}: ${from && from !== to ? `${from} → ${to}` : to}.`;
      const text = note ? withQuote(`${head} ${label}: `, note) : head;
      return { text: clampText(text), tags: ["REPORTED"] };
    }
    case "injury_note": {
      if (note) return { text: clampText(withQuote(`${who} — ${label}: `, note)), tags: ["REPORTED"] };
      const head = card.timetable ? `${who}: timetable ${card.timetable} (${label}).` : `${who}: new note (${label}).`;
      return { text: clampText(head), tags: ["REPORTED"] };
    }
    case "news": {
      const headline = card.headline?.trim();
      if (headline) return { text: clampText(`${headline} (${label})`), tags: ["REPORTED"] };
      if (note) return { text: clampText(withQuote(`${playerNames(card)} — ${label}: `, note)), tags: ["REPORTED"] };
      return { text: clampText(`${playerNames(card)}: ${label} news.`), tags: ["REPORTED"] };
    }
    case "depth_chart": {
      const player = card.players[0];
      const position = card.depthPosition ?? player.position ?? "";
      const team = player.nflTeam ?? card.nflTeam;
      const to = card.depthOrderTo !== undefined ? `${position}${card.depthOrderTo}` : "";
      const from = card.depthOrderFrom !== undefined ? `${position}${card.depthOrderFrom}` : "";
      const move = to && from ? `moves from ${from} to ${to}` : to ? `moves to ${to}` : "moves";
      const chart = team ? `the ${team} depth chart` : "the depth chart";
      return { text: clampText(`${player.name} ${move} on ${chart} (${label}).`), tags: ["REPORTED"] };
    }
    case "trending": {
      const player = card.players[0];
      const base =
        card.trendingAdds !== undefined
          ? `${player.name} added in ${formatCount(card.trendingAdds)} ${label} leagues in the last 24 h.`
          : `${player.name} is trending on ${label}.`;
      const context = card.related ? relatedContext(card.related) : undefined;
      // "…in the last 24 h, after ESPN listed X Out." - one sentence, so the context reads as the why.
      return { text: clampText(context ? `${base.replace(/\.$/, ",")} ${context}` : base), tags: ["REPORTED"] };
    }
    case "trending_board": {
      const board = card.board ?? [];
      const withPositions = board
        .map(entry => `${entry.name}${entry.position ? ` (${entry.position})` : ""} ${formatCount(entry.trendingAdds)}`)
        .join(" · ");
      const full = `Most added on ${label}, last 24 h: ${withPositions}`;
      if (full.length <= MAX_POST_CHARS) return { text: full, tags: ["REPORTED"] };
      // Drop the "(POS)" parts before falling back to a mid-word ellipsis - the ranking still reads
      // fine without positions, and every name deserves a chance to appear.
      const withoutPositions = board.map(entry => `${entry.name} ${formatCount(entry.trendingAdds)}`).join(" · ");
      return { text: clampText(`Most added on ${label}, last 24 h: ${withoutPositions}`), tags: ["REPORTED"] };
    }
    case "ownership_swing": {
      const player = card.players[0];
      const change = card.ownershipChange;
      const text =
        typeof change === "number" && Number.isFinite(change) && change !== 0
          ? `${player.name} was ${ownershipSwingDirection(change)} in ${ownershipSwingPercent(change)} of ${label} leagues overnight.`
          : `${player.name}: ${label} roster percentage moved overnight.`;
      return { text: clampText(text), tags: ["REPORTED"] };
    }
    default: {
      // Live kinds render from their structured fields; a live card without them (an early
      // detector, a hand-built card) falls through to the generic line below.
      const live = renderLiveCard(card);
      if (live) return live;
      const body = card.headline?.trim() || note || KIND_LABELS[card.kind] || card.kind.replace(/_/g, " ");
      const tags: WireTag[] = card.kind === "game_final" ? ["FINAL"] : card.kind === "game_started" ? ["LIVE"] : ["REPORTED"];
      return { text: clampText(`${playerNames(card)}: ${body} (${label})`), tags };
    }
  }
}

/* ------------------------------------------------------------------------------------------- *
 * What a take may say
 * ------------------------------------------------------------------------------------------- */

/**
 * A number as it appears in prose: "$31", "1,240", "142.8", "6-8" / "6–8". Never a digit glued to a
 * letter ("RB1", "3rd", "TJ2"), so positional slots and ordinals are not treated as figures.
 */
export const NUMBER_PATTERN =
  /(?<![A-Za-z0-9])\$?\d+(?:,\d{3})*(?:\.\d+)?(?:\s?[-–]\s?\d+(?:,\d{3})*(?:\.\d+)?)?(?![A-Za-z0-9])/g;

/** "$1,240" → "1240", "6–8" → "6-8". Both sides of a range are also returned on their own. */
export function normaliseNumber(raw: string): string[] {
  const base = raw.replace(/[$,]/g, "").replace(/\s*[-–]\s*/g, "-").trim();
  const out = new Set<string>([base]);
  if (base.includes("-")) for (const side of base.split("-")) if (side) out.add(side);
  return [...out];
}

/** Every number in `text`, normalised. */
export function extractNumbers(text: string | undefined): string[] {
  if (!text) return [];
  const out = new Set<string>();
  for (const match of text.matchAll(NUMBER_PATTERN)) for (const value of normaliseNumber(match[0])) out.add(value);
  return [...out];
}

/**
 * Multi-word capitalised runs — the shape the article verifier treats as a proper noun, widened so
 * an internal capital ("LaFleur", "McBride", "Ja'Marr") keeps the name whole. Every word must carry
 * a lowercase letter, so an all-caps tag ("REPORTED") never starts or joins a name.
 */
export function properNouns(text: string | undefined): string[] {
  if (!text) return [];
  const matches = text.match(/\b[A-Z][a-z][A-Za-z'’]*(?:\s+[A-Z][A-Za-z'’]*[a-z][A-Za-z'’]*)+/g) ?? [];
  return [...new Set(matches)];
}

function addNumber(sink: Set<string>, value: number | undefined): void {
  if (typeof value !== "number" || !Number.isFinite(value)) return;
  sink.add(String(value));
  if (!Number.isInteger(value)) {
    sink.add(String(Math.round(value)));
    sink.add(value.toFixed(1));
  } else {
    sink.add(formatCount(value).replace(/,/g, ""));
  }
}

/** The numbers a take about this card may state, normalised the way {@link extractNumbers} does. */
export function cardNumbers(card: WireFactCard): string[] {
  const out = new Set<string>();
  for (const value of extractNumbers(card.timetable)) out.add(value);
  for (const value of extractNumbers(card.note)) out.add(value);
  for (const value of extractNumbers(card.headline)) out.add(value);
  addNumber(out, card.trendingAdds);
  addNumber(out, card.trendingPrevAdds);
  if (typeof card.ownershipChange === "number") addNumber(out, Math.abs(card.ownershipChange));
  addNumber(out, card.depthOrderFrom);
  addNumber(out, card.depthOrderTo);
  for (const player of card.players) {
    addNumber(out, player.percentOwned);
    addNumber(out, player.adpPositionRank);
  }
  // The trending / trending_board window is part of the fact ("in the last 24 hours").
  if (card.kind === "trending" || card.kind === "trending_board") out.add("24");
  // trending_board: every rank's own add count and roster share.
  for (const entry of card.board ?? []) {
    addNumber(out, entry.trendingAdds);
    addNumber(out, entry.percentOwned);
  }
  // trending: the related event's own figures (a timetable, a number inside its headline).
  if (card.related) {
    for (const value of extractNumbers(card.related.timetable)) out.add(value);
    for (const value of extractNumbers(card.related.headline)) out.add(value);
  }
  // Live game engine (spec §19): every figure the live line renders — scores, the period, the
  // clock's two halves, the play's yards and TD count, the box-score line.
  if (card.game) {
    addNumber(out, card.game.homeScore);
    addNumber(out, card.game.awayScore);
    addNumber(out, card.game.period);
    for (const value of extractNumbers(card.game.clock)) out.add(value);
  }
  if (card.play) {
    for (const value of extractNumbers(card.play.text)) out.add(value);
    addNumber(out, card.play.yards);
    addNumber(out, card.play.tdCountToday);
    addNumber(out, card.play.scoreValue);
  }
  if (card.line) {
    addNumber(out, card.line.rushYds);
    addNumber(out, card.line.recYds);
    addNumber(out, card.line.passYds);
    addNumber(out, card.line.td);
    addNumber(out, card.line.fantasyPoints);
  }
  if (card.kind === "bust_watch") addNumber(out, BUST_WATCH_MAX_POINTS);
  return [...out];
}

/** The proper nouns a take about this card may use: players, teams, statuses, and names in the note. */
export function cardNames(card: WireFactCard): string[] {
  const out = new Set<string>();
  for (const player of card.players) {
    out.add(player.name);
    if (player.nflTeam) out.add(player.nflTeam);
  }
  if (card.nflTeam) out.add(card.nflTeam);
  for (const status of [card.statusFrom, card.statusTo, card.depthPosition]) if (status) out.add(status);
  // The reporter credit is stripped first so the reporter's name is never an allowed name.
  for (const noun of properNouns(card.note ? stripReporterAttribution(card.note) : undefined)) out.add(noun);
  for (const noun of properNouns(card.headline)) out.add(noun);
  // Live game engine (spec §19): both teams on the scoreboard, and the people ESPN's play text
  // names (the passer, the kicker) so a take may credit the throw.
  if (card.game) {
    out.add(card.game.home);
    out.add(card.game.away);
  }
  for (const noun of properNouns(card.play ? stripReporterAttribution(card.play.text) : undefined)) out.add(noun);
  // trending_board: every ranked player and team.
  for (const entry of card.board ?? []) {
    out.add(entry.name);
    if (entry.nflTeam) out.add(entry.nflTeam);
  }
  // trending: the related event's own players/team/status and the proper nouns in its headline.
  if (card.related) {
    for (const name of card.related.players) out.add(name);
    if (card.related.nflTeam) out.add(card.related.nflTeam);
    if (card.related.statusTo) out.add(card.related.statusTo);
    for (const noun of properNouns(card.related.headline)) out.add(noun);
  }
  out.add(sourceLabel(card.source.type));
  return [...out];
}
