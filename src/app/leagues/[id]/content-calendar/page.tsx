"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useQuery } from "convex/react";
import { CalendarOff, CreditCard } from "lucide-react";

import { api } from "../../../../../convex/_generated/api";
import { Id } from "../../../../../convex/_generated/dataModel";
import { PageHeader, Panel, LoadingScreen, EmptyState } from "@/components/broadcast";
import {
  UpNextStrip,
  WeekSection,
  UndatedSection,
  allCalendarEntries,
  type ContentCalendarResult,
} from "@/components/content-calendar";

export default function ContentCalendarPage() {
  const params = useParams();
  const leagueId = params.id as Id<"leagues">;

  // Role isn't gated here — any league member may read the calendar (owner ask) — but we
  // still load the league the way every other league page does, so a bad/foreign id behaves
  // the same way it does everywhere else.
  const league = useQuery(api.leagues.getById, { id: leagueId });
  const calendar: ContentCalendarResult | null | undefined = useQuery(
    api.contentCalendar.getContentCalendar,
    { leagueId }
  );

  if (league === undefined || calendar === undefined) {
    return (
      <div className="min-h-screen bg-bc-ground">
        <LoadingScreen message="Loading the calendar" />
      </div>
    );
  }

  if (!league || !calendar) {
    return (
      <div className="min-h-screen bg-bc-ground">
        <div className="mx-auto max-w-4xl px-4 py-16 sm:px-6 lg:px-12">
          <EmptyState
            icon={<CalendarOff className="size-6" strokeWidth={1.8} />}
            title="Calendar not available"
            description="This league doesn't exist, or you don't have access to it."
          />
        </div>
      </div>
    );
  }

  const now = Date.now();

  const upNext = allCalendarEntries(calendar)
    .filter((entry) => entry.at !== null && entry.at > now)
    .sort((a, b) => (a.at as number) - (b.at as number))
    .slice(0, 3);

  return (
    <div className="min-h-screen bg-bc-ground">
      <div className="mx-auto flex max-w-6xl flex-col gap-8 px-4 py-10 sm:px-6 sm:py-12 lg:px-12">
        <PageHeader
          kicker="League Pass programming"
          title="Content calendar"
          description="Everything below is already included in your League Pass. Generating one of these stories yourself still costs credits, so check here first."
        />

        {!calendar.contentEnabled && (
          <Panel padding="md" className="border-l-4 border-l-bc-red-deep bg-bc-red-deep/10">
            <div className="flex flex-col gap-2">
              <span className="font-display text-[15px] font-bold uppercase tracking-[0.01em] text-bc-red-text">
                Automatic programming is off for this league
              </span>
              <p className="text-sm text-bc-text-2">
                Nothing on this calendar will print on its own until it&apos;s turned back on.{" "}
                <Link
                  href={`/leagues/${leagueId}/content-schedules`}
                  className="font-semibold text-bc-red-text underline underline-offset-2 hover:text-bc-ink"
                >
                  Commissioners can turn it back on from content schedules.
                </Link>
              </p>
            </div>
          </Panel>
        )}

        {!calendar.passActive && (
          <Panel padding="md" className="border-l-4 border-l-bc-red-deep bg-bc-red-deep/10">
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2 text-bc-red-text">
                <CreditCard className="size-4 flex-none" strokeWidth={1.8} />
                <span className="font-display text-[15px] font-bold uppercase tracking-[0.01em]">
                  League Pass isn&apos;t active
                </span>
              </div>
              <p className="text-sm text-bc-text-2">
                Without an active pass, every story below still costs credits to generate.{" "}
                <Link
                  href={`/leagues/${leagueId}/settings#pass`}
                  className="font-semibold text-bc-red-text underline underline-offset-2 hover:text-bc-ink"
                >
                  Check the League Pass in settings.
                </Link>
              </p>
            </div>
          </Panel>
        )}

        <UpNextStrip entries={upNext} timeZone={calendar.timezone} />

        <div className="flex flex-col gap-4">
          {calendar.weeks.length === 0 ? (
            <Panel padding="md">
              <p className="text-[14px] text-bc-text-2">
                No programming weeks are set up yet for the {calendar.season} season.
              </p>
            </Panel>
          ) : (
            calendar.weeks.map((week) => {
              const isPast =
                calendar.currentWeek != null ? week.week < calendar.currentWeek : week.end < now;
              return (
                <WeekSection
                  key={week.week}
                  week={week}
                  timeZone={calendar.timezone}
                  isCurrent={week.week === calendar.currentWeek}
                  defaultOpen={!isPast}
                />
              );
            })
          )}
        </div>

        <UndatedSection entries={calendar.undated} timeZone={calendar.timezone} />
      </div>
    </div>
  );
}
