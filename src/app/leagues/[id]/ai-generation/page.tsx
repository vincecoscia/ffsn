import React from "react";
import { Id } from "../../../../../convex/_generated/dataModel";
import AIGenerationPage from "../../../../components/AIGenerationPage";

interface AIGenerationProps {
  params: Promise<{ id: string }>;
}

export default function AIGeneration({ params }: AIGenerationProps) {
  const resolvedParams = React.use(params);
  const leagueId = resolvedParams.id as Id<"leagues">;

  return <AIGenerationPage leagueId={leagueId} />;
}