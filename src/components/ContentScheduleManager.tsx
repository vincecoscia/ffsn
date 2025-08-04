"use client";

import React, { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { Badge } from "./ui/badge";
import { Switch } from "./ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Label } from "./ui/label";
import { Separator } from "./ui/separator";
import { Clock, Settings, Calendar, Zap, BarChart3, FileText, TrendingUp, Users } from "lucide-react";

interface ContentScheduleManagerProps {
  leagueId: Id<"leagues">;
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
    title: "Season Welcome Package",
    description: "Welcome article for newly imported league with history",
    defaultSchedule: "At season start"
  }
};

const PERSONAS = [
  { value: "mel-diaper", label: "Mel Diaper - Bombastic draft expert who's never wrong" },
  { value: "stan-deviation", label: "Stan Deviation - Cold analytics and statistics expert" },
  { value: "vinny-marinara", label: "Vinny \"The Sauce\" Marinara - Mysterious insider with rumors" },
  { value: "chad-thunderhype", label: "Chad Thunderhype - Aggressively positive hype man" },
  { value: "rick-two-beers", label: "Rick \"Two Beers\" O'Sullivan - Bitter rambling ex-husband" },
  { value: "mike-harrison", label: "Mike Harrison - Professional sportswriter with balanced analysis" },
];

const TIMEZONES = [
  { value: "America/New_York", label: "Eastern Time" },
  { value: "America/Chicago", label: "Central Time" },
  { value: "America/Denver", label: "Mountain Time" },
  { value: "America/Los_Angeles", label: "Pacific Time" },
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
  const scheduleData = useQuery(api.contentScheduling.getContentSchedules, { leagueId });
  
  // Mutations
  const updateSchedule = useMutation(api.contentScheduling.updateContentSchedule);
  const updatePreferences = useMutation(api.contentScheduling.updateLeagueContentPreferences);

  const schedules = scheduleData?.schedules || [];
  const preferences = scheduleData?.preferences;

  const handleToggleContent = async (scheduleId: Id<"contentSchedules">, enabled: boolean) => {
    setIsLoading(true);
    try {
      await updateSchedule({ scheduleId, enabled });
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
    contentStyle?: "professional" | "casual" | "humorous" | "analytical";
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
      case "weekly":
        const day = DAYS_OF_WEEK.find(d => d.value === schedule.dayOfWeek)?.label || "Unknown";
        const time = `${(schedule.hour ?? 0).toString().padStart(2, '0')}:${(schedule.minute ?? 0).toString().padStart(2, '0')}`;
        return `${day} at ${time}`;
      case "relative":
        const direction = (schedule.offsetDays ?? 0) < 0 ? "before" : "after";
        const days = Math.abs(schedule.offsetDays ?? 0);
        return `${days} day${days !== 1 ? 's' : ''} ${direction} ${(schedule.relativeTo ?? '').replace('_', ' ')}`;
      case "event_triggered":
        const delay = schedule.delayMinutes ? ` (${schedule.delayMinutes} min delay)` : "";
        return `When ${(schedule.trigger ?? '').replace('_', ' ')}${delay}`;
      case "season_based":
        const seasonDelay = schedule.delayDays ? ` + ${schedule.delayDays} days` : "";
        return `${(schedule.trigger ?? '').replace('_', ' ')}${seasonDelay}`;
      default:
        return "Custom schedule";
    }
  };

  if (!scheduleData) {
    return (
      <div className="flex items-center justify-center p-8">
        <div className="text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto mb-4"></div>
          <p className="text-slate-600">Loading content schedules...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Global Settings */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Settings className="h-5 w-5" />
            Global Content Settings
          </CardTitle>
          <CardDescription>
            Master controls for your league&apos;s scheduled content generation
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="content-enabled" className="text-sm font-medium">
                Enable Scheduled Content
              </Label>
              <p className="text-sm text-slate-600">
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

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <Label htmlFor="timezone">Timezone</Label>
              <Select
                value={preferences?.timezone || "America/New_York"}
                onValueChange={(timezone) => handleUpdateGlobalSettings({ timezone })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TIMEZONES.map((tz) => (
                    <SelectItem key={tz.value} value={tz.value}>
                      {tz.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div>
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
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="approval">Require Approval</SelectItem>  
                  <SelectItem value="auto">Auto-Publish</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="notifications" className="text-sm font-medium">
                Notifications
              </Label>
              <p className="text-sm text-slate-600">
                Get notified when content is generated or fails
              </p>
            </div>
            <div className="space-x-4">
              <Switch
                id="notify-success"
                checked={preferences?.notifyCommissioner ?? true}
                onCheckedChange={(notify) => handleUpdateGlobalSettings({ notifyCommissioner: notify })}
                disabled={isLoading}
              />
              <span className="text-sm">Success</span>
              <Switch
                id="notify-failures"  
                checked={preferences?.notifyFailures ?? true}
                onCheckedChange={(notify) => handleUpdateGlobalSettings({ notifyFailures: notify })}
                disabled={isLoading}
              />
              <span className="text-sm">Failures</span>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Content Type Schedules */}
      <div className="grid gap-4">
        <h3 className="text-lg font-semibold">Content Schedules</h3>
        {Object.entries(CONTENT_TYPE_CONFIG).map(([contentType, config]) => {
          const schedule = schedules.find(s => s.contentType === contentType);
          const IconComponent = config.icon;

          return (
            <Card key={contentType} className={`${!schedule?.enabled ? "opacity-60" : ""}`}>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <IconComponent className="h-5 w-5 text-blue-600" />
                    <div>
                      <CardTitle className="text-base">{config.title}</CardTitle>
                      <CardDescription className="text-sm">
                        {config.description}
                      </CardDescription>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant={schedule?.enabled ? "default" : "secondary"}>
                      {schedule?.enabled ? "Enabled" : "Disabled"}
                    </Badge>
                    <Switch
                      checked={schedule?.enabled ?? false}
                      onCheckedChange={(enabled) => 
                        schedule && handleToggleContent(schedule._id, enabled)
                      }
                      disabled={isLoading || !schedule}
                    />
                  </div>
                </div>
              </CardHeader>
              <CardContent className="pt-0">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <Label className="text-xs text-slate-600 uppercase tracking-wide">Schedule</Label>
                    <p className="text-sm font-medium">
                      {schedule ? formatSchedule(schedule.schedule) : config.defaultSchedule}
                    </p>
                  </div>
                  <div>
                    <Label className="text-xs text-slate-600 uppercase tracking-wide">AI Persona</Label>
                    <Select
                      value={schedule?.preferredPersona || "analyst"}
                      onValueChange={(persona) => 
                        schedule && handleUpdatePersona(schedule._id, persona)
                      }
                      disabled={!schedule?.enabled || isLoading}
                    >
                      <SelectTrigger className="h-8">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {PERSONAS.map((persona) => (
                          <SelectItem key={persona.value} value={persona.value}>
                            {persona.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Credit Usage Info */}
      {preferences && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Credit Usage This Month</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between text-sm">
              <span>Used: {preferences.currentMonthSpent} credits</span>
              {preferences.monthlyContentBudget && (
                <span>Budget: {preferences.monthlyContentBudget} credits</span>
              )}
            </div>
            {preferences.monthlyContentBudget && (
              <div className="w-full bg-slate-200 rounded-full h-2 mt-2">
                <div
                  className="bg-blue-600 h-2 rounded-full"
                  style={{
                    width: `${Math.min(100, (preferences.currentMonthSpent / preferences.monthlyContentBudget) * 100)}%`
                  }}
                />
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}