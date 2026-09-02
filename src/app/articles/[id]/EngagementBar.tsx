"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useConvexAuth } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import { Id } from "../../../../convex/_generated/dataModel";
import { Panel } from "@/components/broadcast";
import { cn } from "@/lib/utils";
import { Flame, Laugh, Droplets, HandMetal, Share2, type LucideIcon } from "lucide-react";
import { toast } from "sonner";

type Reaction = "fire" | "lol" | "salty" | "respect";

const REACTIONS: { key: Reaction; icon: LucideIcon; label: string }[] = [
  { key: "fire", icon: Flame, label: "Fire" },
  { key: "lol", icon: Laugh, label: "LOL" },
  { key: "salty", icon: Droplets, label: "Salty" },
  { key: "respect", icon: HandMetal, label: "Respect" },
];

interface EngagementBarProps {
  articleId: string;
  title: string;
  summary: string;
}

export function EngagementBar({ articleId, title, summary }: EngagementBarProps) {
  const { isAuthenticated } = useConvexAuth();
  const router = useRouter();
  const id = articleId as Id<"aiContent">;

  const summaryData = useQuery(api.articleEngagement.getReactionSummary, { articleId: id });
  const toggleReaction = useMutation(api.articleEngagement.toggleReaction);
  const [pending, setPending] = useState<Reaction | null>(null);

  const handleReact = async (reaction: Reaction) => {
    if (!isAuthenticated) {
      toast("Sign in to react", {
        action: {
          label: "Sign in",
          onClick: () => {
            router.push("/sign-in");
          },
        },
      });
      return;
    }

    setPending(reaction);
    try {
      await toggleReaction({ articleId: id, reaction });
    } catch {
      toast.error("Couldn't save your reaction. Try again.");
    } finally {
      setPending(null);
    }
  };

  const handleShare = async () => {
    const base =
      process.env.NEXT_PUBLIC_SITE_URL ||
      (typeof window !== "undefined" ? window.location.origin : "https://ffsn.ai");
    const url = `${base}/articles/${articleId}`;

    if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
      try {
        await navigator.share({ title, text: summary, url });
      } catch {
        // User dismissed the native share sheet - nothing to do.
      }
      return;
    }

    try {
      await navigator.clipboard.writeText(url);
      toast.success("Link copied");
    } catch {
      toast.error("Couldn't copy link");
    }
  };

  return (
    <Panel
      padding="none"
      className="flex flex-wrap items-center justify-between gap-3 px-4 py-3.5 sm:px-5"
    >
      <div className="flex flex-wrap items-center gap-2 sm:gap-2.5">
        <span className="bc-label-sm hidden pr-1 text-bc-text-3 sm:inline">React</span>
        {REACTIONS.map(({ key, icon: Icon, label }) => {
          const count = summaryData?.counts[key] ?? 0;
          const isMine = summaryData?.mine === key;
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
                "inline-flex h-11 items-center gap-2 border px-3.5 font-display text-[15px] font-bold tracking-[0.06em] uppercase transition-colors sm:text-[17px]",
                isMine
                  ? "border-bc-red bg-bc-red text-white"
                  : "border-bc-border-strong bg-bc-ground text-bc-ink hover:border-bc-red",
                pending === key && "opacity-60"
              )}
            >
              <Icon className="size-[18px]" strokeWidth={1.8} aria-hidden="true" />
              <span className="hidden sm:inline">{label}</span>
              <span
                className={cn(
                  "bc-num tabular-nums",
                  isMine ? "text-white/80" : "text-bc-text-2"
                )}
              >
                {count}
              </span>
            </button>
          );
        })}
      </div>

      <button
        type="button"
        onClick={handleShare}
        className="inline-flex h-11 items-center gap-2.5 border border-bc-border-strong px-4 font-display text-[15px] font-bold tracking-[0.08em] text-bc-ink uppercase transition-colors hover:border-bc-red sm:text-[17px]"
      >
        <Share2 className="size-[18px]" strokeWidth={1.8} aria-hidden="true" />
        Share
      </button>
    </Panel>
  );
}
