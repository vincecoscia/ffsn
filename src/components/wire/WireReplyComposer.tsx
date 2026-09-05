"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import { toast } from "sonner";

import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { MANAGER_POST_MAX_CHARS } from "@/lib/ai/wire/types";

export interface WireReplyComposerProps {
  leagueId: Id<"leagues">;
  /** Global for a reply to a global post; league for a reply to a league post or another reply
   *  (spec §17.2, deliverable #3 — replies always flatten into their root's thread). */
  replyTo: { scope: "global" | "league"; id: string };
  /** The viewer's claimed team name, for the placeholder. */
  teamName: string;
  onPosted: () => void;
  onCancel: () => void;
  className?: string;
}

/**
 * Inline reply box under a post or a reply — same posting rules as `WireComposer`, targeted at
 * `replyTo` instead of the feed root (spec §17.2, deliverable #3).
 */
export function WireReplyComposer({
  leagueId,
  replyTo,
  teamName,
  onPosted,
  onCancel,
  className,
}: WireReplyComposerProps) {
  const postAsManager = useMutation(api.wire.postAsManager);
  const [text, setText] = useState("");
  const [isPosting, setIsPosting] = useState(false);

  const trimmed = text.trim();
  const overLimit = trimmed.length > MANAGER_POST_MAX_CHARS;
  const canSubmit = trimmed.length > 0 && !overLimit && !isPosting;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setIsPosting(true);
    try {
      await postAsManager({ leagueId, text: trimmed, replyTo });
      setText("");
      toast.success("Posted to The Wire");
      onPosted();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't post to The Wire");
    } finally {
      setIsPosting(false);
    }
  };

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <Textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder={`Reply as ${teamName}...`}
        rows={2}
        autoFocus
        aria-label="Reply to this post"
      />
      <div className="flex items-center justify-between gap-3">
        <span
          className={cn(
            "bc-num tabular-nums text-[13px]",
            overLimit ? "text-bc-red-text" : "text-bc-text-3"
          )}
        >
          {trimmed.length}/{MANAGER_POST_MAX_CHARS}
        </span>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={onCancel} disabled={isPosting}>
            Cancel
          </Button>
          <Button size="sm" onClick={handleSubmit} disabled={!canSubmit}>
            {isPosting ? "Posting..." : "Reply"}
          </Button>
        </div>
      </div>
    </div>
  );
}
