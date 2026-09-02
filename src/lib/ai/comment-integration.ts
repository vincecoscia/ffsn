// Prose rendering of the quote ledger.
//
// The normative source of quotable material is `facts.quotes` inside the <FACTS> block. This module
// renders the same rows as readable prose because the model follows prose structure better than raw
// JSON — but it adds no rules, no all-caps enforcement and no examples with real names. Attribution
// correctness is guaranteed by `fact-verifier.ts`, not by shouting at the model.

import type { CommentResponseData, NonRespondent } from "./content-generation-service";

// Re-exported so existing `import { CommentResponseData } from ".../comment-integration"` call
// sites keep resolving to the single shared definition.
export type { CommentResponseData, NonRespondent } from "./content-generation-service";

export interface CommentIntegrationContext {
  commentResponses: CommentResponseData[];
  nonRespondents?: NonRespondent[];
  contentType: string;
  week?: number;
}

/** Renders the ledger as one block per manager: who, which team, what was asked, what was said. */
export function formatCommentsForPrompt(context: CommentIntegrationContext): string {
  const { commentResponses, nonRespondents = [] } = context;
  if (commentResponses.length === 0 && nonRespondents.length === 0) return "";

  const lines: string[] = ["", "=== ON-THE-RECORD QUOTE LEDGER ==="];

  if (commentResponses.length > 0) {
    lines.push(
      "Each block below is one manager. The quotes are verbatim. Quotation marks in your article may",
      "only contain text copied character-for-character from these lines.",
      ""
    );

    commentResponses.forEach(response => {
      lines.push(`## ${response.userName} — ${response.teamName}`);
      lines.push(`Asked about: ${response.questionTopic}`);
      response.quotes.forEach(quote => lines.push(`> "${quote}"`));
      lines.push("");
    });
  }

  if (nonRespondents.length > 0) {
    lines.push("## Did not go on the record");
    nonRespondents.forEach(entry => {
      const status = entry.status === "declined" ? "declined to comment" : "did not respond";
      lines.push(`- ${entry.userName} (${entry.teamName}) ${status}.`);
    });
    lines.push("");
  }

  lines.push("=== END OF QUOTE LEDGER ===", "");
  return lines.join("\n");
}

/** Content-type-specific guidance on how to place quotes. Style only — no factual rules here. */
export function getCommentIntegrationInstructions(contentType: string): string {
  const base = `
USING THE LEDGER
- Attribute on first reference as "{Manager Name} of {Team Name}", team alone afterwards.
- Say what the manager was asked about before or after the quote, so the reader has the context.
- Respond to every quote you use, in your own voice, in the same section.
- A manager who did not respond may be described only with the sanctioned phrasing in your persona's
  quote style. Do not infer a reason for the silence.
`;

  const perType: Record<string, string> = {
    weekly_recap: `- Place a manager's quote inside the analysis of that manager's own game, never another's.
- If a team has no quote, cover their game without one and say nothing about why.
`,
    trade_analysis: `- Give both sides of the trade their own stated reasoning where the ledger has it.
- Where only one side spoke, say so plainly rather than balancing it with invention.
`,
    waiver_wire_report: `- Use stated FAAB reasoning where the ledger has it; otherwise report the claim without motive.
`,
    power_rankings: `- A quote may support or contradict a ranking. If it contradicts, show the number and let both stand.
`,
    draft_rankings: `- Weave each manager's stated reasoning into that team's own grade block, not a separate section.
`,
  };

  return base + (perType[contentType] || "");
}

/** Appends the ledger rendering to a user prompt that already carries the <FACTS> block. */
export function enhancePromptWithComments(
  originalPrompt: string,
  commentContext: CommentIntegrationContext
): string {
  const ledger = formatCommentsForPrompt(commentContext);
  if (!ledger) return originalPrompt;

  return `${originalPrompt}

${getCommentIntegrationInstructions(commentContext.contentType)}

${ledger}`;
}
