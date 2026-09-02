"use client";

import React from "react";
import { useParams } from "next/navigation";
import { PageHeader, Panel } from "@/components/broadcast";
import { TabbedNotificationList } from "@/components/notifications";
import { Id } from "../../../../../convex/_generated/dataModel";

export default function NotificationsPage() {
  const params = useParams();
  const leagueId = params.id as Id<"leagues">;

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-8">
      <PageHeader
        kicker="League"
        title="Notifications"
        description="Stay up to date with comment requests, article publications, and league updates."
      />

      <Panel padding="md">
        <TabbedNotificationList leagueId={leagueId} />
      </Panel>
    </div>
  );
}
