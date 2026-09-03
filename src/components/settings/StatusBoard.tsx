"use client";

import { useQuery } from "convex/react";
import { formatDistanceToNow } from "date-fns";

import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { Panel, SectionHeader, Chip, Spinner } from "@/components/broadcast";
import { useLeagueSeason } from "@/hooks/use-league-season";
import { DEFAULT_TIME_ZONE } from "@/components/content-schedule/timezones";
import { formatPrintTime, nextWeeklyOccurrence } from "@/components/content-schedule/scheduleTime";
import { cn } from "@/lib/utils";

export interface StatusBoardProps {
  leagueId: Id<"leagues">;
  className?: string;
}

interface WeeklyRow {
  dayOfWeek: number;
  hour: number;
  minute: number;
}

interface Tile {
  key: string;
  /** Element id (no `#`) the tile scrolls to on click. */
  anchor: string;
  label: string;
  value: string;
  sublabel?: string;
  attention: boolean;
  loading: boolean;
}

/** Days from now until `timestamp` (negative once it's in the past). */
function daysUntil(timestamp: number): number {
  return Math.ceil((timestamp - Date.now()) / (1000 * 60 * 60 * 24));
}

function scrollToSection(anchor: string) {
  const el = document.getElementById(anchor);
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "start" });
  el.focus({ preventScroll: true });
}

function StatusTile({ tile }: { tile: Tile }) {
  return (
    <button
      type="button"
      onClick={() => scrollToSection(tile.anchor)}
      className={cn(
        "flex flex-col items-start gap-2 border border-bc-hairline bg-bc-ground p-4 text-left transition-colors",
        "hover:border-bc-border-strong"
      )}
    >
      <div className="flex w-full items-center justify-between gap-2">
        <span className="bc-label-sm text-bc-text-3">{tile.label}</span>
        {tile.loading ? (
          <Spinner size={12} />
        ) : (
          tile.attention && <Chip variant="red">Check</Chip>
        )}
      </div>
      <span className="font-display text-[17px] font-bold uppercase leading-tight tracking-[0.01em] text-bc-ink">
        {tile.loading ? "—" : tile.value}
      </span>
      {!tile.loading && tile.sublabel && (
        <span className="text-[13px] leading-snug text-bc-text-2">{tile.sublabel}</span>
      )}
    </button>
  );
}

/**
 * "League at a glance" (spec: settings redesign). Four status tiles reading
 * the same public queries their full sections already use — Programming
 * (`contentScheduling.getContentSchedules`), ESPN (`leagues.getEspnConnection`),
 * League Pass (`leagues.getById` + `leagues.getLeagueCapacity`) and Managers
 * (`teams.getByLeagueAndSeason` + `teamClaims.getByLeague`) — so this board
 * never drifts from what those sections actually show. Each tile smooth-scrolls
 * to its section and flags a red "Check" chip when something needs a decision.
 */
