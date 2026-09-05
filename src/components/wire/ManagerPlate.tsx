import type { ReactNode } from "react";

import { TeamTile } from "@/components/broadcast";
import { cn } from "@/lib/utils";
import type { WireAuthorRefView } from "./useLeagueWire";

function initialsFor(name: string, abbreviation?: string): string {
  if (abbreviation) return abbreviation.slice(0, 3).toUpperCase();
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? "")
    .join("");
  return initials || "FF";
}

export interface ManagerPlateProps {
  author: Pick<WireAuthorRefView, "displayName" | "team">;
  /** Team tile size in px, default 28 (spec §17.2 deliverable #4). */
  size?: number;
  /** Rendered inline after a middot — the post's relative time, same slot the writer plate uses. */
  meta?: ReactNode;
  className?: string;
}

/**
 * A manager's byline on the Wire, in place of a writer's `PersonaAvatar` + name/role: a `TeamTile`
 * (initials or logo) plus the team name and the manager's display name (spec §17.2, §17's
 * deliverable #4). Used on manager root posts, manager replies and writer replies rendered as
 * part of a manager's thread.
 */
export function ManagerPlate({ author, size = 28, meta, className }: ManagerPlateProps) {
  const teamName = author.team?.name ?? "Unclaimed team";
  return (
    <div className={cn("flex min-w-0 items-center gap-3", className)}>
      <TeamTile
        initials={initialsFor(teamName, author.team?.abbreviation)}
        src={author.team?.logo}
        size={size}
        className="flex-none"
      />
      <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="truncate font-display text-[13px] font-bold uppercase tracking-[0.02em] text-bc-ink">
          {teamName}
        </span>
        <span className="bc-label-sm truncate text-bc-text-3">{author.displayName}</span>
        {meta && (
          <>
            <span className="bc-label-sm flex-none text-bc-text-3" aria-hidden="true">
              &middot;
            </span>
            <span className="bc-label-sm flex-none text-bc-text-3">{meta}</span>
          </>
        )}
      </div>
    </div>
  );
}
