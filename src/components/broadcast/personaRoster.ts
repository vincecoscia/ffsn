// The on-air roster, as the UI needs it.
//
// One source of truth for every persona picker, byline and writer card in the app:
// `src/lib/ai/persona-prompts.ts`. Nothing here re-states a name, role or beat — it
// only reshapes the prompt-layer definitions into display data, so adding or retiring
// a writer there changes every screen at once.

import { contentTemplates } from "@/lib/ai/content-templates";
import {
  DEFAULT_PERSONA,
  contentTypePersonaMap,
  getPersonaDisplay,
  personaPrompts,
} from "@/lib/ai/persona-prompts";

/**
 * True when a content type can actually be generated today — i.e. it has a template
 * behind it (spec §8.5). Derived from `contentTemplates` at runtime rather than a
 * hard-coded list, so a type becomes selectable everywhere the moment its template
 * ships, and stops being offered if one is ever removed.
 */
export function isSelectableContentType(type: string): boolean {
  return Object.prototype.hasOwnProperty.call(contentTemplates, type);
}

/**
 * Content types a writer is mapped to but that have no template (spec §1.5). They stay
 * in `contentTypePersonaMap` so an archived article still resolves a writer, but they
 * are never offered in a picker and never advertised on a writer card. Derived, so this
 * set empties itself as templates land.
 */
export const UNAVAILABLE_CONTENT_TYPES: ReadonlySet<string> = new Set(
  Object.keys(contentTypePersonaMap).filter((type) => !isSelectableContentType(type)),
);

/**
 * Display names for every content type, including the seven added in spec §8.5.
 * `trade_rumor_mill` ("The Asking Price") and `player_glazing` ("The Case For") carry
 * the renamed segments from spec §1.5; everything else reads as its slug, sentence-cased.
 * A type with no entry here falls back to its de-slugged name, so a new template is never
 * shown as a raw slug for long.
 */
export const CONTENT_TYPE_LABELS: Record<string, string> = {
  weekly_recap: "Weekly recap",
  weekly_preview: "Weekly preview",
  power_rankings: "Power rankings",
  waiver_wire_report: "Waiver wire report",
  trade_analysis: "Trade analysis",
  mock_draft: "Mock draft",
  draft_rankings: "Draft rankings & grades",
  draft_strategy_guide: "Draft strategy guide",
  trade_block_tuesday: "Trade block Tuesday",
  trade_rumor_mill: "The Asking Price",
  emergency_hot_takes: "Emergency hot takes",
  rivalry_week_special: "Rivalry week special",
  mid_season_awards: "Mid-season awards",
  playoff_picture: "Playoff picture",
  championship_manifesto: "Championship manifesto",
  season_recap: "Season recap",
  season_welcome: "Season kickoff",
  commissioner_corner: "Commissioner's corner",
  hall_of_shame: "Hall of shame",
  custom_roast: "Custom roast",
  team_name_power_rankings: "Team-name power rankings",
  player_glazing: "The Case For",
};

/** Display name for a content type, falling back to the de-slugged string. */
export function contentTypeLabel(type: string): string {
  return CONTENT_TYPE_LABELS[type] ?? type.replace(/_/g, " ");
}

/** The default writer for a content type (first entry in the map), never a retired slug. */
export function defaultPersonaFor(contentType: string): string {
  const preferred = contentTypePersonaMap[contentType]?.find(
    (slug) => personaPrompts[slug]?.isWriter,
  );
  return preferred ?? DEFAULT_PERSONA;
}

/** The writers a content type should offer, in preference order (default first). */
export function personasForContentType(contentType: string): RosterWriter[] {
  const preferred = contentTypePersonaMap[contentType];
  if (!preferred || preferred.length === 0) return writerRoster;
  const ordered = preferred
    .map((slug) => writerRoster.find((w) => w.slug === slug))
    .filter((w): w is RosterWriter => Boolean(w));
  return ordered.length > 0 ? ordered : writerRoster;
}

export interface RosterWriter {
  slug: string;
  /** Display name, e.g. `Simone "Sam" Ortega`. */
  name: string;
  /** Red role strip, e.g. "Sideline Reporter". */
  role: string;
  tagline: string;
  /** Selectable content types this writer leads on, as display names. */
  beat: string[];
  isInterviewer: boolean;
}

const BEATS_PER_CARD = 3;

function beatsFor(slug: string, isInterviewer: boolean): string[] {
  const leads: string[] = [];
  const supports: string[] = [];
  for (const [type, writers] of Object.entries(contentTypePersonaMap)) {
    if (!isSelectableContentType(type)) continue;
    const rank = writers.indexOf(slug);
    if (rank === 0) leads.push(contentTypeLabel(type));
    else if (rank > 0) supports.push(contentTypeLabel(type));
  }
  const beat = [...leads, ...supports];
  if (isInterviewer) beat.unshift("Sideline interviews");
  return beat.slice(0, BEATS_PER_CARD);
}

/** The selectable writers, in roster order (spec §3). Retired personas are excluded. */
export const writerRoster: RosterWriter[] = Object.values(personaPrompts)
  .filter((persona) => persona.isWriter)
  .map((persona) => ({
    slug: persona.slug,
    name: persona.name,
    role: persona.role,
    tagline: persona.tagline,
    beat: beatsFor(persona.slug, persona.isInterviewer),
    isInterviewer: persona.isInterviewer,
  }));

/** Display name for any byline slug, including retired writers. */
export function personaName(slug: string): string {
  return getPersonaDisplay(slug).name;
}

/** Role strip for any byline slug, including retired writers. */
export function personaRole(slug: string): string {
  return getPersonaDisplay(slug).role;
}
