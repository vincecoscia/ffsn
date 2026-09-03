"use client";

import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import { ArrowUpRight, CalendarClock } from "lucide-react";

import { api } from "../../../convex/_generated/api";
import { Doc, Id } from "../../../convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Panel, SectionHeader, Chip, contentTypeLabel } from "@/components/broadcast";
import { cn } from "@/lib/utils";
import { DEFAULT_TIME_ZONE, timeZoneCity } from "./timezones";
import {
  formatPrintTime,
  formatWeeklyWallTime,
  nextWeeklyOccurrence,
  timeZoneAbbreviation,
} from "./scheduleTime";

/**
 * Short names for the weekly staples so the summary line reads like a rundown
 * ("Recap Tue 9:00am · Waivers Wed 12:00pm") instead of four full titles. Anything not
 * listed falls back to the roster's own label, so a new type is never shown as a slug.
 */
const SUMMARY_LABELS: Record<string, string> = {
  weekly_recap: "Recap",
  power_rankings: "Power rankings",
  waiver_wire_report: "Waivers",
  weekly_preview: "Preview",
};

function summaryLabel(contentType: string): string {
  return SUMMARY_LABELS[contentType] ?? contentTypeLabel(contentType);
}

export interface WeeklyContentCardProps {
  leagueId: Id<"leagues">;
  /**
   * Commissioner-only surface: these toggles write league-wide preferences, and the
   * backing mutation rejects anyone else. Render nothing when false.
   */
  canManage: boolean;
  className?: string;
}

/**
 * What `contentScheduling.getContentSchedules` hands back. Named here (rather than
 * inferred) so this card keeps its types while the generated `api` surface is in flux.
 */
interface ContentScheduleData {
  schedules: Doc<"contentSchedules">[];
  preferences: Doc<"leagueContentPreferences"> | null;
}

interface WeeklyRow {
  contentType: string;
  dayOfWeek: number;
  hour: number;
  minute: number;
}

/**
 * "Weekly content is on" (spec §9.3) — the opt-out surface for a league's automatic
 * programming: what prints each week on the league clock, when the next story lands,
 * whether it publishes itself, and a single switch to stop it.
 */
