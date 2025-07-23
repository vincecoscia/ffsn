"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import Link from "next/link";
import { UserButton } from "@clerk/nextjs";

interface Team {
  _id: Id<"teams">;
  name: string;
  abbreviation?: string;
  logo?: string;
  owner: string;
  record: {
    wins: number;
    losses: number;
    ties: number;
  };
}

interface League {
  _id: Id<"leagues">;
  name: string;
  role: "commissioner" | "member";
  platform: string;
  settings: {
    scoringType: string;
    rosterSize: number;
    playoffWeeks: number;
    categories: string[];
  };
}

interface CommissionerTeamSelectionProps {
  league: League;
  teams: Team[];
}

export function CommissionerTeamSelection({ league, teams }: CommissionerTeamSelectionProps) {
  const [selectedTeamId, setSelectedTeamId] = useState<Id<"teams"> | null>(null);
  const [isClaiming, setIsClaiming] = useState(false);
  
  const claimTeam = useMutation(api.teamClaims.claimTeam);

  const handleClaimTeam = async () => {
    if (!selectedTeamId) return;
    
    setIsClaiming(true);
    try {
      await claimTeam({
        leagueId: league._id,
        teamId: selectedTeamId,
        seasonId: 2025,
      });
      // Page will automatically re-render and move to next flow
    } catch (error) {
      alert(`Error claiming team: ${error instanceof Error ? error.message : "Unknown error"}`);
    } finally {
      setIsClaiming(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-900">
      {/* Header similar to ESPN */}
      <header className="bg-red-600 border-b border-red-700">
        <div className="container mx-auto px-6 py-4 flex justify-between items-center">
          <div className="flex items-center gap-4">
            <Link href="/" className="text-2xl font-bold text-white">
              FFSN
            </Link>
            <span className="text-red-200">|</span>
            <span className="text-white font-semibold">{league.name}</span>
          </div>
          <UserButton />
        </div>
      </header>

      <main className="container mx-auto px-6 py-8">
        <div className="max-w-4xl mx-auto">
          <div className="text-center mb-8">
            <h1 className="text-3xl font-bold text-white mb-2">
              Welcome to the 2025 Season!
            </h1>
            <p className="text-gray-400 text-lg">
              As commissioner, please select your team first
            </p>
          </div>

          <div className="bg-gray-800 rounded-lg p-6 mb-8">
            <h2 className="text-xl font-bold text-white mb-4">Select Your Team</h2>
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {teams.map((team) => (
                <div
                  key={team._id}
                  onClick={() => setSelectedTeamId(team._id)}
                  className={`
                    p-4 rounded-lg border-2 cursor-pointer transition-all
                    ${selectedTeamId === team._id
                      ? "border-red-500 bg-red-900/20"
                      : "border-gray-600 bg-gray-700 hover:border-gray-500"
                    }
                  `}
                >
                  <div className="flex items-center gap-3 mb-2">
                    {team.logo && (
                      <img 
                        src={team.logo} 
                        alt={`${team.name} logo`}
                        className="w-10 h-10 rounded"
                      />
                    )}
                    <div>
                      <h3 className="font-bold text-white">{team.name}</h3>
                      {team.abbreviation && (
                        <p className="text-sm text-gray-400">{team.abbreviation}</p>
                      )}
                    </div>
                  </div>
                  <div className="text-sm text-gray-300">
                    Owner: {team.owner}
                  </div>
                  <div className="text-sm text-gray-400">
                    Record: {team.record.wins}-{team.record.losses}
                    {team.record.ties > 0 && `-${team.record.ties}`}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {selectedTeamId && (
            <div className="text-center">
              <button
                onClick={handleClaimTeam}
                disabled={isClaiming}
                className="bg-red-600 text-white px-8 py-3 rounded-lg font-semibold hover:bg-red-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isClaiming ? "Claiming Team..." : "Claim This Team"}
              </button>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}