"use client";

import { useState } from "react";
import Link from "next/link";
import { useMutation } from "convex/react";
import { toast } from "sonner";

import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { Panel } from "@/components/broadcast";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { MANAGER_POST_MAX_CHARS } from "@/lib/ai/wire/types";
import type { LanguageRating } from "@/lib/ai/language";
import type { WireStatus } from "./useLeagueWire";

function ratingHint(rating: LanguageRating): string {
  switch (rating) {
    case "salty":
      return "Rated Salty: mild language only";
    case "unfiltered":
      return "Rated Unfiltered";
    default:
      return "Rated Clean";
  }
}

export interface WireComposerProps {
  leagueId: Id<"leagues">;
  status: WireStatus;
  className?: string;
}

/**
 * The Wire page's top-of-feed composer (spec §17.2, deliverable #2): post as your claimed team.
 * Renders nothing when the league has no active League Pass or the desk has turned the Wire off;
 * a member with no claimed team gets a one-line nudge to `/leagues/[id]/settings` instead of the
 * textarea.
 */
export function WireComposer({ leagueId, status, className }: WireComposerProps) {
  const postAsManager = useMutation(api.wire.postAsManager);
  const [text, setText] = useState("");
  const [isPosting, setIsPosting] = useState(false);

  if (!(status.passActive && status.wireEnabled !== false)) return null;

  if (!status.myTeam) {
    return (
      <p className={cn("text-[14px] text-bc-text-3", className)}>
        <Link
          href={`/leagues/${leagueId}/settings`}
          className="underline decoration-bc-hairline underline-offset-2 hover:text-bc-red-text"
        >
          Claim your team
        </Link>{" "}
        to post on The Wire
      </p>
    );
  }

  const trimmed = text.trim();
  const overLimit = trimmed.length > MANAGER_POST_MAX_CHARS;
  const canSubmit = trimmed.length > 0 && !overLimit && !isPosting;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setIsPosting(true);
    try {
      await postAsManager({ leagueId, text: trimmed });
      setText("");
      toast.success("Posted to The Wire");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't post to The Wire");
    } finally {
      setIsPosting(false);
    }
  };

  return (
    <Panel padding="md" className={cn("flex flex-col gap-3", className)}>
      <Textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder="Say something on The Wire..."
        rows={3}
        aria-label="Post to The Wire"
      />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="bc-label-sm text-bc-text-3">{ratingHint(status.languageRating)}</span>
        <div className="flex items-center gap-3">
          <span
            className={cn(
              "bc-num tabular-nums text-[13px]",
              overLimit ? "text-bc-red-text" : "text-bc-text-3"
            )}
          >
            {trimmed.length}/{MANAGER_POST_MAX_CHARS}
          </span>
          <Button size="sm" onClick={handleSubmit} disabled={!canSubmit}>
            {isPosting ? "Posting..." : `Post as ${status.myTeam.name}`}
          </Button>
        </div>
      </div>
    </Panel>
  );
}
