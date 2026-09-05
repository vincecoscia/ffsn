"use client";

import type { ReactNode } from "react";

import { Panel, PersonaAvatar, personaName, personaRole } from "@/components/broadcast";
import { useNow } from "@/components/useNow";
import { cn } from "@/lib/utils";
import { WireTagChip } from "./WireTagChip";

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/**
 * "4m ago" while fresh, then "Sun 4:25 PM" through the week, then "Sep 5" once it's older than
 * that (spec deliverable #1). Exported so `WirePanel.tsx`'s compact rows use the same rule.
 */
export function formatWireTime(createdAt: number, now: number): string {
  const diffMs = Math.max(0, now - createdAt);
  if (diffMs < MINUTE_MS) return "Just now";
  if (diffMs < 60 * MINUTE_MS) return `${Math.floor(diffMs / MINUTE_MS)}m ago`;
  if (diffMs < 7 * DAY_MS) {
    return new Date(createdAt).toLocaleString("en-US", {
      weekday: "short",
      hour: "numeric",
      minute: "2-digit",
    });
  }
  return new Date(createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** "ESPN" / "Sleeper" from a source's `type`, or `null` when the source can't be labeled. */
function sourceLabel(type: string): string | null {
  if (type.startsWith("espn")) return "ESPN";
  if (type === "sleeper") return "Sleeper";
  return null;
}

export interface WirePostCardProps {
  persona: string;
  text: string;
  /** Wire tags as plain strings — see `useLeagueWire.ts`. */
  tags: string[];
  createdAt: number;
  /** Only global posts carry a status; `"take_pending"` renders the "…is on it" line. */
  status?: string;
  source?: { type: string; url?: string };
  /** Nested overlay blocks for a global post — rendered beneath the text. */
  children?: ReactNode;
  className?: string;
}

/**
 * One Wire post: writer bust, name/role, relative time, tag chips, the text, an optional source
 * link, and (for a global post whose take is still being written) a muted "…is on it" line.
 */
export function WirePost({
  persona,
  text,
  tags,
  createdAt,
  status,
  source,
  children,
  className,
}: WirePostCardProps) {
  const now = useNow(30_000);
  const firstName = personaName(persona).split(" ")[0];
  const label = source ? sourceLabel(source.type) : null;

  return (
    <Panel padding="md" className={cn("flex flex-col gap-3", className)}>
      <div className="flex min-w-0 items-start gap-3">
        <PersonaAvatar persona={persona} size={40} className="flex-none" />
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="truncate font-display text-[15px] font-bold uppercase tracking-[0.01em] text-bc-ink">
              {personaName(persona)}
            </span>
            <span className="bc-label-sm truncate text-bc-text-3">{personaRole(persona)}</span>
            <span className="bc-label-sm flex-none text-bc-text-3" aria-hidden="true">
              &middot;
            </span>
            <span className="bc-label-sm flex-none text-bc-text-3">{formatWireTime(createdAt, now)}</span>
          </div>
          {tags.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {tags.map((tag) => (
                <WireTagChip key={tag} tag={tag} />
              ))}
            </div>
          )}
        </div>
      </div>

      <p className="min-w-0 text-[15px] leading-relaxed text-bc-ink">{text}</p>

      {status === "take_pending" && (
        <p className="bc-label-sm text-bc-text-3">{firstName} is on it&hellip;</p>
      )}

      {label &&
        (source?.url ? (
          <a
            href={source.url}
            target="_blank"
            rel="noopener noreferrer"
            className="w-fit text-[13px] font-semibold text-bc-text-3 underline decoration-bc-hairline underline-offset-2 transition-colors hover:text-bc-red-text"
          >
            {label}
          </a>
        ) : (
          <span className="w-fit text-[13px] font-semibold text-bc-text-3">{label}</span>
        ))}

      {children}
    </Panel>
  );
}
