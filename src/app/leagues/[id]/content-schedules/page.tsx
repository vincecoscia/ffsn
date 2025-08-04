"use client";

import React from "react";
import { useParams } from "next/navigation";
import { useQuery } from "convex/react";
import { api } from "../../../../../convex/_generated/api";
import { Id } from "../../../../../convex/_generated/dataModel";
import ContentScheduleManager from "../../../../components/ContentScheduleManager";

export default function ContentSchedulesPage() {
  const params = useParams();
  const leagueId = params.id as Id<"leagues">;

  // Get league info to check permissions
  const league = useQuery(api.leagues.getById, { id: leagueId });

  if (!league) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto mb-4"></div>
          <p className="text-slate-600">Loading league...</p>
        </div>
      </div>
    );
  }

  // Only commissioners can access content schedules
  if (league.role !== "commissioner") {
    return (
      <div className="max-w-4xl mx-auto p-6">
        <div className="text-center py-12">
          <div className="text-6xl mb-4">🔒</div>
          <h1 className="text-2xl font-bold text-slate-900 mb-2">
            Commissioner Access Required
          </h1>
          <p className="text-slate-600 mb-6">
            Only league commissioners can manage content schedules.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto p-6">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-slate-900 mb-2">
          Content Schedules
        </h1>
        <p className="text-slate-600">
          Configure when AI content is automatically generated for your league
        </p>
      </div>

      <ContentScheduleManager leagueId={leagueId} />
    </div>
  );
}