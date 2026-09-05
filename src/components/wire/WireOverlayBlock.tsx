import { TeamTile } from "@/components/broadcast";
import { cn } from "@/lib/utils";

const OVERLAY_LABELS: Record<string, string> = {
  owner: "Your league",
  opponent: "Opponent",
  freeAgent: "Waiver watch",
};

function overlayLabel(variant: string): string {
  return OVERLAY_LABELS[variant] ?? "Your league";
}

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

export interface WireOverlayBlockProps {
  team: { name: string; abbreviation?: string; logo?: string };
  /** "owner" | "opponent" | "freeAgent" as a plain string — see `useLeagueWire.ts`. */
  variant: string;
  text: string;
  className?: string;
}

/**
 * One league overlay nested under its global post: a red left rule, the team tile + name, a small
 * label for which variant this is, then the filled-in league-impact text (spec §2, §3.2).
 */
export function WireOverlayBlock({ team, variant, text, className }: WireOverlayBlockProps) {
  return (
    <div className={cn("flex min-w-0 gap-3 border-l-2 border-bc-red pl-3", className)}>
      <TeamTile initials={initialsFor(team.name, team.abbreviation)} src={team.logo} size={28} className="flex-none" />
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate font-display text-[13px] font-bold uppercase tracking-[0.02em] text-bc-ink">
            {team.name}
          </span>
          <span className="bc-label-sm flex-none text-bc-text-3">{overlayLabel(variant)}</span>
        </div>
        <p className="min-w-0 text-[14px] leading-relaxed text-bc-text-2">{text}</p>
      </div>
    </div>
  );
}
