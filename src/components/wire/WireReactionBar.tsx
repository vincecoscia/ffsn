"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useConvexAuth } from "convex/react";
import { Flame, Laugh, Droplets, HandMetal, type LucideIcon } from "lucide-react";
import { toast } from "sonner";

import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { cn } from "@/lib/utils";
import type { WireReactionsView } from "./useLeagueWire";

type WireReactionKey = "fire" | "lol" | "salty" | "respect";

const REACTIONS: { key: WireReactionKey; icon: LucideIcon; label: string }[] = [
  { key: "fire", icon: Flame, label: "Fire" },
  { key: "lol", icon: Laugh, label: "LOL" },
  { key: "salty", icon: Droplets, label: "Salty" },
  { key: "respect", icon: HandMetal, label: "Respect" },
];

export interface WireReactionBarProps {
  leagueId: Id<"leagues">;
  /** "global" for a `wirePosts` row, "league" for any `wireLeaguePosts` row (root, overlay or reply). */
  scope: "global" | "league";
  postId: string;
  reactions: WireReactionsView;
  className?: string;
}

/**
 * Compact single-row reaction bar — same four reactions as an article's `EngagementBar`, sized
 * down for a Wire post or reply: the viewer's own reaction highlighted, tap again removes it
 * (spec §17.1, deliverable #1). Every button is a native `<button>` with `aria-pressed`, so it's
 * keyboard-reachable and screen-reader-sane without extra wiring.
 */
export function WireReactionBar({ leagueId, scope, postId, reactions, className }: WireReactionBarProps) {
  const { isAuthenticated } = useConvexAuth();
  const router = useRouter();
  const react = useMutation(api.wire.react);
  const [pending, setPending] = useState<WireReactionKey | null>(null);

  const handleReact = async (reaction: WireReactionKey) => {
    if (!isAuthenticated) {
      toast("Sign in to react", {
        action: { label: "Sign in", onClick: () => router.push("/sign-in") },
      });
      return;
    }
    setPending(reaction);
    try {
      await react({ leagueId, scope, postId, reaction });
    } catch {
      toast.error("Couldn't save your reaction. Try again.");
    } finally {
      setPending(null);
    }
  };

  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", className)} role="group" aria-label="React to this post">
      {REACTIONS.map(({ key, icon: Icon, label }) => {
        const count = reactions.counts[key] ?? 0;
        const isMine = reactions.mine === key;
        return (
          <button
            key={key}
            type="button"
            onClick={() => handleReact(key)}
            disabled={pending === key}
            aria-pressed={isMine}
            aria-label={label}
            title={label}
            className={cn(
              "inline-flex h-7 items-center gap-1.5 border px-2 text-[12px] font-semibold transition-colors",
              isMine
                ? "border-bc-red bg-bc-red text-white"
                : "border-bc-hairline bg-transparent text-bc-text-2 hover:border-bc-red hover:text-bc-ink",
              pending === key && "opacity-60"
            )}
          >
            <Icon className="size-3.5" strokeWidth={1.8} aria-hidden="true" />
            <span className={cn("bc-num tabular-nums", isMine ? "text-white/80" : "text-bc-text-3")}>{count}</span>
          </button>
        );
      })}
    </div>
  );
}
