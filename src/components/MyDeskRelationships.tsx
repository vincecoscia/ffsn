"use client";

import { useQuery } from "convex/react";

import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { Panel, RelationshipMeter, SectionHeader } from "@/components/broadcast";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export interface MyDeskRelationshipsProps {
  leagueId: Id<"leagues">;
  /** Meters to show. Defaults to every active writer. */
  limit?: number;
  className?: string;
}

/**
 * The signed-in manager's standing with every writer (spec §6.5), for the league
 * homepage sidebar. Ordered most extreme first, so the writer with a grudge is at
 * the top. Renders nothing for a viewer with no manager record.
 */
export function MyDeskRelationships({ leagueId, limit, className }: MyDeskRelationshipsProps) {
  const meters = useQuery(api.relationships.getMyRelationships, { leagueId });

  if (meters === undefined) {
    return (
      <div className={cn("flex flex-col gap-4", className)}>
        <Skeleton className="h-[220px]" />
      </div>
    );
  }

  // Not a claimed manager in this league — the meter has nothing to say.
  if (meters === null) return null;

  // Most extreme relationship first; ties keep roster order.
  const writers = [...meters.writers].sort((a, b) => Math.abs(b.score) - Math.abs(a.score));
  const shown = typeof limit === "number" ? writers.slice(0, limit) : writers;
  const hasHistory = writers.some((w) => w.eventCount > 0 || w.score !== 0);

  return (
    <Panel padding="md" className={cn("flex flex-col gap-4", className)}>
      <SectionHeader
        size="sm"
        title="You and the desk"
        kicker={meters.teamName}
      />

      {hasHistory ? (
        <div className="flex flex-col gap-3">
          {shown.map((writer) => (
            <RelationshipMeter
              key={writer.persona}
              persona={writer.persona}
              score={writer.score}
              tier={writer.tier}
              events={writer.recentEvents}
            />
          ))}
        </div>
      ) : (
        <p className="text-[14px] leading-relaxed text-bc-text-2">
          No history yet — the desk hasn&apos;t written about you.
        </p>
      )}
    </Panel>
  );
}
