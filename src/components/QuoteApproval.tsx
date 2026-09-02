"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { toast } from "sonner";

import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { QuoteApprovalCard, Spinner } from "@/components/broadcast";
import { useNow } from "@/components/useNow";
import { cn } from "@/lib/utils";

export interface QuoteApprovalProps {
  commentRequestId: Id<"commentRequests">;
  className?: string;
}

/** "4:30 PM" / "Tomorrow 9:00 AM" — the deadline as the manager reads it. */
function printTimeLabel(timestamp: number): string {
  const deadline = new Date(timestamp);
  const time = deadline.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const today = new Date();
  const sameDay =
    deadline.getFullYear() === today.getFullYear() &&
    deadline.getMonth() === today.getMonth() &&
    deadline.getDate() === today.getDate();
  if (sameDay) return time;
  return `${deadline.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })} · ${time}`;
}

/**
 * The manager's sign-off on their own quotes (spec §8.1), mounted under Sam's
 * `quote_approval` message in the interview thread. Each quote can be approved,
 * tightened, or taken back until the deadline; after it, the card is read-only and
 * every quote still pending has already run as approved.
 */
export function QuoteApproval({ commentRequestId, className }: QuoteApprovalProps) {
  const review = useQuery(api.commentConversations.getQuoteReview, { commentRequestId });
  const reviewQuote = useMutation(api.commentConversations.reviewQuote);
  const [busyIndex, setBusyIndex] = useState<number | null>(null);
  // Ticks so the cards lock themselves the moment the story goes to print, with
  // nobody having to reload the thread.
  const now = useNow(30_000);

  if (review === undefined) {
    return (
      <div className={cn("flex items-center gap-2 py-3 text-bc-text-3", className)}>
        <Spinner size={14} />
        <span className="bc-label-sm">Loading your quotes</span>
      </div>
    );
  }

  // Not the manager whose quotes these are, or nothing was quotable.
  if (review === null || review.quotes.length === 0) return null;

  const isPastDeadline = now >= review.deadline;

  const act = async (
    index: number,
    action: "approve" | "edit" | "withdraw",
    text?: string,
  ) => {
    setBusyIndex(index);
    try {
      await reviewQuote({ commentRequestId, index, action, text });
      if (action === "withdraw") toast.success("Pulled. That line won't run.");
      if (action === "edit") toast.success("Updated. We'll quote it exactly like that.");
    } catch (error) {
      console.error("Failed to review quote:", error);
      toast.error(
        error instanceof Error ? error.message : "Could not save that. Please try again.",
      );
    } finally {
      setBusyIndex(null);
    }
  };

  return (
    <section
      className={cn("border border-bc-hairline bg-bc-panel-2", className)}
      aria-label="Your quotes"
    >
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-bc-hairline px-3.5 py-2.5 sm:px-4">
        <span className="bc-h-title text-[17px]">Your quotes</span>
        <span className="bc-label-sm text-bc-text-3">
          {isPastDeadline
            ? "Went to print"
            : `We go to print at ${printTimeLabel(review.deadline)}`}
        </span>
      </header>

      <ul className="flex flex-col gap-3 p-3.5 sm:p-4">
        {review.quotes.map((quote, index) => (
          <QuoteApprovalCard
            key={`${index}-${quote.original}`}
            quote={quote}
            index={index}
            total={review.quotes.length}
            locked={isPastDeadline}
            busy={busyIndex === index}
            onApprove={() => act(index, "approve")}
            onEdit={(text) => act(index, "edit", text)}
            onWithdraw={() => act(index, "withdraw")}
          />
        ))}
      </ul>

      <p className="border-t border-bc-hairline px-3.5 py-2.5 text-[13px] leading-relaxed text-bc-text-2 sm:px-4">
        {isPastDeadline
          ? "This one went to print. Anything you left alone ran as written."
          : "Anything you leave alone runs as written. Nothing you take back is ever sent to the writer."}
      </p>
    </section>
  );
}
