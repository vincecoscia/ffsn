"use client";

import React, { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Doc, Id } from "../../convex/_generated/dataModel";
import { Switch } from "./ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { RadioGroup, RadioGroupItem } from "./ui/radio-group";
import { Label } from "./ui/label";
import { Separator } from "./ui/separator";
import { Progress } from "./ui/progress";
import { Clock, Settings, Calendar, Zap, BarChart3, FileText, TrendingUp, Users } from "lucide-react";
import {
  Panel,
  SectionHeader,
  Chip,
  PersonaAvatar,
  LoadingScreen,
  writerRoster,
  defaultPersonaFor,
  personasForContentType,
  personaName,
} from "@/components/broadcast";
import { TimezoneSelect } from "./content-schedule/TimezoneSelect";
import { DEFAULT_TIME_ZONE, timeZoneCity } from "./content-schedule/timezones";
import {
  formatWallClock,
  formatWeeklyWallTime,
  timeZoneAbbreviation,
  weeklyUtcClock,
} from "./content-schedule/scheduleTime";
import { cn } from "@/lib/utils";

interface ContentScheduleManagerProps {
  leagueId: Id<"leagues">;
}

/**
 * What `contentScheduling.getContentSchedules` hands back. Named here (rather than
 * inferred) so this screen keeps its types while the generated `api` surface is in flux.
 */
interface ContentScheduleData {
  schedules: Doc<"contentSchedules">[];
  preferences: Doc<"leagueContentPreferences"> | null;
}

const CONTENT_TYPE_CONFIG = {
  weekly_recap: {
    icon: Clock,
    title: "Weekly Recap",
    description: "Comprehensive review of all matchups with commentary",
    defaultSchedule: "Tuesday at 11:00 AM"
  },
  weekly_preview: {
    icon: Calendar,
    title: "Weekly Preview",
    description: "Look-ahead analysis for upcoming matchups and storylines",
    defaultSchedule: "Thursday at 8:00 AM"
  },
  trade_analysis: {
    icon: Zap,
    title: "Trade Analysis",
    description: "Deep dive analysis of completed trades",
    defaultSchedule: "15 minutes after trade"
  },
  power_rankings: {
    icon: BarChart3,
    title: "Power Rankings",
    description: "Weekly rankings with movement and analysis",
    defaultSchedule: "Tuesday at 10:00 AM"
  },
  waiver_wire_report: {
    icon: TrendingUp,
    title: "Waiver Wire Report",
    description: "Top pickup recommendations with statistical backing",
    defaultSchedule: "Wednesday at 3:00 PM"
  },
  bank_statement: {
    icon: TrendingUp,
    title: "The Bank Statement",
    description: "Reggie Banks' weekly results ledger: who cashed in, who's overdrawn",
    defaultSchedule: "Tuesday at 12:00 PM"
  },
  mock_draft: {
    icon: Users,
    title: "Mock Draft",
    description: "Mock draft predictions for what each team will select",
    defaultSchedule: "1 week before draft"
  },
  rivalry_week_special: {
    icon: Zap,
    title: "Rivalry Week Special",
    description: "Hype piece for rivalry matchups",
    defaultSchedule: "When rivalry detected"
  },
  emergency_hot_takes: {
    icon: TrendingUp,
    title: "Emergency Hot Takes",
    description: "Rapid-fire reactions to breaking news and shocking performances",
    defaultSchedule: "When breaking news occurs"
  },
  mid_season_awards: {
    icon: BarChart3,
    title: "Mid-Season Awards",
    description: "Awards ceremony with categories like MVP, Bust, etc.",
    defaultSchedule: "Week 8"
  },
  championship_manifesto: {
    icon: FileText,
    title: "Championship Week Manifesto",
    description: "Epic hype piece for championship matchup",
    defaultSchedule: "Championship week"
  },
  season_recap: {
    icon: FileText,
    title: "Season Recap",
    description: "Comprehensive review of the entire fantasy season",
    defaultSchedule: "After season ends"
  },
  custom_roast: {
    icon: Zap,
    title: "Custom Roast Article",
    description: "Targeted roasting of specific team/manager",
    defaultSchedule: "On demand"
  },
  season_welcome: {
    icon: FileText,
    title: "Season Kickoff",
    description: "Welcome article for newly imported league with history",
    defaultSchedule: "At season start"
  }
};

