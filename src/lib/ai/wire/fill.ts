// The Wire — slot filling (spec §3.2). Pure; imported by the Convex default runtime.
//
// A variant is a template with `{token}` slots. A sentence whose tokens do not all resolve is
// dropped; if nothing is left the variant is skipped. Never a blank, never a raw token.

import { ownershipSwingDirection, ownershipSwingPercent } from "./card";
import { MAX_POST_CHARS, SLOT_TOKENS, type OverlayVariant, type SlotToken, type WireFactCard, type WireSlots } from "./types";

const TOKEN_PATTERN = /\{([A-Za-z]+)\}/g;
const SLOT_TOKEN_SET: ReadonlySet<string> = new Set(SLOT_TOKENS);

/** Unique `{token}` names in a template, in order of first appearance (unknown ones included). */
export function templateTokens(template: string): string[] {
  const out: string[] = [];
  for (const match of template.matchAll(TOKEN_PATTERN)) if (!out.includes(match[1])) out.push(match[1]);
  return out;
}

export function isSlotToken(token: string): token is SlotToken {
  return SLOT_TOKEN_SET.has(token);
}

/** Sentence boundaries: ". ", "! ", "? " (closing quotes and parens allowed before the space). */
export function splitTemplateSentences(template: string): string[] {
  return template
    .split(/(?<=[.!?]["”’)]*)\s+/)
    .map(sentence => sentence.trim())
    .filter(sentence => sentence.length > 0);
}

function hasValue(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export type FillResult =
  | { ok: true; text: string; dropped?: string[] }
  | { ok: false; unresolved: string[] };

/**
 * Fills `template` from `slots`. An unknown token (not in SLOT_TOKENS) fails the whole template; a
 * sentence with an unresolved known token is dropped; nothing left → `ok: false` with the tokens
 * that were missing. The result is collapsed to single spaces and kept ≤ MAX_POST_CHARS by dropping
 * trailing sentences (a lone over-long sentence is cut with an ellipsis).
 */
export function fillVariant(template: string, slots: WireSlots): FillResult {
  const tokens = templateTokens(template);
  const unknown = tokens.filter(token => !isSlotToken(token));
  if (unknown.length > 0) return { ok: false, unresolved: unknown };

  const kept: string[] = [];
  const unresolved: string[] = [];
  for (const sentence of splitTemplateSentences(template)) {
    const missing = templateTokens(sentence).filter(token => !isSlotToken(token) || !hasValue(slots[token]));
    if (missing.length > 0) {
      for (const token of missing) if (!unresolved.includes(token)) unresolved.push(token);
      continue;
    }
    kept.push(sentence.replace(TOKEN_PATTERN, (_match, token: string) => (slots[token as SlotToken] ?? "").trim()));
  }
  if (kept.length === 0) return { ok: false, unresolved };

  let text = "";
  for (const sentence of kept) {
    const next = text.length > 0 ? `${text} ${sentence}` : sentence;
    if (next.length > MAX_POST_CHARS) break;
    text = next;
  }
  if (text.length === 0) text = `${kept[0].slice(0, MAX_POST_CHARS - 1).trimEnd()}…`;
  text = text.replace(/\s{2,}/g, " ").trim();
  return unresolved.length > 0 ? { ok: true, text, dropped: unresolved } : { ok: true, text };
}

/* ------------------------------------------------------------------------------------------- *
 * Default variants — plain, clean templates per kind, used when the take carries none
 * ------------------------------------------------------------------------------------------- */

const FREE_AGENT_BACKUP = "{backup} is the add if he is on your wire. {trendingAdds} Sleeper leagues grabbed him in the last day.";
const TRENDING_TAIL = "{trendingAdds} Sleeper leagues grabbed him in the last day.";
const WAIVER_TAIL = "{faab} FAAB left. {bestFA} is the best {pos} on waivers.";

function statusTier(card: WireFactCard): "return" | "designation" | "out" {
  const to = (card.statusTo ?? "").trim().toLowerCase();
  if (to === "active") return "return";
  if (to === "questionable" || to === "doubtful") return "designation";
  return "out";
}

/**
 * How a timetable phrase reads in a sentence, so the template around `{timetable}` scans:
 *   duration     "6-8 weeks", "3 weeks", "multiple weeks"   → "for {timetable}"
 *   duration_the "rest of the season"                         → "for the {timetable}"
 *   season       "season-ending", "out for the year/season"   → ": {timetable}"
 *   designation  "week-to-week", "day-to-day"                 → "is {timetable}"
 *   open         "indefinitely"                               → "out {timetable}"
 */
export type TimetableShape = "duration" | "duration_the" | "season" | "designation" | "open";

export function timetableShape(timetable: string): TimetableShape {
  const lower = timetable.toLowerCase();
  if (/\b(?:rest|remainder) of the season\b/.test(lower)) return "duration_the";
  if (/\bseason[- ]ending\b|\bout for the (?:year|season)\b/.test(lower)) return "season";
  if (/\bweek[- ]to[- ]week\b|\bday[- ]to[- ]day\b/.test(lower)) return "designation";
  if (/\bindefinitely\b/.test(lower)) return "open";
  return "duration";
}

function injuryStatusOwnerLead(card: WireFactCard): string {
  if (!card.timetable) return "{team} loses {player}: {status}.";
  switch (timetableShape(card.timetable)) {
    case "duration":
      return "{team} loses {player} for {timetable}.";
    case "duration_the":
      return "{team} loses {player} for the {timetable}.";
    case "season":
      return "{team} loses {player}: {timetable}.";
    case "designation":
      return "{team} loses {player}: {status}, {timetable}.";
    case "open":
      return "{team} loses {player} {timetable}.";
  }
}

function injuryNoteLeads(card: WireFactCard): { owner: string; opponent: string } {
  if (!card.timetable) {
    return { owner: "{team}: new word on {player} from ESPN.", opponent: "{team} draws {ownerTeam} this week. Keep an eye on {player}." };
  }
  switch (timetableShape(card.timetable)) {
    case "duration":
      return { owner: "{team} is looking at {timetable} without {player}.", opponent: "{team} draws {ownerTeam} with {player} looking at {timetable}." };
    case "duration_the":
      return { owner: "{team} is looking at the {timetable} without {player}.", opponent: "{team} draws {ownerTeam} with {player} looking at the {timetable}." };
    case "season":
      return { owner: "{team}: {timetable} for {player}, per ESPN.", opponent: "{team} draws {ownerTeam} without {player} ({timetable})." };
    case "designation":
      return { owner: "{team}: {player} is {timetable}, per ESPN.", opponent: "{team} draws {ownerTeam} with {player} {timetable}." };
    case "open":
      return { owner: "{team}: {player} is out {timetable}, per ESPN.", opponent: "{team} draws {ownerTeam} with {player} out {timetable}." };
  }
}

/**
 * The templates the overlay uses when a take supplied no variant of its own. Every sentence
 * carries only the slots it needs, so a league without FAAB simply loses the FAAB sentence and a
 * card without a position keeps its lead. Lead sentences never depend on `{pos}` for that reason.
 */
/**
 * The pre-draft keeper-league note for an unrostered player (spec §3.2): the player is on the draft
 * board, not the waiver wire. Sentence 2 drops when the league has no FFC ADP for him.
 */
function draftBoardTemplate(card: WireFactCard): string {
  switch (card.kind) {
    case "injury_status":
    case "injury_note":
      return "{player} ({pos}) is still on the board in this league. ADP {adp}, {adpRank} before this. Draft accordingly.";
    case "depth_chart":
      return "{player} is still on the board here and just moved up the {nflTeam} depth chart. ADP {adp}, {adpRank} before this.";
    case "trending":
      return "{player} is still on the board here. {trendingAdds} Sleeper leagues added him in the last day. ADP {adp}, {adpRank}.";
    case "ownership_swing":
      return "{player} ({pos}) is still on the board here and was {direction} in {pct} of ESPN leagues overnight. ADP {adp}, {adpRank}.";
    default:
      return "{player} ({pos}) is still on the board in this league. ADP {adp}, {adpRank}.";
  }
}

export function defaultVariants(card: WireFactCard): Record<OverlayVariant, string> {
  return { ...baseVariants(card), draftBoard: draftBoardTemplate(card) };
}

/**
 * The two slots an ownership_swing overlay needs (spec §18): `{pct}` ("12%") and `{direction}`
 * ("dropped" | "added") from the card's signed ESPN percentChange. Empty when the card has none, so
 * every sentence that mentions the swing drops cleanly.
 */
export function ownershipSwingSlots(card: WireFactCard): Pick<WireSlots, "pct" | "direction"> {
  const change = card.ownershipChange;
  if (typeof change !== "number" || !Number.isFinite(change) || change === 0) return {};
  return { pct: ownershipSwingPercent(change), direction: ownershipSwingDirection(change) };
}

function baseVariants(card: WireFactCard): Record<Exclude<OverlayVariant, "draftBoard">, string> {
  switch (card.kind) {
    case "injury_status": {
      const tier = statusTier(card);
      const landsOn = (card.statusTo ?? "").trim().toLowerCase() === "injured reserve";
      if (tier === "return") {
        return {
          owner: "{team} gets {player} back: {status}.",
          opponent: "{team} draws {ownerTeam} the week {player} comes back.",
          freeAgent: `{player} is back to {status} and unrostered here. ${TRENDING_TAIL}`,
        };
      }
      if (tier === "designation") {
        return {
          owner: "{team} has {player} listed {status}. {bestFA} is the best {pos} on waivers if it goes the wrong way. {faab} FAAB left.",
          opponent: "{team} draws {ownerTeam} the week {player} goes {status}.",
          freeAgent: `{backup} is the add if he is on your wire and {player} sits. ${TRENDING_TAIL}`,
        };
      }
      return {
        owner: `${injuryStatusOwnerLead(card)} ${WAIVER_TAIL}`,
        opponent: landsOn
          ? "{team} draws {ownerTeam} the week {player} lands on {status}."
          : "{team} draws {ownerTeam} the week {player} goes {status}.",
        freeAgent: FREE_AGENT_BACKUP,
      };
    }
    case "injury_note": {
      const leads = injuryNoteLeads(card);
      return {
        owner: card.timetable ? `${leads.owner} ${WAIVER_TAIL}` : leads.owner,
        opponent: leads.opponent,
        freeAgent: `{backup} is the add if he is on your wire and {player} misses time. ${TRENDING_TAIL}`,
      };
    }
    case "news":
      return {
        owner: "{team} rosters {player}, so this one lands on your side of the league.",
        opponent: "{team} draws {ownerTeam} this week, and {player} is on that roster.",
        freeAgent: `{player} is on your wire in this league. ${TRENDING_TAIL}`,
      };
    case "depth_chart":
      return {
        owner: "{team} rosters {player}, and he just moved up the {nflTeam} depth chart.",
        opponent: "{team} draws {ownerTeam} the week {player} moves up the {nflTeam} depth chart.",
        freeAgent: `{player} just moved up the {nflTeam} depth chart and he is on your wire. ${TRENDING_TAIL}`,
      };
    case "trending":
      return {
        owner: "{team} already rosters {player}. {trendingAdds} Sleeper leagues just added him.",
        opponent: "{team} draws {ownerTeam} this week, and they roster {player}, who {trendingAdds} Sleeper leagues just added.",
        freeAgent: "{player} is on your wire. {trendingAdds} Sleeper leagues added him in the last day. {faab} FAAB left.",
      };
    case "ownership_swing":
      return {
        owner: "{team} rosters {player}, who was {direction} in {pct} of ESPN leagues overnight.",
        opponent: "{team} draws {ownerTeam} this week, and they roster {player}, who was {direction} in {pct} of ESPN leagues overnight.",
        freeAgent: "{player} is on your wire in this league and was {direction} in {pct} of ESPN leagues overnight. {faab} FAAB left.",
      };
    default:
      return {
        owner: "{team} rosters {player} ({pos}).",
        opponent: "{team} draws {ownerTeam}, who roster {player} ({pos}).",
        freeAgent: "{player} ({pos}) is on your wire in this league.",
      };
  }
}
