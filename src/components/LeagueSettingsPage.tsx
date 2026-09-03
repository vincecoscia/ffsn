"use client";

import { useState, useRef } from "react";
import Link from "next/link";
import { useMutation } from "convex/react";
import { toast } from "sonner";
import { Pencil, Check, X, Upload, Trash2, Copy, Inbox, Send, ArrowUpRight } from "lucide-react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import { PlayerManagement } from "./PlayerManagement";
import HistoricalRosterManager from "./HistoricalRosterManager";
import { DraftDataViewer } from "./DraftDataViewer";
import { MatchupRefreshManager } from "./MatchupRefreshManager";
import { EspnConnectionCard } from "./EspnConnectionCard";
import { DataProcessingManager } from "./DataProcessingManager";
import { TeamLogo } from "./TeamLogo";
import { useLeagueSeason } from "@/hooks/use-league-season";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageHeader, Panel, SectionHeader, Chip, EmptyState, Spinner } from "@/components/broadcast";
import { WeeklyContentCard } from "./content-schedule/WeeklyContentCard";
import { LeaguePassCard } from "./LeaguePassCard";
import { StatusBoard } from "./settings/StatusBoard";
import { SettingsSection } from "./settings/SettingsSection";
import { SeasonSyncBoard } from "./league/SeasonSyncBoard";
import { cn } from "@/lib/utils";

interface League {
  _id: Id<"leagues">;
  name: string;
  platform: "espn";
  role: "commissioner" | "member";
  settings: {
    scoringType: string;
    rosterSize: number;
    playoffWeeks: number;
    categories: string[];
  };
}

interface Team {
  _id: Id<"teams">;
  name: string;
  abbreviation?: string;
  logo?: string;
  customLogo?: Id<"_storage">;
  owner: string;
}

interface TeamClaim {
  _id: Id<"teamClaims">;
  teamId: Id<"teams">;
  userId: string;
  status: "active" | "pending";
}

interface TeamInvitation {
  _id: Id<"teamInvitations">;
  teamId: Id<"teams">;
  inviteToken: string;
  email?: string;
  teamName: string;
  teamAbbreviation?: string;
  teamLogo?: string;
  status: "pending" | "claimed" | "expired";
  expiresAt: number;
  createdAt: number;
}

interface LeagueSettingsPageProps {
  league: League;
  teams: Team[];
  teamClaims: TeamClaim[];
  teamInvitations: TeamInvitation[];
  currentUserId?: string;
}

function FieldCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-2 border border-bc-hairline bg-bc-ground p-4">
      <span className="bc-label-sm text-bc-text-3">{label}</span>
      <span className="font-sans text-[16px] font-semibold capitalize text-bc-ink">{value}</span>
    </div>
  );
}

const INVITE_STATUS_CHIP: Record<TeamInvitation["status"], { variant: "outline" | "win" | "muted"; label: string }> = {
  pending: { variant: "outline", label: "Pending" },
  claimed: { variant: "win", label: "Claimed" },
  expired: { variant: "muted", label: "Expired" },
};