/**
 * Writers offered for a content type: the roster this type is mapped to first (default
 * first, spec §3), then everyone else still on air. Retired personas never appear.
 */
function personaOptions(contentType: string) {
  const preferred = personasForContentType(contentType);
  const rest = writerRoster.filter(
    (writer) => !preferred.some((candidate) => candidate.slug === writer.slug),
  );
  return [...preferred, ...rest].map((writer) => ({
    value: writer.slug,
    name: writer.name,
    label: `${writer.name} — ${writer.role}`,
  }));
}

/**
 * League-level language rating (owner ask, Sept 2026): the three options a commissioner can
 * pick, in escalating order. Default is "clean" - see `DEFAULT_LANGUAGE_RATING` in
 * `src/lib/ai/language.ts`.
 */
const LANGUAGE_OPTIONS: Array<{ value: "clean" | "salty" | "unfiltered"; label: string; description: string }> = [
  { value: "clean", label: "Clean", description: "No profanity from anyone on the desk." },
  {
    value: "salty",
    label: "Salty",
    description: "Mild only — damn, hell, ass, crap — aimed at a pick or a result, never a person.",
  },
  {
    value: "unfiltered",
    label: "Unfiltered",
    description:
      "Everything short of a slur. Mel and Reggie carry it; the rest of the desk gets one a piece at most. Always at the decision, never the person.",
  },
];

const DAYS_OF_WEEK = [
  { value: 0, label: "Sunday" },
  { value: 1, label: "Monday" },
  { value: 2, label: "Tuesday" },
  { value: 3, label: "Wednesday" },
  { value: 4, label: "Thursday" },
  { value: 5, label: "Friday" },
  { value: 6, label: "Saturday" },
];

