"use client";

import { useQuery } from "convex/react";

import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { WriterPlate, writerRoster } from "@/components/broadcast";
import { cn } from "@/lib/utils";

export interface WriterLineupProps {
  /** When given, each card shows how many managers that writer is feuding with / favours. */
  leagueId?: Id<"leagues">;
  className?: string;
}

function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * The on-air lineup: one `WriterPlate` per selectable writer, derived from
 * `personaPrompts` in roster order (spec §3), with the league's relationship
 * standing on each card when a `leagueId` is given.
 */
export function WriterLineup({ leagueId, className }: WriterLineupProps) {
  const matrix = useQuery(
    api.relationships.getLeagueRelationshipMatrix,
    leagueId ? { leagueId } : "skip",
  );

  // Settled predictions per writer (spec §8.4). Open claims aren't a record yet, so
  // they don't show — a writer with nothing called is simply not carrying receipts.
  const records = useQuery(
    api.claims.getWriterRecords,
    leagueId ? { leagueId } : "skip",
  );

  // Keyed by plain slug: the query narrows `persona` to the active-writer union, but
  // the roster is the thing being rendered and it speaks in slugs.
  const recordByPersona = new Map<string, { hits: number; misses: number; open: number }>(
    (records ?? []).map((row) => [row.persona as string, row]),
  );

  const standing = new Map<string, { feuds: number; favorites: number }>();
  for (const row of matrix?.rows ?? []) {
    for (const cell of row.cells) {
      const entry = standing.get(cell.persona) ?? { feuds: 0, favorites: 0 };
      if (cell.tier === "feud") entry.feuds += 1;
      if (cell.tier === "favorite") entry.favorites += 1;
      standing.set(cell.persona, entry);
    }
  }

  return (
    <div
      className={cn(
        "grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3",
        className,
      )}
    >
      {writerRoster.map((writer, index) => {
        const entry = standing.get(writer.slug);
        const record = recordByPersona.get(writer.slug);
        const parts: string[] = [];
        if (record && record.hits + record.misses > 0) {
          parts.push(`Receipts ${record.hits}-${record.misses}`);
        }
        if (entry && entry.feuds > 0) {
          parts.push(`Feuding with ${pluralize(entry.feuds, "manager")}`);
        }
        if (entry && entry.favorites > 0) {
          parts.push(pluralize(entry.favorites, "favorite"));
        }

        return (
          <WriterPlate
            key={writer.slug}
            persona={writer.name}
            index={index + 1}
            role={writer.role}
            tagline={writer.tagline}
            beat={writer.beat}
            footnote={parts.length > 0 ? parts.join(" · ") : undefined}
          />
        );
      })}
    </div>
  );
}
