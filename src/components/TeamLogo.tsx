"use client";

import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import { TeamTile } from "@/components/broadcast";

interface TeamLogoProps {
  teamId: Id<"teams">;
  teamName: string;
  espnLogo?: string;
  customLogo?: Id<"_storage">;
  size?: "sm" | "md" | "lg" | "xl";
  className?: string;
}

const SIZE_PX: Record<NonNullable<TeamLogoProps["size"]>, number> = {
  sm: 32,
  md: 36,
  lg: 64,
  xl: 88,
};

function getInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "??";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

/** Team logo/monogram, rendered through the kit's `TeamTile`: the custom or ESPN logo image when available, an initials tile otherwise. */
export function TeamLogo({
  teamId,
  teamName,
  espnLogo,
  customLogo,
  size = "md",
  className = "",
}: TeamLogoProps) {
  const customLogoUrl = useQuery(
    api.teams.getCustomLogoUrl,
    customLogo ? { teamId } : "skip"
  );

  const src = customLogoUrl || espnLogo || undefined;

  return (
    <TeamTile
      initials={getInitials(teamName)}
      src={src}
      alt={`${teamName} logo`}
      size={SIZE_PX[size]}
      className={className}
    />
  );
}
