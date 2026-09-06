"use client";

import React, { useState } from "react";
import Link from "next/link";
import { useAuth } from "@clerk/nextjs";
import { useMutation } from "convex/react";

import { api } from "../../../../../convex/_generated/api";
import { Id } from "../../../../../convex/_generated/dataModel";
import { LeaguePageLayout } from "@/components/LeaguePageLayout";
import { LoadingScreen, Panel, SectionHeader } from "@/components/broadcast";
import { Button } from "@/components/ui/button";
import { WireComposer, WireFeed, useLeagueWire } from "@/components/wire";

interface WirePageProps {
  params: Promise<{ id: string }>;
}

/** `/leagues/[id]/wire` — the live desk timeline (spec §2). */
export default function WirePage({ params }: WirePageProps) {
  const resolvedParams = React.use(params);
  const leagueId = resolvedParams.id as Id<"leagues">;
  const { userId } = useAuth();

  const wire = useLeagueWire(leagueId);
  const setWireEnabled = useMutation(api.wire.setWireEnabled);
  const [isEnabling, setIsEnabling] = useState(false);

  if (!userId || wire.status === undefined) {
    return <LoadingScreen message="Loading the Wire" />;
  }

  const status = wire.status;

  const handleEnable = async () => {
    setIsEnabling(true);
    try {
      await setWireEnabled({ leagueId, enabled: true });
    } finally {
      setIsEnabling(false);
    }
  };

  return (
    <LeaguePageLayout leagueId={leagueId} currentUserId={userId} title="The Wire">
      <div className="flex flex-col gap-5">
        {!status.passActive && (
          <Panel padding="md" className="flex flex-col gap-4">
            <SectionHeader kicker="League Pass" title="This league's Wire is off the air" size="sm" />
            <p className="text-[14px] leading-relaxed text-bc-text-2">
              You&apos;re seeing the league-wide feed everyone gets. A League Pass adds this
              league&apos;s own impact under every headline &mdash; who it hits on your roster, who&apos;s the
              add on waivers &mdash; plus waiver, transaction and final posts straight from the desk.
            </p>
            <Button asChild variant="glow" className="w-fit">
              <Link href={`/leagues/${leagueId}/settings#pass`}>See the League Pass</Link>
            </Button>
          </Panel>
        )}

        {status.wireEnabled === false && status.isCommissioner && (
          <Panel padding="sm" className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-[14px] text-bc-text-2">
              The Wire is turned off for this league. New league posts won&apos;t go out until you turn
              it back on.
            </p>
            <Button size="sm" onClick={handleEnable} disabled={isEnabling}>
              {isEnabling ? "Turning on..." : "Turn it on"}
            </Button>
          </Panel>
        )}

        <WireComposer leagueId={leagueId} status={status} />

        <WireFeed
          items={wire.items}
          isLoadingFirstPage={wire.isLoadingFirstPage}
          isLoadingMore={wire.isLoadingMore}
          canLoadMore={wire.canLoadMore}
          onLoadMore={wire.loadMore}
          leagueId={leagueId}
          viewerUserId={userId}
          isCommissioner={status.isCommissioner}
          replyAsTeamName={status.myTeam?.name}
        />
      </div>
    </LeaguePageLayout>
  );
}
