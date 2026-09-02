"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import { Clock, Send } from "lucide-react";

import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Chip, Panel, SectionHeader, Spinner } from "@/components/broadcast";
import { useNow } from "@/components/useNow";
import { cn } from "@/lib/utils";

type BoardStatus = "answered" | "waiting" | "declined" | "no_response";

const STATUS_CHIP: Record<
  BoardStatus,
  { variant: "win" | "signal" | "muted" | "outline"; label: string; live?: boolean }
> = {
  answered: { variant: "win", label: "Answered" },
  waiting: { variant: "signal", label: "Waiting", live: true },
  declined: { variant: "muted", label: "No comment" },
  no_response: { variant: "outline", label: "No response" },
};

/** "2h 14m" / "14m 08s" / "Past deadline" — a countdown a reader can act on. */
function countdownLabel(msRemaining: number): string {
  if (msRemaining <= 0) return "Going to print";
  const totalSeconds = Math.floor(msRemaining / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

export interface WaitingOnCommentProps {
  articleId: Id<"aiContent">;
  /** Optional heading override, e.g. the article's working title. */
  title?: string;
  className?: string;
}

/**
 * The requester's board for a story sitting in `waiting_for_comments` (spec §8.2):
 * how many managers have answered, where each one stands, how long is left, and the
 * button that runs the deadline early. "Go to print now" only appears while the story
 * is actually waiting; the mutation itself enforces commissioner-or-requester.
 */
export function WaitingOnComment({ articleId, title, className }: WaitingOnCommentProps) {
  const board = useQuery(api.aiContentWithComments.getCommentRequestBoard, { articleId });
  const goToPrintNow = useMutation(api.aiContentWithComments.goToPrintNow);
  const [isPrinting, setIsPrinting] = useState(false);
  const now = useNow();

  if (board === undefined) {
    return (
      <Panel padding="md" className={cn("flex items-center gap-2 text-bc-text-3", className)}>
        <Spinner size={14} />
        <span className="bc-label-sm">Loading the board</span>
      </Panel>
    );
  }

  // Nobody was asked — there is no board to show.
  if (board.requests.length === 0) return null;

  const answered = board.requests.filter((request) => request.status === "answered").length;
  const isWaiting = board.status === "waiting_for_comments";
  const remaining = board.deadline - now;

  const handleGoToPrint = async () => {
    setIsPrinting(true);
    try {
      const result = await goToPrintNow({ articleId });
      toast.success(
        result?.scheduled ? "Sent to the desk. The writer is on it." : "Already gone to print.",
      );
    } catch (error) {
      console.error("Failed to go to print:", error);
      toast.error(
        error instanceof Error ? error.message : "Could not run the deadline. Please try again.",
      );
    } finally {
      setIsPrinting(false);
    }
  };

  return (
    <Panel padding="md" className={cn("flex flex-col gap-4", className)}>
      <SectionHeader
        size="sm"
        kicker={title ?? "Reaching out for comment"}
        title={`${answered} of ${board.requests.length} responded`}
        actions={
          <span className="bc-label-sm flex items-center gap-1.5 text-bc-text-3">
            <Clock className="size-3.5" />
            {isWaiting ? countdownLabel(remaining) : "Went to print"}
          </span>
        }
      />

      <ul className="flex flex-col border border-bc-hairline bg-bc-panel-2">
        {board.requests.map((request) => {
          const chip = STATUS_CHIP[request.status as BoardStatus] ?? STATUS_CHIP.no_response;
          return (
            <li
              key={request.commentRequestId}
              className="flex items-center justify-between gap-3 border-t border-bc-hairline px-3.5 py-2.5 first:border-t-0"
            >
              <div className="min-w-0">
                <p className="truncate font-display text-[15px] font-bold tracking-[0.02em] text-bc-ink uppercase">
                  {request.teamName}
                </p>
                <p className="truncate text-[13px] text-bc-text-3">{request.managerName}</p>
              </div>
              <Chip variant={chip.variant} live={isWaiting && chip.live}>
                {chip.label}
              </Chip>
            </li>
          );
        })}
      </ul>

      {isWaiting && (
        <div className="flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center">
          <p className="text-[13px] leading-relaxed text-bc-text-2">
            We go to print at{" "}
            {new Date(board.deadline).toLocaleTimeString(undefined, {
              hour: "numeric",
              minute: "2-digit",
            })}
            . Anyone who hasn&apos;t answered is reported as not having answered.
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleGoToPrint}
            disabled={isPrinting}
            className="flex-none"
          >
            {isPrinting ? <Spinner size={14} /> : <Send className="size-4" />}
            Go to print now
          </Button>
        </div>
      )}
    </Panel>
  );
}

export interface LeagueWaitingOnCommentProps {
  leagueId: Id<"leagues">;
  className?: string;
}

/**
 * Every story in this league currently holding for comment, for the homepage content
 * area (spec §8.2).
 *
 * Note: this reads the league's articles through `aiContent.getAllByLeague`, the only
 * public query that returns non-published rows today. A narrow
 * `aiContent.getWaitingArticles(leagueId)` would make this a two-row read instead of a
 * full-table one — swap it in here when it exists.
 */
export function LeagueWaitingOnComment({ leagueId, className }: LeagueWaitingOnCommentProps) {
  const articles = useQuery(api.aiContent.getAllByLeague, { leagueId });
  const waiting = (articles ?? []).filter(
    (article) => article.status === "waiting_for_comments",
  );

  if (waiting.length === 0) return null;

  return (
    <div className={cn("flex flex-col gap-4", className)}>
      {waiting.map((article) => (
        <WaitingOnComment key={article._id} articleId={article._id} title={article.title} />
      ))}
    </div>
  );
}
