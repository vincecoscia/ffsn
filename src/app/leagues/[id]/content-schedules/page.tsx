"use client";

import React from "react";
import { useParams } from "next/navigation";
import { useQuery } from "convex/react";
import { Lock } from "lucide-react";
import { api } from "../../../../../convex/_generated/api";
import { Id } from "../../../../../convex/_generated/dataModel";
import ContentScheduleManager from "../../../../components/ContentScheduleManager";
import { PageHeader, LoadingScreen, EmptyState } from "@/components/broadcast";

export default function ContentSchedulesPage() {
  const params = useParams();
  const leagueId = params.id as Id<"leagues">;

  // Get league info to check permissions
  const league = useQuery(api.leagues.getById, { id: leagueId });

  if (!league) {
    return (
      <div className="min-h-screen bg-bc-ground">
        <LoadingScreen message="Loading league" />
      </div>
    );
  }

  // Only commissioners can access content schedules
  if (league.role !== "commissioner") {
    return (
      <div className="min-h-screen bg-bc-ground">
        <div className="mx-auto max-w-4xl px-4 py-16 sm:px-6 lg:px-12">
          <EmptyState
            icon={<Lock className="size-6" strokeWidth={1.8} />}
            title="Commissioner access required"
            description="Only league commissioners can manage content schedules."
          />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-bc-ground">
      <div className="mx-auto flex max-w-6xl flex-col gap-8 px-4 py-10 sm:px-6 sm:py-12 lg:px-12">
        <PageHeader
          kicker="Programming schedule"
          title="Content schedules"
          description="Configure when AI content is automatically generated for your league."
        />

        <ContentScheduleManager leagueId={leagueId} />
      </div>
    </div>
  );
}