export function WeeklyContentCard({ leagueId, canManage, className }: WeeklyContentCardProps) {
  const [isSaving, setIsSaving] = useState(false);

  const scheduleData: ContentScheduleData | undefined = useQuery(
    api.contentScheduling.getContentSchedules,
    canManage ? { leagueId } : "skip",
  );
  const updatePreferences = useMutation(api.contentScheduling.updateLeagueContentPreferences);

  if (!canManage) return null;

  if (scheduleData === undefined) {
    return (
      <Panel padding="md" className={className}>
        <SectionHeader kicker="Programming" title="Weekly content" />
        <div className="mt-6 flex flex-col gap-3" aria-hidden="true">
          <div className="h-4 w-2/3 animate-pulse bg-bc-panel-2" />
          <div className="h-4 w-1/2 animate-pulse bg-bc-panel-2" />
        </div>
      </Panel>
    );
  }

  const preferences = scheduleData.preferences;
  const schedules = scheduleData.schedules;

  // Spec §9.1 defaults: content on, publishing automatic, Eastern until a zone is captured.
  const contentEnabled = preferences?.contentEnabled ?? true;
  const autoPublish = preferences?.autoPublish ?? true;
  const timeZone = preferences?.timezone || DEFAULT_TIME_ZONE;

  const weeklyRows: WeeklyRow[] = schedules
    .flatMap((schedule) =>
      schedule.enabled && schedule.schedule.type === "weekly"
        ? [
            {
              contentType: schedule.contentType,
              dayOfWeek: schedule.schedule.dayOfWeek,
              hour: schedule.schedule.hour,
              minute: schedule.schedule.minute,
            },
          ]
        : [],
    )
    .sort((a, b) => a.dayOfWeek - b.dayOfWeek || a.hour - b.hour || a.minute - b.minute);

  const otherEnabled = schedules
    .filter((schedule) => schedule.enabled && schedule.schedule.type !== "weekly")
    .map((schedule) => contentTypeLabel(schedule.contentType));

  const nextPrint = weeklyRows
    .map((row) => ({
      row,
      instant: nextWeeklyOccurrence(timeZone, row.dayOfWeek, row.hour, row.minute),
    }))
    .filter((entry): entry is { row: WeeklyRow; instant: number } => entry.instant !== null)
    .sort((a, b) => a.instant - b.instant)[0];

  const zoneAbbreviation = timeZoneAbbreviation(timeZone);

  const save = async (
    updates: { contentEnabled?: boolean; autoPublish?: boolean; requireApproval?: boolean },
    successMessage: string,
  ) => {
    setIsSaving(true);
    try {
      await updatePreferences({ leagueId, ...updates });
      toast.success(successMessage);
    } catch (error) {
      console.error("Failed to update content preferences:", error);
      toast.error("Couldn't save that", {
        description: "Please try again in a moment.",
      });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Panel padding="md" className={className}>
      <SectionHeader
        kicker="Programming"
        title={contentEnabled ? "Weekly content is on" : "Weekly content is off"}
        actions={
          <Chip variant={contentEnabled ? "default" : "outline"} live={contentEnabled}>
            {contentEnabled ? "On air" : "Off air"}
          </Chip>
        }
      />

      <div className="mt-6 flex flex-col gap-5">
        <div className={cn("flex flex-col gap-2", !contentEnabled && "opacity-60")}>
          <span className="bc-label-sm text-bc-text-3">Every week during the season</span>
          {weeklyRows.length > 0 ? (
            <p className="text-[15px] leading-relaxed text-bc-ink">
              {weeklyRows.map((row, index) => (
                <span key={`${row.contentType}-${row.dayOfWeek}-${row.hour}`}>
                  {index > 0 && <span className="text-bc-text-3"> · </span>}
                  {summaryLabel(row.contentType)}{" "}
                  <span className="bc-num">
                    {formatWeeklyWallTime(row.dayOfWeek, row.hour, row.minute)}
                  </span>
                </span>
              ))}
            </p>
          ) : (
            <p className="text-[15px] text-bc-text-2">
              No weekly segments are scheduled yet.
            </p>
          )}
          <p className="text-[13px] text-bc-text-3">
            All times {timeZoneCity(timeZone)}
            {zoneAbbreviation ? ` (${zoneAbbreviation})` : ""}.
          </p>
          <p className="text-[13px] text-bc-text-3">
            Runs from the league's first week through its championship. Nothing prints in the offseason.
          </p>
          {otherEnabled.length > 0 && (
            <p className="text-[13px] text-bc-text-3">
              Also on when it happens: {otherEnabled.join(", ")}.
            </p>
          )}
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-2 border border-bc-hairline bg-bc-ground p-4">
            <span className="bc-label-sm text-bc-text-3">Next print</span>
            <span className="flex items-center gap-2 text-[15px] font-semibold text-bc-ink">
              <CalendarClock className="size-4 flex-none text-bc-signal" aria-hidden="true" />
              {contentEnabled && nextPrint
                ? formatPrintTime(nextPrint.instant, timeZone)
                : "Nothing scheduled"}
            </span>
            {contentEnabled && nextPrint && (
              <span className="text-[13px] text-bc-text-3">
                {contentTypeLabel(nextPrint.row.contentType)}
              </span>
            )}
          </div>

          <div className="flex flex-col gap-2 border border-bc-hairline bg-bc-ground p-4">
            <span className="bc-label-sm text-bc-text-3">Publishing</span>
            <span className="text-[15px] font-semibold text-bc-ink">
              {autoPublish ? "Publishes automatically" : "Held for your review"}
            </span>
            <span className="text-[13px] text-bc-text-3">
              {autoPublish
                ? "Anything the desk flags still waits for you."
                : "Every story lands in your drafts first."}
            </span>
          </div>
        </div>

        <div className="flex flex-col gap-4 border-t border-bc-hairline pt-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <Switch
              id="weekly-content-auto-publish"
              checked={autoPublish}
              disabled={isSaving || !contentEnabled}
              onCheckedChange={(checked) =>
                save(
                  { autoPublish: checked, requireApproval: !checked },
                  checked ? "Stories will publish automatically." : "Stories will wait for your review.",
                )
              }
            />
            <Label htmlFor="weekly-content-auto-publish" className="text-[15px] text-bc-ink">
              Publish without waiting for me
            </Label>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="link"
              size="sm"
              asChild
              className="h-9 px-0 font-sans normal-case tracking-normal"
            >
              <Link href={`/leagues/${leagueId}/content-schedules`}>
                Change what prints
                <ArrowUpRight className="size-4" aria-hidden="true" />
              </Link>
            </Button>
            <Button
              variant={contentEnabled ? "outline" : "default"}
              size="sm"
              disabled={isSaving}
              onClick={() =>
                save(
                  { contentEnabled: !contentEnabled },
                  contentEnabled
                    ? "Weekly content is off. Nothing will print."
                    : "Weekly content is back on.",
                )
              }
            >
              {contentEnabled ? "Turn off" : "Turn on"}
            </Button>
          </div>
        </div>
      </div>
    </Panel>
  );
}

export default WeeklyContentCard;