export function StatusBoard({ leagueId, className }: StatusBoardProps) {
  const scheduleData = useQuery(api.contentScheduling.getContentSchedules, { leagueId });
  const connection = useQuery(api.leagues.getEspnConnection, { leagueId });
  const league = useQuery(api.leagues.getById, { id: leagueId });
  const capacity = useQuery(api.leagues.getLeagueCapacity, { leagueId });
  const { currentSeason } = useLeagueSeason(leagueId);
  const teams = useQuery(api.teams.getByLeagueAndSeason, { leagueId, seasonId: currentSeason });
  const teamClaims = useQuery(api.teamClaims.getByLeague, { leagueId, seasonId: currentSeason });

  // --- Programming -----------------------------------------------------
  const programmingLoading = scheduleData === undefined;
  const preferences = scheduleData?.preferences;
  const contentEnabled = preferences?.contentEnabled ?? true;
  const timeZone = preferences?.timezone || DEFAULT_TIME_ZONE;

  const weeklyRows: WeeklyRow[] = (scheduleData?.schedules ?? []).flatMap((schedule) =>
    schedule.enabled && schedule.schedule.type === "weekly"
      ? [
          {
            dayOfWeek: schedule.schedule.dayOfWeek,
            hour: schedule.schedule.hour,
            minute: schedule.schedule.minute,
          },
        ]
      : []
  );

  const nextPrint = weeklyRows
    .map((row) => nextWeeklyOccurrence(timeZone, row.dayOfWeek, row.hour, row.minute))
    .filter((instant): instant is number => instant !== null)
    .sort((a, b) => a - b)[0];

  const programmingTile: Tile = {
    key: "programming",
    anchor: "programming",
    label: "Programming",
    value: contentEnabled ? "On air" : "Off air",
    sublabel: !contentEnabled
      ? "Automatic stories are paused"
      : nextPrint
        ? `Next ${formatPrintTime(nextPrint, timeZone)}`
        : "Nothing scheduled",
    attention: !contentEnabled,
    loading: programmingLoading,
  };

  // --- ESPN --------------------------------------------------------------
  const espnLoading = connection === undefined;
  const expiresAtMs = connection?.credentialExpiresAt;
  const expiryDays = expiresAtMs != null ? daysUntil(expiresAtMs) : null;

  const espnValue = espnLoading
    ? ""
    : !connection.isPrivate && !connection.hasCredentials
      ? "Public league"
      : connection.credentialStatus === "valid"
        ? "Connected"
        : connection.credentialStatus === "invalid"
          ? "Cookies rejected"
          : "Not checked";

  const espnSublabel = espnLoading
    ? undefined
    : connection.credentialStatus === "invalid"
      ? "ESPN rejected the saved cookies"
      : expiryDays != null && expiryDays < 0
        ? "Cookies expired"
        : expiryDays != null && expiryDays <= 14
          ? `Expires in ${expiryDays} day${expiryDays === 1 ? "" : "s"}`
          : connection.lastSyncedAt
            ? `Last synced ${formatDistanceToNow(new Date(connection.lastSyncedAt), { addSuffix: true })}`
            : "Never synced";

  const espnTile: Tile = {
    key: "espn",
    anchor: "espn",
    label: "ESPN",
    value: espnValue,
    sublabel: espnSublabel,
    attention:
      !espnLoading &&
      (connection.credentialStatus === "invalid" ||
        Boolean(connection.contentPausedAt) ||
        (expiryDays != null && expiryDays <= 14)),
    loading: espnLoading,
  };

  // --- League Pass ---------------------------------------------------------
  const passLoading = league === undefined || capacity === undefined;
  const subscription = league?.subscription;
  const isActive = subscription?.status === "active" || subscription?.status === "paid";
  const season = subscription?.seasonId ?? subscription?.seasonYear ?? league?.espnData?.seasonId;
  const included = capacity?.included ?? 0;
  const extraSeats = capacity?.extraSeats ?? 0;
  const managers = capacity?.managers ?? 0;
  const allowance = included + extraSeats;

  const passTile: Tile = {
    key: "pass",
    anchor: "pass",
    label: "League Pass",
    value: passLoading ? "" : isActive ? "Active" : "Not active",
    sublabel: passLoading ? undefined : `${season ?? "—"} · ${managers}/${allowance} accounts`,
    attention: !passLoading && !isActive,
    loading: passLoading,
  };

  // --- Managers ------------------------------------------------------------
  const managersLoading = teams === undefined || teamClaims === undefined;
  const teamsCount = teams?.length ?? 0;
  const claimedCount = (teamClaims ?? []).filter((claim) => claim.status === "active").length;
  const unclaimed = Math.max(teamsCount - claimedCount, 0);

  const managersTile: Tile = {
    key: "managers",
    anchor: "invitations",
    label: "Managers",
    value: managersLoading ? "" : `${claimedCount} of ${teamsCount} claimed`,
    sublabel: managersLoading ? undefined : unclaimed > 0 ? `${unclaimed} to invite` : "All teams claimed",
    attention: !managersLoading && unclaimed > 0,
    loading: managersLoading,
  };

  return (
    <Panel padding="md" className={className}>
      <SectionHeader kicker="Status" title="League at a glance" />
      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatusTile tile={programmingTile} />
        <StatusTile tile={espnTile} />
        <StatusTile tile={passTile} />
        <StatusTile tile={managersTile} />
      </div>
    </Panel>
  );
}
