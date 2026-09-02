/**
 * Display helpers that turn stored identifiers (content type keys, persona
 * slugs, user names) into the words that appear in an email.
 */

import { contentTemplates } from "../ai/content-templates";
import {
  DEFAULT_PERSONA,
  INTERVIEWER_PERSONA,
  RETIRED_PERSONAS,
  getPersonaDisplay,
  personaPrompts,
} from "../ai/persona-prompts";

export interface EmailPersona {
  name: string;
  role: string;
}

/** "weekly_recap" -> "Weekly Recap", "trade_rumor_mill" -> "The Asking Price". */
export function contentTypeLabel(contentType: string | undefined | null): string {
  if (!contentType) return "story";
  const template = contentTemplates[contentType];
  if (template?.name) return template.name;
  return contentType
    .split("_")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * Name + role for the writer on a byline. Accepts a persona slug (the stored
 * form) or a display name (older articles). Unknown values render as-is with a
 * generic role rather than being misattributed to another writer.
 */
export function writerDisplay(persona: string | undefined | null): EmailPersona {
  if (!persona || !persona.trim()) return getPersonaDisplay(DEFAULT_PERSONA);
  const value = persona.trim();
  if (personaPrompts[value] || RETIRED_PERSONAS[value]) return getPersonaDisplay(value);

  const lower = value.toLowerCase();
  for (const p of Object.values(personaPrompts)) {
    if (p.name.toLowerCase() === lower) return { name: p.name, role: p.role };
  }
  for (const r of Object.values(RETIRED_PERSONAS)) {
    if (r.name.toLowerCase() === lower) return { name: r.name, role: r.role };
  }
  return { name: value, role: "FFSN correspondent" };
}

/** The sideline reporter who conducts every comment request. */
export function interviewerDisplay(): EmailPersona {
  return getPersonaDisplay(INTERVIEWER_PERSONA);
}

/** `Simone "Sam" Ortega` -> "SO", "Mel Diaper" -> "MD", "Walt" -> "WA". */
export function personaInitials(name: string): string {
  const parts = name
    .replace(/["“”'‘’][^"“”'‘’]*["“”'‘’]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return "FF";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** `Simone "Sam" Ortega` -> "Sam Ortega"; "Curtis Vaughn" -> "Curtis Vaughn". */
export function shortName(name: string): string {
  const nick = name.match(/["“”]([^"“”]+)["“”]/);
  const parts = name
    .replace(/["“”'‘’][^"“”'‘’]*["“”'‘’]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (nick && parts.length >= 2) return `${nick[1]} ${parts[parts.length - 1]}`;
  return parts.join(" ") || name;
}

/** First name for a greeting; undefined for blank or placeholder names so the copy can skip it. */
export function firstName(name: string | undefined | null): string | undefined {
  if (!name) return undefined;
  const trimmed = name.trim();
  if (!trimmed || /^(user|unknown( user)?|test user|anonymous)$/i.test(trimmed)) return undefined;
  if (trimmed.includes("@")) return undefined;
  return trimmed.split(/\s+/)[0];
}
