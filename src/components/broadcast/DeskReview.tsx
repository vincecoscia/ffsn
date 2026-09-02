import { cn } from "@/lib/utils";

export type ReviewFlagSeverity = "block" | "strip" | "warn";

/** `aiContent.reviewFlags` entry, straight from the verifier (spec §4.5). */
export interface ReviewFlag {
  kind: string;
  detail: string;
  section?: string;
  severity: ReviewFlagSeverity;
}

export interface DeskReviewProps {
  flags?: ReviewFlag[];
  /** `aiContent.factsMissing` — dotted FACTS paths the writer asked for and didn't have. */
  factsMissing?: string[];
  className?: string;
}

const SEVERITY_ORDER: Record<ReviewFlagSeverity, number> = { block: 0, strip: 1, warn: 2 };

const SEVERITY_COPY: Record<ReviewFlagSeverity, string> = {
  block: "Blocked",
  strip: "Removed",
  warn: "Check",
};

/** `verifier_kind_name` -> "Verifier kind name". */
function humanizeKind(kind: string): string {
  const words = kind.replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Dotted FACTS paths stay readable as paths; only the `facts.` prefix is noise. */
function factLabel(path: string): string {
  return path.replace(/^facts\./, "");
}

/**
 * The "Desk review" panel above the edit-before-publish editor: every verifier finding
 * on this draft, blocks and strips first in red, warnings muted, plus the data the
 * writer asked for and did not have. Renders nothing when the draft came back clean.
 */
export function DeskReview({ flags, factsMissing, className }: DeskReviewProps) {
  const sorted = [...(flags ?? [])].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
  );
  const missing = factsMissing ?? [];

  if (sorted.length === 0 && missing.length === 0) return null;

  const blocked = sorted.filter((f) => f.severity !== "warn").length;
  const warned = sorted.length - blocked;

  return (
    <section
      className={cn("border border-bc-hairline bg-bc-panel-2", className)}
      aria-label="Desk review"
    >
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-bc-hairline px-4 py-2.5">
        <span className="bc-h-title text-[18px]">Desk review</span>
        <span className="bc-label-sm text-bc-text-3">
          {blocked > 0 && (
            <span className="text-bc-red-text">
              {blocked} {blocked === 1 ? "finding" : "findings"} to fix
            </span>
          )}
          {blocked > 0 && warned > 0 && <span className="mx-2">&middot;</span>}
          {warned > 0 && `${warned} to check`}
        </span>
      </header>

      {sorted.length > 0 && (
        <ul className="flex flex-col">
          {sorted.map((flag, index) => {
            const isHard = flag.severity !== "warn";
            return (
              <li
                key={`${flag.severity}-${flag.kind}-${index}`}
                className={cn(
                  "flex flex-col gap-1.5 border-t border-bc-hairline px-4 py-3 first:border-t-0 sm:flex-row sm:gap-4",
                  isHard && "border-l-4 border-l-bc-red",
                )}
              >
                <div className="flex flex-none items-center gap-2 sm:w-[168px] sm:flex-col sm:items-start sm:gap-1.5">
                  <span
                    className={cn(
                      "bc-label-sm",
                      isHard ? "text-bc-red-text" : "text-bc-text-3",
                    )}
                  >
                    {SEVERITY_COPY[flag.severity]}
                  </span>
                  <span className="bc-label-sm text-bc-text-3">{humanizeKind(flag.kind)}</span>
                </div>
                <div className="min-w-0 flex-1">
                  <p
                    className={cn(
                      "text-[14px] leading-relaxed",
                      isHard ? "text-bc-ink" : "text-bc-text-2",
                    )}
                  >
                    {flag.detail}
                  </p>
                  {flag.section && (
                    <p className="bc-label-sm mt-1.5 text-bc-text-3">In {flag.section}</p>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {missing.length > 0 && (
        <div className="border-t border-bc-hairline px-4 py-3">
          <span className="bc-label-sm text-bc-text-3">Not in the data this week</span>
          <ul className="mt-2 flex flex-wrap gap-1.5">
            {missing.map((path) => (
              <li
                key={path}
                className="border border-bc-hairline bg-bc-panel px-2 py-1 font-mono text-[12px] text-bc-text-2"
              >
                {factLabel(path)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
