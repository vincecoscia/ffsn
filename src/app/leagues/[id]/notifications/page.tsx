"use client";

import React from "react";
import { useParams } from "next/navigation";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { TabbedNotificationList } from "@/components/notifications";
import { Id } from "../../../../../convex/_generated/dataModel";

export default function NotificationsPage() {
  const params = useParams();
  const leagueId = params.id as Id<"leagues">;

  return (
    <div className="container mx-auto px-4 py-6 max-w-4xl">
      <div className="mb-6">
        <h1 className="text-3xl font-bold text-gray-900 mb-2">Notifications</h1>
        <p className="text-gray-600">
          Stay up to date with comment requests, article publications, and league updates.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Your Notifications</CardTitle>
          <CardDescription>
            Manage and view all your notifications in one place.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <TabbedNotificationList leagueId={leagueId} />
        </CardContent>
      </Card>
    </div>
  );
}