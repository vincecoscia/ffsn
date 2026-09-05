"use client";

import { Rss } from "lucide-react";

import { EmptyState, Panel, Spinner } from "@/components/broadcast";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { WireOverlayBlock } from "./WireOverlayBlock";
import { WirePost } from "./WirePost";
import type { WireFeedItem } from "./useLeagueWire";

export interface WireFeedProps {
  items: WireFeedItem[];
  isLoadingFirstPage: boolean;
  isLoadingMore: boolean;
  canLoadMore: boolean;
  onLoadMore: () => void;
  className?: string;
}

/** The Wire's timeline: global posts (each with its league's overlays nested beneath, quote-style)
 *  merged newest-first with routine league posts, plus loading/empty states and "Load more" (spec §2). */
export function WireFeed({
  items,
  isLoadingFirstPage,
  isLoadingMore,
  canLoadMore,
  onLoadMore,
  className,
}: WireFeedProps) {
  if (isLoadingFirstPage) {
    return (
      <div className={cn("flex flex-col gap-4", className)}>
        {[0, 1, 2].map((i) => (
          <Panel key={i} padding="md" className="flex flex-col gap-3">
            <div className="flex items-center gap-3">
              <Skeleton className="size-10 flex-none" />
              <Skeleton className="h-4 w-40" />
            </div>
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-2/3" />
          </Panel>
        ))}
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <EmptyState
        icon={<Rss className="size-6" strokeWidth={1.8} />}
        title="The Wire is quiet"
        description="The Wire opens with the first injury report of the year."
      />
    );
  }

  return (
    <div className={cn("flex flex-col gap-4", className)}>
      {items.map((item) =>
        item.scope === "global" ? (
          <WirePost
            key={item.post._id}
            persona={item.post.persona}
            text={item.post.text}
            tags={item.post.tags}
            createdAt={item.post.createdAt}
            status={item.post.status}
            source={item.post.source}
          >
            {item.post.overlays.length > 0 && (
              <div className="flex flex-col gap-3 border-t border-bc-hairline pt-3">
                {item.post.overlays.map((overlay) => (
                  <WireOverlayBlock
                    key={overlay._id}
                    team={overlay.impact?.team ?? { name: "Unknown team" }}
                    variant={overlay.impact?.variant ?? "owner"}
                    text={overlay.text}
                  />
                ))}
              </div>
            )}
          </WirePost>
        ) : (
          <WirePost
            key={item.post._id}
            persona={item.post.persona}
            text={item.post.text}
            tags={item.post.tags}
            createdAt={item.post.createdAt}
          />
        )
      )}

      {canLoadMore && (
        <Button variant="outline" onClick={onLoadMore} disabled={isLoadingMore} className="w-fit self-center">
          {isLoadingMore && <Spinner size={14} className="mr-2" />}
          {isLoadingMore ? "Loading" : "Load more"}
        </Button>
      )}
    </div>
  );
}
