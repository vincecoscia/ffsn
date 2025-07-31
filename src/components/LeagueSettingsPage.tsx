"use client";

import { useState, useRef } from "react";
import { useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import { PlayerManagement } from "./PlayerManagement";
import HistoricalRosterManager from "./HistoricalRosterManager";
import { DraftDataViewer } from "./DraftDataViewer";
import { MatchupRefreshManager } from "./MatchupRefreshManager";
import { DataProcessingManager } from "./DataProcessingManager";
import { TeamLogo } from "./TeamLogo";

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
  const fileInputRefs = useRef<{[teamId: string]: HTMLInputElement | null}>({});

  const createInvitation = useMutation(api.teamInvitations.createInvitation);
  const generateUploadUrl = useMutation(api.teams.generateUploadUrl);
  const updateCustomLogo = useMutation(api.teams.updateCustomLogo);
  const removeCustomLogo = useMutation(api.teams.removeCustomLogo);

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
          seasonId: 2025,
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

  return (
    <div className="max-w-4xl mx-auto space-y-8">
          
          {/* League Settings Section */}
          <div className="bg-white rounded-lg shadow-sm">
            <div className="border-b border-gray-200 px-6 py-4">
              <h2 className="text-2xl font-bold text-gray-900">League Settings</h2>
              <p className="text-gray-600 mt-1">Manage your league information and preferences</p>
            </div>
            
            <div className="p-6">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    League Name
                  </label>
                  {editingLeague ? (
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={leagueName}
                        onChange={(e) => setLeagueName(e.target.value)}
                        className="flex-1 px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-red-500"
                      />
                      <button
                        onClick={() => {
                          // TODO: Implement league name update
                          setEditingLeague(false);
                        }}
                        className="px-4 py-2 bg-red-600 text-white rounded-md hover:bg-red-700 transition-colors"
                      >
                        Save
                      </button>
                      <button
                        onClick={() => {
                          setLeagueName(league.name);
                          setEditingLeague(false);
                        }}
                        className="px-4 py-2 bg-gray-300 text-gray-700 rounded-md hover:bg-gray-400 transition-colors"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center justify-between p-3 bg-gray-50 rounded-md">
                      <span className="text-gray-900">{league.name}</span>
                      <button
                        onClick={() => setEditingLeague(true)}
                        className="text-red-600 hover:text-red-700 text-sm font-medium"
                      >
                        Edit
                      </button>
                    </div>
                  )}
                </div>
                
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Platform
                  </label>
                  <div className="p-3 bg-gray-50 rounded-md">
                    <span className="text-gray-900 capitalize">{league.platform}</span>
                  </div>
                </div>
                
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Scoring Type
                  </label>
                  <div className="p-3 bg-gray-50 rounded-md">
                    <span className="text-gray-900">{league.settings.scoringType}</span>
                  </div>
                </div>
                
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Roster Size
                  </label>
                  <div className="p-3 bg-gray-50 rounded-md">
                    <span className="text-gray-900">{league.settings.rosterSize}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Team Logo Management Section */}
          <div className="bg-white rounded-lg shadow-sm">
            <div className="border-b border-gray-200 px-6 py-4">
              <h2 className="text-2xl font-bold text-gray-900">Team Logo Management</h2>
              <p className="text-gray-600 mt-1">Manage custom logos for teams. Logo not showing up? ESPN&apos;s new restrictions for logos prevents new ones from loading after a certain date. Upload a custom logo here!</p>
            </div>
            
            <div className="p-6">
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {teams.map((team) => {
                  const teamClaim = teamClaims.find(claim => claim.teamId === team._id);
                  const isCommissioner = league.role === "commissioner";
                  const canManageLogo = isCommissioner || teamClaim?.status === "active";
                  
                  return (
                    <div key={team._id} className="p-4 border border-gray-200 rounded-lg">
                      <div className="flex items-center gap-3 mb-3">
                        <div className="relative">
                          <TeamLogo
                            teamId={team._id}
                            teamName={team.name}
                            espnLogo={team.logo}
                            customLogo={team.customLogo}
                            size="md"
                          />
                          {team.customLogo && (
                            <div className="absolute -top-1 -right-1 h-3 w-3 bg-green-500 rounded-full"></div>
                          )}
                        </div>
                        <div className="flex-1">
                          <div className="font-semibold text-gray-900">{team.name}</div>
                          <div className="text-sm text-gray-600">{team.abbreviation}</div>
                        </div>
                      </div>
                      
                      {canManageLogo ? (
                        <div className="space-y-2">
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
                            id={`logo-upload-${team._id}`}
                          />
                          <label
                            htmlFor={`logo-upload-${team._id}`}
                            className="block w-full px-3 py-2 text-sm text-center bg-red-600 text-white rounded-md hover:bg-red-700 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            {uploadingLogoForTeam === team._id ? "Uploading..." : "Upload Custom Logo"}
                          </label>
                          {team.customLogo && (
                            <button
                              onClick={() => handleRemoveCustomLogo(team._id)}
                              className="w-full px-3 py-2 text-sm bg-gray-200 text-gray-700 rounded-md hover:bg-gray-300 transition-colors"
                            >
                              Remove Custom Logo
                            </button>
                          )}
                        </div>
                      ) : (
                        <div className="text-sm text-gray-500 text-center">
                          {teamClaim ? "Claimed by user" : "Not your team"}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Team Invitations Section */}
          <div className="bg-white rounded-lg shadow-sm">
            <div className="border-b border-gray-200 px-6 py-4">
              <h2 className="text-2xl font-bold text-gray-900">Team Invitations</h2>
              <p className="text-gray-600 mt-1">Send invite links to team owners for the 2025 season</p>
            </div>
            
            <div className="p-6">
              {/* Create New Invitations */}
              {unclaimedTeams.length > 0 && (
                <div className="mb-8">
                  <h3 className="text-lg font-semibold text-gray-900 mb-4">Create New Invitations</h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mb-6">
                    {unclaimedTeams.map((team) => (
                      <div
                        key={team._id}
                        className={`p-4 border-2 rounded-lg cursor-pointer transition-all ${
                          isTeamSelected(team._id)
                            ? "border-red-500 bg-red-50"
                            : "border-gray-200 hover:border-gray-300"
                        }`}
                        onClick={() => toggleTeamSelection(team._id)}
                      >
                        <div className="flex items-center gap-3 mb-3">
                          <TeamLogo
                            teamId={team._id}
                            teamName={team.name}
                            espnLogo={team.logo}
                            customLogo={team.customLogo}
                            size="sm"
                          />
                          <div>
                            <div className="font-semibold text-gray-900">{team.name}</div>
                            <div className="text-sm text-gray-600">{team.abbreviation}</div>
                          </div>
                        </div>
                        
                        {isTeamSelected(team._id) && (
                          <input
                            type="email"
                            placeholder="Optional: Enter email"
                            value={emailInputs[team._id] || ""}
                            onChange={(e) => {
                              e.stopPropagation();
                              setEmailInputs(prev => ({
                                ...prev,
                                [team._id]: e.target.value
                              }));
                            }}
                            onClick={(e) => e.stopPropagation()}
                            className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-red-500"
                          />
                        )}
                      </div>
                    ))}
                  </div>
                  
                  {selectedTeamIds.length > 0 && (
                    <div className="flex justify-between items-center">
                      <span className="text-sm text-gray-600">
                        {selectedTeamIds.length} team{selectedTeamIds.length !== 1 ? "s" : ""} selected
                      </span>
                      <button
                        onClick={handleCreateInvites}
                        disabled={isCreatingInvites}
                        className="px-6 py-2 bg-red-600 text-white rounded-md hover:bg-red-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {isCreatingInvites ? "Creating..." : "Create Invitations"}
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/* Existing Invitations */}
              <div>
                <h3 className="text-lg font-semibold text-gray-900 mb-4">Existing Invitations</h3>
                {teamInvitations.length === 0 ? (
                  <div className="text-center py-8 text-gray-500">
                    <svg className="w-12 h-12 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2 2v-5m16 0h-2M4 13h2m13-8-4 4-4-4m-6 8l4-4 4 4" />
                    </svg>
                    <p>No invitations sent yet</p>
                  </div>
                ) : (
                  <div className="space-y-4">
                    {teamInvitations.map((invitation) => (
                      <div key={invitation._id} className="flex items-center justify-between p-4 border border-gray-200 rounded-lg">
                        <div className="flex items-center gap-4">
                          {invitation.teamLogo && (
                            <img
                              src={invitation.teamLogo}
                              alt={`${invitation.teamName} logo`}
                              className="h-10 w-10 rounded"
                            />
                          )}
                          <div>
                            <div className="font-semibold text-gray-900">{invitation.teamName}</div>
                            <div className="text-sm text-gray-600">
                              {invitation.email ? (
                                <>Sent to: {invitation.email}</>
                              ) : (
                                "No email specified"
                              )}
                            </div>
                            <div className="text-xs text-gray-500">
                              Created: {new Date(invitation.createdAt).toLocaleDateString()}
                              {invitation.status === "pending" && (
                                <> • Expires: {new Date(invitation.expiresAt).toLocaleDateString()}</>
                              )}
                            </div>
                          </div>
                        </div>
                        
                        <div className="flex items-center gap-2">
                          <span className={`px-3 py-1 rounded-full text-xs font-medium ${
                            invitation.status === "pending" 
                              ? "bg-yellow-100 text-yellow-800"
                              : invitation.status === "claimed"
                              ? "bg-green-100 text-green-800" 
                              : "bg-red-100 text-red-800"
                          }`}>
                            {invitation.status}
                          </span>
                          
                          {invitation.status === "pending" && (
                            <button
                              onClick={() => copyInviteLink(invitation.inviteToken)}
                              className="px-3 py-1 text-sm bg-red-600 text-white rounded-md hover:bg-red-700 transition-colors"
                            >
                              Copy Link
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Matchup Refresh Section */}
          <div className="bg-white rounded-lg shadow-sm">
            <div className="border-b border-gray-200 px-6 py-4">
              <h2 className="text-2xl font-bold text-gray-900">Sync League Data</h2>
              <p className="text-gray-600 mt-1">Sync all league data from ESPN including teams, owners, logos, rosters, matchups, and scores</p>
            </div>
            
            <div className="p-6">
              <MatchupRefreshManager leagueId={league._id} />
            </div>
          </div>

          {/* Player Management Section */}
          <div className="bg-white rounded-lg shadow-sm">
            <div className="border-b border-gray-200 px-6 py-4">
              <h2 className="text-2xl font-bold text-gray-900">Player Management</h2>
              <p className="text-gray-600 mt-1">Sync and manage NFL player data for your league</p>
            </div>
            
            <div className="p-6">
              <PlayerManagement leagueId={league._id} />
            </div>
          </div>

          {/* Historical Rosters Section */}
          <div className="bg-white rounded-lg shadow-sm">
            <div className="border-b border-gray-200 px-6 py-4">
              <h2 className="text-2xl font-bold text-gray-900">Historical Rosters</h2>
              <p className="text-gray-600 mt-1">Fetch detailed roster information from previous seasons</p>
            </div>
            
            <div className="p-6">
              <HistoricalRosterManager leagueId={league._id} />
            </div>
          </div>

          {/* Draft Data Section */}
          <div className="bg-white rounded-lg shadow-sm">
            <div className="border-b border-gray-200 px-6 py-4">
              <h2 className="text-2xl font-bold text-gray-900">Draft Data</h2>
              <p className="text-gray-600 mt-1">View draft order and historical draft picks for all seasons</p>
            </div>
            
            <div className="p-6">
              <DraftDataViewer leagueId={league._id} />
            </div>
          </div>

          {/* Data Processing Section */}
          <div className="bg-white rounded-lg shadow-sm">
            <div className="border-b border-gray-200 px-6 py-4">
              <h2 className="text-2xl font-bold text-gray-900">Data Processing</h2>
              <p className="text-gray-600 mt-1">Process league data for AI content generation</p>
            </div>
            
            <div className="p-6">
              <DataProcessingManager leagueId={league._id} />
            </div>
          </div>

    </div>
  );
}