export default function ContentScheduleManager({ leagueId }: ContentScheduleManagerProps) {
  const [isLoading, setIsLoading] = useState(false);

  // Queries
  const scheduleData: ContentScheduleData | undefined = useQuery(
    api.contentScheduling.getContentSchedules,
    { leagueId },
  );

  // Mutations
  const updateSchedule = useMutation(api.contentScheduling.updateContentSchedule);
  const updatePreferences = useMutation(api.contentScheduling.updateLeagueContentPreferences);

  const schedules = scheduleData?.schedules || [];
  const preferences = scheduleData?.preferences;
  // One clock for the league; rows keep their own copy but the league preference wins.
  const leagueTimeZone = preferences?.timezone || DEFAULT_TIME_ZONE;
  const leagueZoneAbbreviation = timeZoneAbbreviation(leagueTimeZone);

  const handleToggleContent = async (
    scheduleId: Id<"contentSchedules">,
    contentType: string,
    enabled: boolean,
    currentPersona?: string,
  ) => {
    setIsLoading(true);
    try {
      // Turning a segment on with no writer of its own assigns this type's default from
      // the roster (spec §9.1) rather than leaving the backend to fall back.
      await updateSchedule({
        scheduleId,
        enabled,
        ...(enabled && !currentPersona
          ? { preferredPersona: defaultPersonaFor(contentType) }
          : {}),
      });
    } catch (error) {
      console.error("Failed to update schedule:", error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleUpdatePersona = async (scheduleId: Id<"contentSchedules">, persona: string) => {
    setIsLoading(true);
    try {
      await updateSchedule({ scheduleId, preferredPersona: persona });
    } catch (error) {
      console.error("Failed to update persona:", error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleUpdateGlobalSettings = async (updates: {
    contentEnabled?: boolean;
    timezone?: string;
    monthlyContentBudget?: number;
    notifyCommissioner?: boolean;
    notifyFailures?: boolean;
    preferredPersonas?: string[];
    // contentStyle is deprecated (owner ask, Sept 2026) and no longer surfaced here -
    // languageRating replaces it.
    languageRating?: "clean" | "salty" | "unfiltered";
    autoPublish?: boolean;
    requireApproval?: boolean;
  }) => {
    setIsLoading(true);
    try {
      await updatePreferences({ leagueId, ...updates });
    } catch (error) {
      console.error("Failed to update preferences:", error);
    } finally {
      setIsLoading(false);
    }
  };

  const formatSchedule = (schedule: {
    type: "weekly" | "relative" | "event_triggered" | "season_based";
    dayOfWeek?: number;
    hour?: number;
    minute?: number;
    relativeTo?: string;
    offsetDays?: number;
    trigger?: string;
    delayMinutes?: number;
    delayDays?: number;
  }) => {
    switch (schedule.type) {
      case "weekly": {
        const day = DAYS_OF_WEEK.find(d => d.value === schedule.dayOfWeek)?.label || "Unknown";
        return `${day} at ${formatWallClock(schedule.hour ?? 0, schedule.minute ?? 0)}`;
      }
      case "relative": {
        const direction = (schedule.offsetDays ?? 0) < 0 ? "before" : "after";
        const days = Math.abs(schedule.offsetDays ?? 0);
        return `${days} day${days !== 1 ? 's' : ''} ${direction} ${(schedule.relativeTo ?? '').replace('_', ' ')}`;
      }
      case "event_triggered": {
        const delay = schedule.delayMinutes ? ` (${schedule.delayMinutes} min delay)` : "";
        return `When ${(schedule.trigger ?? '').replace('_', ' ')}${delay}`;
      }
      case "season_based": {
        const seasonDelay = schedule.delayDays ? ` + ${schedule.delayDays} days` : "";
        return `${(schedule.trigger ?? '').replace('_', ' ')}${seasonDelay}`;
      }
      default:
        return "Custom schedule";
    }
  };

  if (!scheduleData) {
    return <LoadingScreen message="Loading content schedules" />;
  }

  return (
    <div className="flex flex-col gap-8">
      {/* Global Settings */}
      <Panel padding="md">
        <SectionHeader
          title={
            <span className="flex items-center gap-2">
              <Settings className="size-4" />
              Global content settings
            </span>
          }
          kicker="Master controls"
        />
        <p className="mt-3 text-sm text-bc-text-2">
          Master controls for your league&apos;s scheduled content generation.
        </p>

        <div className="mt-5 flex flex-col gap-5">
          <div className="flex items-center justify-between gap-4 border border-bc-hairline bg-bc-panel-2 p-4">
            <div>
              <Label htmlFor="content-enabled" className="text-[15px] text-bc-ink">
                Enable scheduled content
              </Label>
              <p className="mt-1 text-sm text-bc-text-2">
                Master switch for all automated content generation
              </p>
            </div>
            <Switch
              id="content-enabled"
              checked={preferences?.contentEnabled ?? true}
              onCheckedChange={(enabled) => handleUpdateGlobalSettings({ contentEnabled: enabled })}
              disabled={isLoading}
            />
          </div>

          <Separator />

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className="flex flex-col gap-2">
              <Label htmlFor="timezone">League timezone</Label>
              <TimezoneSelect
                id="timezone"
                value={leagueTimeZone}
                onChange={(timezone) => handleUpdateGlobalSettings({ timezone })}
                disabled={isLoading}
              />
              <p className="text-[13px] text-bc-text-3">
                Stories print on this clock.
              </p>
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="auto-publish">Publishing</Label>
              <Select
                value={preferences?.autoPublish ? "auto" : "approval"}
                onValueChange={(value) =>
                  handleUpdateGlobalSettings({
                    autoPublish: value === "auto",
                    requireApproval: value === "approval"
                  })
                }
              >
                <SelectTrigger id="auto-publish">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="approval">Require approval</SelectItem>
                  <SelectItem value="auto">Auto-publish</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex flex-col gap-3 border border-bc-hairline bg-bc-panel-2 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <Label className="text-[15px] text-bc-ink">Notifications</Label>
              <p className="mt-1 text-sm text-bc-text-2">
                Get notified when content is generated or fails
              </p>
            </div>
            <div className="flex items-center gap-6">
              <div className="flex items-center gap-2.5">
                <Switch
                  id="notify-success"
                  checked={preferences?.notifyCommissioner ?? true}
                  onCheckedChange={(notify) => handleUpdateGlobalSettings({ notifyCommissioner: notify })}
                  disabled={isLoading}
                />
                <span className="text-sm text-bc-text-2">Success</span>
              </div>
              <div className="flex items-center gap-2.5">
                <Switch
                  id="notify-failures"
                  checked={preferences?.notifyFailures ?? true}
                  onCheckedChange={(notify) => handleUpdateGlobalSettings({ notifyFailures: notify })}
                  disabled={isLoading}
                />
                <span className="text-sm text-bc-text-2">Failures</span>
              </div>
            </div>
          </div>

          <div className="flex flex-col gap-3 border border-bc-hairline bg-bc-panel-2 p-4">
            <Label className="text-[15px] text-bc-ink">Language</Label>
            <RadioGroup
              value={preferences?.languageRating ?? "clean"}
              onValueChange={(value) =>
                handleUpdateGlobalSettings({
                  languageRating: value as "clean" | "salty" | "unfiltered",
                })
              }
              className="grid grid-cols-3 gap-2"
            >
              {LANGUAGE_OPTIONS.map((option) => {
                const selected = (preferences?.languageRating ?? "clean") === option.value;
                return (
                  <div key={option.value} className="flex items-center">
                    <RadioGroupItem
                      value={option.value}
                      id={`language-${option.value}`}
                      className="sr-only"
                    />
                    <Label
                      htmlFor={`language-${option.value}`}
                      className={cn(
                        "flex w-full cursor-pointer items-center justify-center border p-2.5 text-sm font-semibold transition-colors",
                        selected
                          ? "border-bc-red bg-bc-plate text-bc-plate-fg"
                          : "border-bc-hairline bg-bc-panel-2 hover:border-bc-border-strong"
                      )}
                    >
                      {option.label}
                    </Label>
                  </div>
                );
              })}
            </RadioGroup>
            <p className="text-sm text-bc-text-2">
              {LANGUAGE_OPTIONS.find((option) => option.value === (preferences?.languageRating ?? "clean"))?.description}
            </p>
            <p className="text-xs text-bc-text-3">
              Slurs are off the table at every setting, and titles stay clean. Any manager can keep coverage of
              their own team clean from Settings, whatever the league picks.
            </p>
            <p className="text-sm text-bc-text-2">
              Sets how far the desk&apos;s writers can go. Titles and summaries stay clean at
              every level. Team names always print exactly as spelled. Any manager can keep
              coverage of their own team clean from their settings.
            </p>
          </div>
        </div>
      </Panel>

      {/* Content Type Schedules */}
      <Panel padding="none">
        <div className="p-6">
          <SectionHeader title="Content schedules" kicker="Programming" />
        </div>
        <div className="flex flex-col">
          {Object.entries(CONTENT_TYPE_CONFIG).map(([contentType, config]) => {
            const schedule = schedules.find(s => s.contentType === contentType);
            const IconComponent = config.icon;
            const enabled = schedule?.enabled ?? false;
            // A schedule with no writer yet falls back to this type's default (spec §3).
            const personaSlug = schedule?.preferredPersona || defaultPersonaFor(contentType);
            const usesDefaultWriter = !schedule?.preferredPersona;
            const weekly =
              schedule && schedule.schedule.type === "weekly" ? schedule.schedule : null;
            // What the cron will actually fire, resolved through the league clock.
            const utcClock = weekly
              ? weeklyUtcClock(leagueTimeZone, weekly.dayOfWeek, weekly.hour, weekly.minute)
              : null;

            return (
              <div
                key={contentType}
                className={cn(
                  "flex flex-col gap-4 border-t border-bc-hairline px-6 py-5 first:border-t-0",
                  !enabled && "opacity-60"
                )}
              >
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="flex items-start gap-3">
                    <IconComponent className="mt-0.5 size-5 flex-none text-bc-signal" />
                    <div>
                      <div className="font-display text-[17px] font-bold uppercase tracking-[0.01em] text-bc-ink">
                        {config.title}
                      </div>
                      <p className="mt-0.5 text-sm text-bc-text-2">{config.description}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    {enabled && <Chip variant="default" live>On air</Chip>}
                    <Switch
                      checked={enabled}
                      onCheckedChange={(value) =>
                        schedule &&
                        handleToggleContent(
                          schedule._id,
                          contentType,
                          value,
                          schedule.preferredPersona,
                        )
                      }
                      disabled={isLoading || !schedule}
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div className="flex flex-col gap-1.5">
                    <span className="bc-label-sm text-bc-text-3">Cadence</span>
                    <span className="text-sm font-medium text-bc-ink">
                      {schedule ? formatSchedule(schedule.schedule) : config.defaultSchedule}
                    </span>
                    {weekly && (
                      <span className="text-[13px] text-bc-text-3">
                        <span className="bc-num">
                          {formatWeeklyWallTime(weekly.dayOfWeek, weekly.hour, weekly.minute)}
                        </span>{" "}
                        {timeZoneCity(leagueTimeZone)}
                        {leagueZoneAbbreviation ? ` (${leagueZoneAbbreviation})` : ""}
                        {utcClock && (
                          <>
                            {" · "}
                            <span className="bc-num">{utcClock}</span>
                          </>
                        )}
                      </span>
                    )}
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <span className="bc-label-sm text-bc-text-3">Writer</span>
                    <div className="flex items-center gap-2.5">
                      <PersonaAvatar
                        persona={personaName(personaSlug)}
                        size={32}
                        className="flex-none border border-bc-border-strong"
                      />
                      <Select
                        value={personaSlug}
                        onValueChange={(persona) =>
                          schedule && handleUpdatePersona(schedule._id, persona)
                        }
                        disabled={!schedule?.enabled || isLoading}
                      >
                        <SelectTrigger className="h-9 flex-1">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {personaOptions(contentType).map((persona) => (
                            <SelectItem key={persona.value} value={persona.value}>
                              {persona.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <span className="text-[13px] text-bc-text-3">
                      {usesDefaultWriter
                        ? `Default writer: ${personaName(personaSlug)}`
                        : `Assigned to ${personaName(personaSlug)}`}
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </Panel>

      {/* Credit Usage Info */}
      {preferences && (
        <Panel lifted padding="md">
          <span className="bc-label-sm text-bc-text-3">Credit usage this month</span>
          <div className="mt-3 flex items-center justify-between text-sm text-bc-ink">
            <span className="bc-num">{preferences.currentMonthSpent} credits used</span>
            {preferences.monthlyContentBudget && (
              <span className="text-bc-text-2">Budget: {preferences.monthlyContentBudget} credits</span>
            )}
          </div>
          {preferences.monthlyContentBudget && (
            <Progress
              value={Math.min(100, (preferences.currentMonthSpent / preferences.monthlyContentBudget) * 100)}
              className="mt-3"
            />
          )}
        </Panel>
      )}
    </div>
  );
}