export function LeagueSettingsPage({
  league,
  teams,
  teamClaims,
  teamInvitations
}: LeagueSettingsPageProps) {
  const [editingLeague, setEditingLeague] = useState(false);
  const [leagueName, setLeagueName] = useState(league.name);
  const [isCreatingInvites, setIsCreatingInvites] = useState(false);
  const [selectedTeamIds, setSelectedTeamIds] = useState<string[]>([]);
  const [emailInputs, setEmailInputs] = useState<{[teamId: string]: string}>({});
  const [uploadingLogoForTeam, setUploadingLogoForTeam] = useState<string | null>(null);
  const [resendingInvitationId, setResendingInvitationId] = useState<string | null>(null);
  const fileInputRefs = useRef<{[teamId: string]: HTMLInputElement | null}>({});

  const createInvitation = useMutation(api.teamInvitations.createInvitation);
  const resendInvitationEmail = useMutation(api.teamInvitations.resendInvitationEmail);
  const generateUploadUrl = useMutation(api.teams.generateUploadUrl);
  const updateCustomLogo = useMutation(api.teams.updateCustomLogo);
  const removeCustomLogo = useMutation(api.teams.removeCustomLogo);
  const { currentSeason } = useLeagueSeason(league._id);

  // Get unclaimed teams
  const unclaimedTeams = teams.filter(team => {
    const isAlreadyClaimed = teamClaims.some(claim => claim.teamId === team._id);
    const hasActiveInvite = teamInvitations.some(invite =>
      invite.teamId === team._id && invite.status === "pending"
    );
    return !isAlreadyClaimed && !hasActiveInvite;
  });

  const handleCreateInvites = async () => {
    if (selectedTeamIds.length === 0) return;

    setIsCreatingInvites(true);
    try {
      const promises = selectedTeamIds.map(teamId =>
        createInvitation({
          leagueId: league._id,
          teamId: teamId as Id<"teams">,
          seasonId: currentSeason,
          email: emailInputs[teamId] || undefined,
        })
      );

      await Promise.all(promises);

      toast.success("Invitations created successfully!", {
        description: `Sent ${promises.length} team invitation${promises.length > 1 ? 's' : ''}.`
      });

      // Reset form
      setSelectedTeamIds([]);
      setEmailInputs({});
    } catch {
      toast.error("Failed to create invitations", {
        description: "Please try again or contact support if the issue persists."
      });
    } finally {
      setIsCreatingInvites(false);
    }
  };

  const copyInviteLink = async (token: string) => {
    const url = `${window.location.origin}/invite/${token}`;
    try {
      await navigator.clipboard.writeText(url);
      toast.success("Invite link copied to clipboard!", {
        description: "The invite link is ready to share."
      });
    } catch {
      toast.error("Failed to copy invite link", {
        description: "Please try again or manually copy the link."
      });
    }
  };

  const handleResendInvitation = async (invitationId: Id<"teamInvitations">) => {
    setResendingInvitationId(invitationId);
    try {
      await resendInvitationEmail({ invitationId });
      toast.success("Invitation email resent");
    } catch (error) {
      toast.error("Failed to resend invitation email", {
        description: error instanceof Error ? error.message : "Please try again or contact support.",
      });
    } finally {
      setResendingInvitationId(null);
    }
  };

  const isTeamSelected = (teamId: string) => selectedTeamIds.includes(teamId);

  const toggleTeamSelection = (teamId: string) => {
    if (isTeamSelected(teamId)) {
      setSelectedTeamIds(prev => prev.filter(id => id !== teamId));
      setEmailInputs(prev => {
        const newInputs = { ...prev };
        delete newInputs[teamId];
        return newInputs;
      });
    } else {
      setSelectedTeamIds(prev => [...prev, teamId]);
    }
  };

  const handleLogoUpload = async (teamId: string, file: File) => {
    if (!file || !file.type.startsWith('image/')) {
      toast.error("Please select a valid image file");
      return;
    }

    if (file.size > 5 * 1024 * 1024) { // 5MB limit
      toast.error("Image size must be less than 5MB");
      return;
    }

    setUploadingLogoForTeam(teamId);
    try {
      // Get upload URL
      const uploadUrl = await generateUploadUrl();

      // Upload the file
      const result = await fetch(uploadUrl, {
        method: "POST",
        headers: { "Content-Type": file.type },
        body: file,
      });

      if (!result.ok) {
        throw new Error("Failed to upload image");
      }

      const { storageId } = await result.json();

      // Update team with custom logo
      await updateCustomLogo({
        teamId: teamId as Id<"teams">,
        storageId,
      });

      toast.success("Logo uploaded successfully!");

      // Clear the file input
      if (fileInputRefs.current[teamId]) {
        fileInputRefs.current[teamId]!.value = "";
      }
    } catch (error) {
      console.error("Error uploading logo:", error);
      toast.error("Failed to upload logo");
    } finally {
      setUploadingLogoForTeam(null);
    }
  };

  const handleRemoveCustomLogo = async (teamId: string) => {
    try {
      await removeCustomLogo({ teamId: teamId as Id<"teams"> });
      toast.success("Custom logo removed");
    } catch (error) {
      console.error("Error removing logo:", error);
      toast.error("Failed to remove logo");
    }
  };

  const isCommissioner = league.role === "commissioner";

  return (
    <div className="min-h-screen bg-bc-ground">
      <div className="mx-auto flex max-w-6xl flex-col gap-12 px-4 py-10 sm:px-6 sm:py-12 lg:px-12">
        <PageHeader
          kicker="Control room"
          title="League settings"
          description="Most of this runs itself. Status first; controls only where you need to decide something."
        />

        {/* Status board — one place to see whether anything below needs a decision. */}
        <StatusBoard leagueId={league._id} />

        {/* Programming: automatic weekly content, the opt-out surface (spec §9.3). */}
        <SettingsSection id="programming">
          <WeeklyContentCard leagueId={league._id} canManage={isCommissioner} />
          <Link
            href={`/leagues/${league._id}/content-schedules`}
            className="inline-flex w-fit items-center gap-1.5 text-sm font-semibold text-bc-text-2 transition-colors hover:text-bc-ink"
          >
            Customize the calendar &mdash; per-story days, times and writers
            <ArrowUpRight className="size-3.5" aria-hidden="true" />
          </Link>
        </SettingsSection>

        {/* ESPN connection: credential status, plus the routine "sync now" action. */}
        <SettingsSection id="espn">
          <EspnConnectionCard leagueId={league._id} isCommissioner={isCommissioner} />
          <Panel lifted padding="sm">
            <SectionHeader title="Sync now" kicker="ESPN sync" size="sm" />
            <p className="mt-2 text-sm leading-relaxed text-bc-text-2">
              Pulls the current season&apos;s teams, rosters, matchups, scores and recent
              transactions. The automatic sync (every 4 hours, and before every story) does the
              same, plus the full transaction log for the current and previous week &mdash; use
              this if something looks stale right now.
            </p>
            <div className="mt-5">
              <MatchupRefreshManager leagueId={league._id} mode="simple" />
            </div>
          </Panel>
        </SettingsSection>

        {/* Per-season sync status (ESPN refresh audit, Sept 2026, section 5.v): what's actually
            been pulled for each season, replacing the "Automatic:" claims below with the truth. */}
        <SettingsSection id="season-sync">
          <SeasonSyncBoard leagueId={league._id} isCommissioner={isCommissioner} />
        </SettingsSection>

        {/* Managers & invites — id kept as "invitations": LeaguePassCard scrolls here. */}
        <SettingsSection
          id="invitations"
          title="Managers & invites"
          kicker="Rostering"
          actions={<span className="bc-label-sm text-bc-text-3">{currentSeason} season</span>}
        >
          {/* Create new invitations */}
          {unclaimedTeams.length > 0 && (
            <div className="flex flex-col gap-4">
              <span className="bc-label text-bc-text-2">Create new invitations</span>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {unclaimedTeams.map((team) => (
                  <button
                    type="button"
                    key={team._id}
                    onClick={() => toggleTeamSelection(team._id)}
                    className={cn(
                      "flex flex-col gap-3 border p-4 text-left transition-colors",
                      isTeamSelected(team._id)
                        ? "border-bc-red bg-bc-red/10"
                        : "border-bc-hairline bg-bc-panel-2 hover:border-bc-border-strong"
                    )}
                  >
                    <div className="flex items-center gap-3">
                      <TeamLogo
                        teamId={team._id}
                        teamName={team.name}
                        espnLogo={team.logo}
                        customLogo={team.customLogo}
                        size="sm"
                      />
                      <div className="min-w-0">
                        <div className="truncate font-display text-[16px] font-bold uppercase tracking-[0.01em] text-bc-ink">
                          {team.name}
                        </div>
                        <div className="bc-label-sm text-bc-text-3">{team.abbreviation}</div>
                      </div>
                    </div>

                    {isTeamSelected(team._id) && (
                      <Input
                        type="email"
                        placeholder="Optional: enter email"
                        value={emailInputs[team._id] || ""}
                        onChange={(e) => {
                          e.stopPropagation();
                          setEmailInputs(prev => ({
                            ...prev,
                            [team._id]: e.target.value
                          }));
                        }}
                        onClick={(e) => e.stopPropagation()}
                        className="text-sm"
                      />
                    )}
                  </button>
                ))}
              </div>

              {selectedTeamIds.length > 0 && (
                <div className="flex items-center justify-between border-t border-bc-hairline pt-4">
                  <span className="bc-label-sm text-bc-text-3">
                    {selectedTeamIds.length} team{selectedTeamIds.length !== 1 ? "s" : ""} selected
                  </span>
                  <Button onClick={handleCreateInvites} disabled={isCreatingInvites}>
                    {isCreatingInvites && <Spinner size={14} className="[&>span]:bg-white" />}
                    {isCreatingInvites ? "Creating" : "Create invitations"}
                  </Button>
                </div>
              )}
            </div>
          )}

          {/* Existing invitations */}
          <div className="flex flex-col gap-4">
            <span className="bc-label text-bc-text-2">Existing invitations</span>
            {teamInvitations.length === 0 ? (
              <EmptyState
                icon={<Inbox className="size-6" strokeWidth={1.8} />}
                title="No invitations sent yet"
                description="Invite team owners to claim their roster for this season."
              />
            ) : (
              <div className="flex flex-col gap-3">
                {teamInvitations.map((invitation) => {
                  const chip = INVITE_STATUS_CHIP[invitation.status];
                  const isResending = resendingInvitationId === invitation._id;
                  return (
                    <Panel key={invitation._id} lifted padding="sm" className="flex flex-wrap items-center justify-between gap-4">
                      <div className="flex items-center gap-4">
                        {invitation.teamLogo && (
                          <img
                            src={invitation.teamLogo}
                            alt={`${invitation.teamName} logo`}
                            className="size-10 border border-bc-border-strong object-cover"
                          />
                        )}
                        <div>
                          <div className="font-display text-[17px] font-bold uppercase tracking-[0.01em] text-bc-ink">
                            {invitation.teamName}
                          </div>
                          <div className="text-sm text-bc-text-2">
                            {invitation.email ? <>Sent to: {invitation.email}</> : "No email specified"}
                          </div>
                          <div className="bc-label-sm text-bc-text-3">
                            Created {new Date(invitation.createdAt).toLocaleDateString()}
                            {invitation.status === "pending" && (
                              <> &middot; Expires {new Date(invitation.expiresAt).toLocaleDateString()}</>
                            )}
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center gap-3">
                        <Chip variant={chip.variant}>{chip.label}</Chip>
                        {invitation.status === "pending" && (
                          <>
                            {invitation.email && (
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => handleResendInvitation(invitation._id)}
                                disabled={isResending}
                              >
                                {isResending ? <Spinner size={14} /> : <Send className="size-3.5" />}
                                {isResending ? "Sending" : "Resend email"}
                              </Button>
                            )}
                            <Button size="sm" variant="outline" onClick={() => copyInviteLink(invitation.inviteToken)}>
                              <Copy className="size-3.5" />
                              Copy link
                            </Button>
                          </>
                        )}
                      </div>
                    </Panel>
                  );
                })}
              </div>
            )}
          </div>
        </SettingsSection>

        {/* League Pass, manager capacity and $10 seats (spec §10.1). */}
        <SettingsSection id="pass">
          <LeaguePassCard leagueId={league._id} canManage={isCommissioner} />
        </SettingsSection>

        {/* League details — name, scoring/roster fields, team logos. Rarely touched
            after setup, so it starts closed. */}
        <SettingsSection id="details" title="League details" kicker="Basics" collapsible defaultOpen={false}>
          <Panel lifted padding="md">
            <SectionHeader title="League info" size="sm" />
            <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2">
              <div className="flex flex-col gap-2">
                <span className="bc-label-sm text-bc-text-3">League name</span>
                {editingLeague ? (
                  <div className="flex gap-2">
                    <Input
                      value={leagueName}
                      onChange={(e) => setLeagueName(e.target.value)}
                      className="flex-1"
                    />
                    <Button
                      size="icon-sm"
                      aria-label="Save league name"
                      onClick={() => {
                        // TODO: Implement league name update
                        setEditingLeague(false);
                      }}
                    >
                      <Check className="size-4" />
                    </Button>
                    <Button
                      size="icon-sm"
                      variant="outline"
                      aria-label="Cancel"
                      onClick={() => {
                        setLeagueName(league.name);
                        setEditingLeague(false);
                      }}
                    >
                      <X className="size-4" />
                    </Button>
                  </div>
                ) : (
                  <div className="flex items-center justify-between gap-3 border border-bc-hairline bg-bc-ground px-4 py-3">
                    <span className="font-sans text-[16px] font-semibold text-bc-ink">{league.name}</span>
                    <Button variant="ghost" size="sm" onClick={() => setEditingLeague(true)}>
                      <Pencil className="size-3.5" />
                      Edit
                    </Button>
                  </div>
                )}
              </div>
              <FieldCard label="Platform" value={league.platform} />
              <FieldCard label="Scoring type" value={league.settings.scoringType} />
              <FieldCard label="Roster size" value={String(league.settings.rosterSize)} />
            </div>
          </Panel>

          <Panel lifted padding="md">
            <SectionHeader
              title="Team logos"
              kicker="Branding"
              size="sm"
              actions={
                <span className="bc-label-sm max-w-xs text-right text-bc-text-3">
                  ESPN&apos;s new logo restrictions block some logos from loading &mdash; upload a custom one here.
                </span>
              }
            />
            <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {teams.map((team) => {
                const teamClaim = teamClaims.find(claim => claim.teamId === team._id);
                const canManageLogo = isCommissioner || teamClaim?.status === "active";
                const inputId = `logo-upload-${team._id}`;

                return (
                  <Panel key={team._id} padding="sm" className="flex flex-col gap-3">
                    <div className="flex items-center gap-3">
                      <div className="relative flex-none">
                        <TeamLogo
                          teamId={team._id}
                          teamName={team.name}
                          espnLogo={team.logo}
                          customLogo={team.customLogo}
                          size="md"
                        />
                        {team.customLogo && (
                          <span className="absolute -right-1 -top-1 size-3 border border-bc-win bg-bc-win" aria-hidden="true" />
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-display text-[17px] font-bold uppercase tracking-[0.01em] text-bc-ink">
                          {team.name}
                        </div>
                        <div className="bc-label-sm text-bc-text-3">{team.abbreviation}</div>
                      </div>
                    </div>

                    {canManageLogo ? (
                      <div className="flex flex-col gap-2">
                        <input
                          ref={el => {fileInputRefs.current[team._id] = el}}
                          type="file"
                          accept="image/*"
                          onChange={(e) => {
                            const file = e.target.files?.[0];
                            if (file) {
                              handleLogoUpload(team._id, file);
                            }
                          }}
                          className="hidden"
                          id={inputId}
                        />
                        <label
                          htmlFor={inputId}
                          className={cn(
                            "inline-flex h-9 w-full cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap bc-cut-sm border border-bc-red bg-bc-red font-display text-[15px] font-bold uppercase tracking-[0.08em] text-white transition-colors hover:bg-[#A81214]",
                            uploadingLogoForTeam === team._id && "pointer-events-none opacity-60"
                          )}
                        >
                          {uploadingLogoForTeam === team._id ? (
                            <>
                              <Spinner size={14} className="[&>span]:bg-white" />
                              Uploading
                            </>
                          ) : (
                            <>
                              <Upload className="size-3.5" />
                              Upload logo
                            </>
                          )}
                        </label>
                        {team.customLogo && (
                          <Button
                            variant="outline"
                            size="sm"
                            className="w-full"
                            onClick={() => handleRemoveCustomLogo(team._id)}
                          >
                            <Trash2 className="size-3.5" />
                            Remove custom logo
                          </Button>
                        )}
                      </div>
                    ) : (
                      <div className="bc-label-sm text-center text-bc-text-3">
                        {teamClaim ? "Claimed by user" : "Not your team"}
                      </div>
                    )}
                  </Panel>
                );
              })}
            </div>
          </Panel>
        </SettingsSection>

        {/* Advanced tools — manual overrides for what already runs on its own. Closed
            by default so these queries don't run until a commissioner opens it. */}
        <SettingsSection
          id="advanced"
          title="Advanced tools"
          kicker="Maintenance"
          collapsible
          defaultOpen={false}
          description="The season sync board above shows exactly what's been pulled and when, for every season. These are manual rebuilds — use them only if something looks wrong or support asks."
        >
          <Panel lifted padding="md">
            <SectionHeader title="Full re-import" kicker="ESPN sync" size="sm" />
            <p className="mt-2 text-sm text-bc-text-2">
              Manual rebuild. The automatic sync only ever touches the current season &mdash; a
              past season&apos;s teams, rosters and matchups never refresh on their own. Use this
              to pull any season from scratch.
            </p>
            <div className="mt-5">
              <MatchupRefreshManager leagueId={league._id} mode="advanced" />
            </div>
          </Panel>

          <Panel lifted padding="md">
            <SectionHeader title="Player database" kicker="NFL players" size="sm" />
            <p className="mt-2 text-sm text-bc-text-2">
              Player stats update daily on their own for the current season. Use this to force an
              immediate refresh or backfill an older season.
            </p>
            <div className="mt-5">
              <PlayerManagement leagueId={league._id} />
            </div>
          </Panel>

          <Panel lifted padding="md">
            <SectionHeader title="Historical rosters" kicker="Archive" size="sm" />
            <p className="mt-2 text-sm text-bc-text-2">
              Manual rebuild. Historical rosters are only fetched during an import or a full
              re-import above &mdash; use this to pull one season&apos;s rosters directly.
            </p>
            <div className="mt-5">
              <HistoricalRosterManager leagueId={league._id} />
            </div>
          </Panel>

          <Panel lifted padding="md">
            <SectionHeader title="Draft data" kicker="Archive" size="sm" />
            <p className="mt-2 text-sm text-bc-text-2">
              Draft completion is detected automatically, but the picks themselves are only saved
              when you sync them here.
            </p>
            <div className="mt-5">
              <DraftDataViewer leagueId={league._id} />
            </div>
          </Panel>

          <Panel lifted padding="md">
            <SectionHeader title="Data processing" kicker="AI pipeline" size="sm" />
            <p className="mt-2 text-sm text-bc-text-2">
              Automatic: rivalry and manager-activity metrics recompute after each sync.
            </p>
            <div className="mt-5">
              <DataProcessingManager leagueId={league._id} />
            </div>
          </Panel>
        </SettingsSection>
      </div>
    </div>
  );
}
