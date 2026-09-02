"use client";

import React from "react";
import { Id } from "../../convex/_generated/dataModel";
import { PageHeader } from "@/components/broadcast";
import { LeagueSidebar } from "@/components/league/LeagueSidebar";

interface LeaguePageLayoutProps {
  children: React.ReactNode;
  leagueId: Id<"leagues">;
  currentUserId: string;
  title?: string;
}

/**
 * Shared chrome for league sub-pages: an optional `PageHeader` for `title`,
 * the main content in `children`, and the same right-rail `LeagueSidebar`
 * used on the league home page.
 */
export function LeaguePageLayout({
  children,
  leagueId,
  currentUserId,
  title,
}: LeaguePageLayoutProps) {
  return (
    <div className="grid grid-cols-1 items-start gap-8 lg:grid-cols-[minmax(0,1fr)_300px] xl:grid-cols-[minmax(0,1fr)_340px]">
      <div className="flex min-w-0 flex-col gap-8">
        {title && <PageHeader title={title} />}
        {children}
      </div>

      <LeagueSidebar leagueId={leagueId} currentUserId={currentUserId} />
    </div>
  );
}
