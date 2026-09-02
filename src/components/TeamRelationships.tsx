"use client";

import { useQuery } from "convex/react";

import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { EmptyState, RelationshipMeter } from "@/components/broadcast";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { Newspaper } from "lucide-react";

export interface TeamRelationshipsProps {
  leagueId: Id<"leagues">;
  teamId: Id<"teams">;
  className?: string;
}

/**
 * Any team's standing with every writer (spec §6.5), for the team page. Same meters
 * as `MyDeskRelationships`, read for the manager who claimed `teamId`.
 */
export function TeamRelationships({ leagueId, teamId, className }: TeamRelationshipsProps) {
  const meters = useQuery(api.relationships.getTeamRelationships, { leagueId, teamId });

  if (meters === undefined) {
    return (
      <div className={cn("grid grid-cols-1 gap-4 lg:grid-cols-2", className)}>
        <Skeleton className="h-[180px]" />
        <Skeleton className="h-[180px]" />
      </div>
    );
  }

  if (meters === null) {
    return (
      <EmptyState
        className={className}
        icon={<Newspaper className="size-6" strokeWidth={1.8} />}
        title="No manager on this team"
        description="Relationship meters follow the manager who claimed the team."
      />
    );
  }

  const writers = [...meters.writers].sort((a, b) => Math.abs(b.score) - Math.abs(a.score));
  const hasHistory = writers.some((w) => w.eventCount > 0 || w.score !== 0);

  if (!hasHistory) {
    return (
      <EmptyState
        className={className}
        icon={<Newspaper className="size-6" strokeWidth={1.8} />}
        title="No history yet"
        description={`The desk hasn't written about ${meters.teamName} yet.`}
      />
    );
  }

  return (
    <div className={cn("flex flex-col gap-4", className)}>
      <span className="bc-label-sm text-bc-text-3">
        {meters.managerName} &middot; {meters.teamName}
      </span>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {writers.map((writer) => (
          <RelationshipMeter
            key={writer.persona}
            persona={writer.persona}
            score={writer.score}
            tier={writer.tier}
            events={writer.recentEvents}
          />
        ))}
      </div>
    </div>
  );
}
