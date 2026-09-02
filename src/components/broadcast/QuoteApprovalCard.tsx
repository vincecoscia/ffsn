"use client";

import { useState } from "react";
import { Check, Pencil, Undo2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Chip } from "./Chip";
import { Spinner } from "./LoadingScreen";
import { cn } from "@/lib/utils";

export type QuoteReviewStatus = "pending" | "approved" | "edited" | "withdrawn";

/** One row of `commentResponses.quoteReview` (spec §8.1). */
export interface QuoteReviewEntry {
  /** What the manager actually typed, before any edit. */
  original: string;
  /** The text of record — the edited line once the manager tightens it. */
  text: string;
  status: QuoteReviewStatus;
}

export interface QuoteApprovalCardProps {
  quote: QuoteReviewEntry;
  /** Position in the list, for the "Quote 2 of 3" label and the edit field's id. */
  index: number;
  total?: number;
  /** Deadline has passed (or the request is closed): the card is read-only. */
  locked?: boolean;
  /** A review action for this card is in flight. */
  busy?: boolean;
  onApprove?: () => void;
  onEdit?: (text: string) => void;
  onWithdraw?: () => void;
  className?: string;
}

const STATUS_CHIP: Record<
  Exclude<QuoteReviewStatus, "pending">,
  { variant: "win" | "signal" | "muted"; label: string }
> = {
  approved: { variant: "win", label: "Approved" },
  edited: { variant: "signal", label: "Edited" },
  withdrawn: { variant: "muted", label: "Taken back" },
};

/**
 * One quote awaiting the manager's sign-off, as it appears under Sam's
 * "here's what we'll quote you saying" message (spec §8.1): the line itself, then
 * Looks good / Edit / Take it back while it is pending, and a status chip once it
 * isn't. After the deadline it is read-only and says the story went to print.
 *
 * Presentational — the mounted view (`src/components/QuoteApproval.tsx`) owns the
 * `getQuoteReview` query and the `reviewQuote` mutation.
 */
export function QuoteApprovalCard({
  quote,
  index,
  total,
  locked = false,
  busy = false,
  onApprove,
  onEdit,
  onWithdraw,
  className,
}: QuoteApprovalCardProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(quote.text);

  // Opening the editor always starts from the current text of record, so a change
  // that landed while the card was closed is what gets edited.
  const startEditing = () => {
    setDraft(quote.text);
    setIsEditing(true);
  };

  const isWithdrawn = quote.status === "withdrawn";
  const canAct = !locked && !busy;
  const fieldId = `quote-edit-${index}`;

  const save = () => {
    const next = draft.trim();
    if (!next || next === quote.text) {
      setIsEditing(false);
      return;
    }
    onEdit?.(next);
    setIsEditing(false);
  };

  return (
    <li
      className={cn(
        "flex flex-col gap-3 border border-bc-hairline bg-bc-panel p-3.5 sm:p-4",
        isWithdrawn && "opacity-70",
        className,
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <span className="bc-label-sm text-bc-text-3">
          Quote {index + 1}
          {typeof total === "number" ? ` of ${total}` : ""}
        </span>
        {quote.status !== "pending" && (
          <Chip variant={STATUS_CHIP[quote.status].variant}>
            {STATUS_CHIP[quote.status].label}
          </Chip>
        )}
      </div>

      {isEditing ? (
        <div className="flex flex-col gap-2">
          <label htmlFor={fieldId} className="bc-label-sm text-bc-text-3">
            Your words, your way
          </label>
          <Textarea
            id={fieldId}
            autoFocus
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                setDraft(quote.text);
                setIsEditing(false);
              }
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                save();
              }
            }}
            rows={3}
            className="resize-none text-[15px]"
            disabled={busy}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" onClick={save} disabled={busy || !draft.trim()}>
              {busy ? <Spinner size={14} className="[&>span]:bg-white" /> : <Check className="size-4" />}
              Save
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setDraft(quote.text);
                setIsEditing(false);
              }}
              disabled={busy}
            >
              <X className="size-4" />
              Cancel
            </Button>
            <span className="bc-label-sm hidden text-bc-text-3 sm:inline">
              Esc to cancel &middot; &#8984;/Ctrl + Enter to save
            </span>
          </div>
        </div>
      ) : (
        <blockquote
          className={cn(
            "border-l-[4px] border-bc-red bg-bc-panel-2 px-3.5 py-3",
            isWithdrawn && "border-bc-border-strong",
          )}
        >
          <p
            className={cn(
              "font-display text-[16px] leading-snug font-bold text-bc-ink italic sm:text-[18px]",
              isWithdrawn && "text-bc-text-3 line-through",
            )}
          >
            &ldquo;{quote.text}&rdquo;
          </p>
        </blockquote>
      )}

      {quote.status === "edited" && !isEditing && quote.original !== quote.text && (
        <p className="text-[13px] leading-relaxed text-bc-text-3">
          You said: &ldquo;{quote.original}&rdquo;
        </p>
      )}

      {!isEditing && (
        <div className="flex flex-wrap items-center gap-2">
          {quote.status === "pending" ? (
            <>
              <Button type="button" size="sm" onClick={onApprove} disabled={!canAct}>
                {busy ? <Spinner size={14} className="[&>span]:bg-white" /> : <Check className="size-4" />}
                Looks good
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={startEditing}
                disabled={!canAct}
              >
                <Pencil className="size-4" />
                Edit
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={onWithdraw}
                disabled={!canAct}
              >
                <Undo2 className="size-4" />
                Take it back
              </Button>
            </>
          ) : (
            !isWithdrawn &&
            !locked && (
              <>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={startEditing}
                  disabled={!canAct}
                >
                  <Pencil className="size-4" />
                  Edit
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={onWithdraw}
                  disabled={!canAct}
                >
                  <Undo2 className="size-4" />
                  Take it back
                </Button>
              </>
            )
          )}
        </div>
      )}
    </li>
  );
}
