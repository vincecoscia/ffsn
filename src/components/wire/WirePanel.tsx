"use client";

import Link from "next/link";
import { ChevronRight } from "lucide-react";

import { Panel, PersonaAvatar, SectionHeader, personaName } from "@/components/broadcast";
import { useNow } from "@/components/useNow";
import type { Id } from "../../../convex/_generated/dataModel";
import { formatWireTime } from "./WirePost";
import { WireTagChip } from "./WireTagChip";
import { useLeagueWire } from "./useLeagueWire";

const PANEL_ITEMS = 6;

export interface WirePanelProps {
  leagueId: Id<"leagues">;
  className?: string;
}

/**
 * League homepage's "The Wire" panel: the 6 newest merged posts, compact. Renders nothing while
 * both feeds are still loading their first page, or once loaded, when there's nothing to show
 * (spec deliverable #2).
 */
export function WirePanel({ leagueId, className }: WirePanelProps) {
  const wire = useLeagueWire(leagueId, { pageSize: PANEL_ITEMS });
  const now = useNow(30_000);

  if (wire.isLoadingFirstPage || wire.items.length === 0) return null;

  const items = wire.items.slice(0, PANEL_ITEMS);

  return (
    <Panel padding="md" className={className}>
      <SectionHeader
        title="The Wire"
        actions={
          <Link
            href={`/leagues/${leagueId}/wire`}
            className="bc-label-sm inline-flex items-center gap-1 text-bc-text-3 transition-colors hover:text-bc-red-text"
          >
            Open The Wire
            <ChevronRight className="size-3.5" strokeWidth={2} />
          </Link>
        }
      />
      <div className="mt-4 flex flex-col">
        {items.map((item) => (
          <div
            key={item.post._id}
            className="flex min-w-0 items-center gap-3 border-t border-bc-hairline py-3 first:border-t-0"
          >
            <PersonaAvatar persona={item.post.persona} size={28} className="flex-none" />
            <div className="flex min-w-0 flex-1 flex-col">
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate font-display text-[13px] font-bold uppercase tracking-[0.01em] text-bc-ink">
                  {personaName(item.post.persona)}
                </span>
                <span className="bc-label-sm flex-none text-bc-text-3">
                  {formatWireTime(item.post.createdAt, now)}
                </span>
              </div>
              <p className="truncate text-[13px] text-bc-text-2">{item.post.text}</p>
            </div>
            {item.post.tags[0] && <WireTagChip tag={item.post.tags[0]} className="flex-none" />}
          </div>
        ))}
      </div>
    </Panel>
  );
}
