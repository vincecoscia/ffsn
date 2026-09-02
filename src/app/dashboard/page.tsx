"use client";

import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { CreateLeagueForm } from "@/components/create-league-form";
import { LeagueCard } from "@/components/league-card";
import Link from "next/link";
import { useAuthSync } from "@/hooks/use-auth-sync";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader, Panel, EmptyState, SegmentSlate, Chip } from "@/components/broadcast";
import { Zap } from "lucide-react";

export default function Dashboard() {
  const leagues = useQuery(api.leagues.getByUser);
  const { isLoaded } = useAuthSync();

  if (!isLoaded || leagues === undefined) {
    return (
      <div className="min-h-screen bg-bc-ground">
        <main className="mx-auto max-w-7xl px-4 py-8 pb-24 sm:px-6 lg:px-12">
          <div className="mb-10 flex flex-col gap-3.5">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-12 w-72" />
            <Skeleton className="h-5 w-96 max-w-full" />
          </div>

          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="flex flex-col gap-5 border border-bc-hairline bg-bc-panel p-6">
                <div className="flex flex-col gap-2.5">
                  <Skeleton className="h-6 w-40" />
                  <Skeleton className="h-5 w-56" />
                </div>
                <div className="flex items-center justify-between gap-4 border-t border-bc-hairline pt-4">
                  <Skeleton className="h-9 w-24" />
                  <Skeleton className="h-6 w-16" />
                </div>
                <Skeleton className="h-9 w-full" />
              </div>
            ))}
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-bc-ground">
      <main className="mx-auto max-w-7xl px-4 py-8 pb-28 sm:px-6 sm:pb-8 lg:px-12">
        <PageHeader
          kicker="Front office"
          title="Your leagues"
          description="Manage your fantasy football leagues and the AI-generated content that runs on them."
          actions={
            leagues.length > 0 ? (
              <div className="hidden sm:block">
                <CreateLeagueForm />
              </div>
            ) : undefined
          }
        />

        <div className="mt-10">
          {leagues.length === 0 ? (
            <div className="mx-auto max-w-2xl">
              <EmptyState
                icon={<Zap className="size-6" strokeWidth={1.8} />}
                title="Ready to get started?"
                description="Create your first league to unlock AI-powered fantasy football content: recaps, power rankings, trade analysis and more, written by FFSN's on-air talent."
                action={
                  <div className="flex w-full flex-col gap-2.5 pt-2">
                    <SegmentSlate code="Step 01" label="Import teams — connect your ESPN league and sync every team" />
                    <SegmentSlate code="Step 02" label="Generate content — weekly recaps, power rankings, trade analysis" />
                    <SegmentSlate code="Step 03" label="Share stories — publish AI-written stories for your whole league" />
                    <div className="pt-2">
                      <CreateLeagueForm />
                    </div>
                  </div>
                }
              />
            </div>
          ) : (
            <div className="flex flex-col gap-6">
              <div className="flex items-center gap-3 border-b-2 border-bc-hairline pb-3.5">
                <span className="bc-h-title">
                  {leagues.length} league{leagues.length !== 1 ? "s" : ""}
                </span>
                <Chip variant="win" live>
                  Active
                </Chip>
              </div>

              <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
                {leagues.map((league) => (
                  <LeagueCard key={league._id} league={league} />
                ))}
              </div>
            </div>
          )}
        </div>
      </main>

      {/* Mobile bottom action bar */}
      <div className="fixed inset-x-0 bottom-0 z-40 border-t border-bc-hairline bg-bc-panel sm:hidden">
        <Panel padding="none" className="flex items-center gap-3 border-0 px-4 py-3">
          <Button asChild className="flex-1">
            <Link href="/setup">Create league</Link>
          </Button>
          <Button asChild variant="secondary" className="flex-1">
            <Link href="/dashboard/credits">Buy credits</Link>
          </Button>
        </Panel>
      </div>
    </div>
  );
}
