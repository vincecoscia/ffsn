"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useConvexAuth } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import { Id } from "../../../../convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Share2 } from "lucide-react";
import { toast } from "sonner";

type Reaction = "fire" | "lol" | "salty" | "respect";

const REACTIONS: { key: Reaction; emoji: string; label: string }[] = [
  { key: "fire", emoji: "\u{1F525}", label: "Fire" },
  { key: "lol", emoji: "\u{1F602}", label: "LOL" },
  { key: "salty", emoji: "\u{1F9C2}", label: "Salty" },
  { key: "respect", emoji: "\u{1F44F}", label: "Respect" },
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
    <div className="flex flex-wrap items-center gap-2 sm:gap-3">
      {REACTIONS.map(({ key, emoji, label }) => {
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
              "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm transition-colors cursor-pointer",
              isMine
                ? "border-red-300 bg-red-50 text-red-700"
                : "border-gray-200 bg-white text-gray-600 hover:bg-gray-50",
              pending === key && "opacity-60"
            )}
          >
            <span aria-hidden>{emoji}</span>
            <span className="tabular-nums">{count}</span>
          </button>
        );
      })}

      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={handleShare}
        className="ml-auto gap-1.5"
      >
        <Share2 className="size-4" />
        Share
      </Button>
    </div>
  );
}
