// The publish gate (spec §11.2.9) and the shapes the editor pass produces (spec §11.2.7).
//
// This module is deliberately tiny and dependency-light: no Anthropic SDK, no Node built-ins, no
// Convex. `convex/aiContent.ts` imports `shouldPublish` from here to decide whether an unattended
// article publishes or stays a draft, so anything heavy here would be bundled into every Convex
// function that touches an article.
//
// `content-generation-service.ts` re-exports everything below, so the prompt layer can keep
// importing from one place.

import { contentTemplates } from "./content-templates";

/* -------------------------------------------------------------------------- */
/* Editor pass result (spec §11.2.7)                                           */
/* -------------------------------------------------------------------------- */

/** One claim the editor read as contradicted by, or absent from, <FACTS>. */
export interface EditorFinding {
  /** The sentence from the body, as the editor copied it. */
  claim: string;
  /** The heading of the section the sentence sits in. */
  sectionName: string;
  /** Dotted <FACTS> path that settles it, when the editor could name one. */
  factPath?: string;
}

/** A phrase the editor read as prompt-layer register rather than English prose. */
export interface EditorRegisterLeak {
  phrase: string;
  sectionName: string;
}

/**
 * The whole editor pass, stored verbatim on `GeneratedContent.metadata.editor` and on the article
 * in Convex. `factsScore` is the field the publish gate reads; the rest is for the operator digest
 * and the eval harness.
 */
export interface EditorPassResult {
  contradictions: EditorFinding[];
  unsupported: EditorFinding[];
  registerLeaks: EditorRegisterLeak[];
  /** 1-5. Below 3 holds the article (spec §11.2.7). */
  factsScore: number;
  /** 1-5. Below 3 is a warning only; voice never blocks. */
  voiceScore: number;
  /** Section headings the editor judged unfinished. */
  incompleteSections: string[];
  /** Which model graded it. */
  model: string;
  /** Measured cost of this one call, already included in `metadata.costUsd`. */
  costUsd: number;
}

/* -------------------------------------------------------------------------- */
/* Publish gate (spec §11.2.9)                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The subset of a review flag the gate needs. `Violation` is assignable to this, and so is a flag
 * read back out of Convex, where `severity` is a plain string.
 */
export interface PublishGateFlag {
  kind: string;
  severity: string;
  detail?: string;
  section?: string;
}

/**
 * The subset of `GeneratedContent["metadata"]` the gate reads. Written structurally so a Convex
 * document's metadata (which is stored, not constructed here) satisfies it without a cast.
 */
export interface PublishGateMetadata {
  reviewFlags?: PublishGateFlag[] | null;
  /** Partial so a stored editor review with only the scores still gates correctly. */
  editor?: Partial<EditorPassResult> | null;
  verifierStats?: { wordCount?: number | null } | null;
  /** Counted body words, when the caller has them outside `verifierStats`. */
  wordCount?: number | null;
  /** `generateTags` puts the content type first; `contentType` wins when both are present. */
  tags?: string[] | null;
  contentType?: string | null;
}

/** Fraction of the template's word ceiling an article must reach to publish unattended. */
export const MIN_WORD_FRACTION = 0.3;

function uniqueKinds(flags: PublishGateFlag[]): string {
  return [...new Set(flags.map(flag => flag.kind))].join(", ");
}

/**
 * §11.2.9. Publish iff there is no `block`, no `strip`, the editor scored the facts at 3 or better,
 * the body reached 30% of the template's word ceiling and no required section is missing (which the
 * verifier reports as `thin_article`).
 *
 * Pure: no I/O, no clock, no randomness. `reasons` is what the "needs your review" notice says.
 */
export function shouldPublish(metadata: PublishGateMetadata): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const flags = metadata.reviewFlags ?? [];

  const blocks = flags.filter(flag => flag.severity === "block");
  if (blocks.length > 0) {
    reasons.push(`${blocks.length} unresolved blocking finding(s): ${uniqueKinds(blocks)}`);
  }

  const strips = flags.filter(flag => flag.severity === "strip");
  if (strips.length > 0) {
    reasons.push(`${strips.length} finding(s) removed text: ${uniqueKinds(strips)}`);
  }

  if (flags.some(flag => flag.kind === "thin_article")) {
    reasons.push("a required section is missing");
  }

  // A low editor score holds the piece only when the editor cited something. A 2/5 with no
  // contradictions, no unsupported claims and no register leaks is the rubric parse dropping its
  // notes (seen on the 2025 backfill), not a verdict; the verifier already logs it as a warning.
  const editor = metadata.editor;
  const editorFindings =
    (editor?.contradictions?.length ?? 0) + (editor?.unsupported?.length ?? 0) + (editor?.registerLeaks?.length ?? 0);
  if (editor && typeof editor.factsScore === "number" && editor.factsScore < 3 && editorFindings > 0) {
    reasons.push(`the editor scored the facts ${editor.factsScore}/5`);
  }

  const contentType = metadata.contentType ?? metadata.tags?.[0] ?? "";
  const ceiling = contentTemplates[contentType]?.estimatedWords ?? 0;
  const words = metadata.wordCount ?? metadata.verifierStats?.wordCount ?? 0;
  const floor = Math.round(ceiling * MIN_WORD_FRACTION);
  if (ceiling > 0 && words < floor) {
    reasons.push(`${words} words is under the ${floor}-word floor for ${contentType}`);
  }

  return { ok: reasons.length === 0, reasons };
}
