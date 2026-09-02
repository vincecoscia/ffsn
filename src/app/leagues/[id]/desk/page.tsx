"use client";

import React from "react";
import { useQuery } from "convex/react";
import { useAuth } from "@clerk/nextjs";

import { api } from "../../../../../convex/_generated/api";
import { Id } from "../../../../../convex/_generated/dataModel";
import { LeaguePageLayout } from "@/components/LeaguePageLayout";
import { LoadingScreen } from "@/components/broadcast";
import { DeskMetricsClient } from "./DeskMetricsClient";

interface DeskPageProps {
  params: Promise<{ id: string }>;
}

/** `/leagues/[id]/desk` — the commissioner's verifier scorecard (spec §8.7). */
export default function DeskPage({ params }: DeskPageProps) {
  const resolvedParams = React.use(params);
  const leagueId = resolvedParams.id as Id<"leagues">;
  const { userId } = useAuth();

  const league = useQuery(api.leagues.getById, { id: leagueId });

  if (!userId || league === undefined) {
    return <LoadingScreen message="Loading desk metrics" />;
  }

  return (
    <LeaguePageLayout leagueId={leagueId} currentUserId={userId} title="Desk metrics">
      <DeskMetricsClient leagueId={leagueId} isCommissioner={league?.role === "commissioner"} />
    </LeaguePageLayout>
  );
}
