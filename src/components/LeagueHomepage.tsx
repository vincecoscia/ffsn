"use client";

import { useQuery, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import Link from "next/link";
import { UserButton } from "@clerk/nextjs";
import { useState } from "react";

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
    pointsFor?: number;
    pointsAgainst?: number;
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

interface TeamClaim {
  _id: Id<"teamClaims">;
  teamId: Id<"teams">;
  userId: string;
}

interface LeagueHomepageProps {
  league: League;
  teams: Team[];
  teamClaims: TeamClaim[];
  currentUserId?: string;
}

export function LeagueHomepage({ league, teams, teamClaims, currentUserId }: LeagueHomepageProps) {
  const [isGeneratingArticle, setIsGeneratingArticle] = useState(false);
  
  // Get AI content for this league
  const aiContent = useQuery(api.aiContent.getByLeague, {
    leagueId: league._id
  });

  // Generate article mutation (placeholder for now)
  const generateArticle = useMutation(api.aiContent.generateArticle);

  // Get user's claimed team
  const userTeam = teams.find(team => {
    const claim = teamClaims.find(claim => 
      claim.teamId === team._id && claim.userId === currentUserId
    );
    return !!claim;
  });

  // Sort teams by wins, then by points for
  const sortedTeams = [...teams].sort((a, b) => {
    if (a.record.wins !== b.record.wins) {
      return b.record.wins - a.record.wins;
    }
    return (b.record.pointsFor || 0) - (a.record.pointsFor || 0);
  });

  const handleGenerateArticle = async () => {
    setIsGeneratingArticle(true);
    try {
      await generateArticle({
        leagueId: league._id,
        type: "weekly_recap",
        persona: "analyst"
      });
    } catch (error) {
      alert("Error generating article. Feature coming soon!");
    } finally {
      setIsGeneratingArticle(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-100">
      {/* ESPN-style Navigation */}
      <nav className="bg-gray-900 border-b border-gray-700">
        <div className="container mx-auto px-4">
          <div className="flex items-center justify-between h-16">
            <div className="flex items-center gap-6">
              <Link href="/" className="text-2xl font-bold text-white">
                FFSN
              </Link>
              <span className="text-gray-400">|</span>
              <span className="text-white font-semibold">{league.name}</span>
            </div>
            
            <div className="flex items-center gap-6">
              <nav className="hidden md:flex items-center gap-6">
                <Link href="#" className="text-gray-300 hover:text-white transition-colors">
                  Home
                </Link>
                <Link href="#" className="text-gray-300 hover:text-white transition-colors">
                  Scores
                </Link>
                <Link href="#" className="text-gray-300 hover:text-white transition-colors">
                  Schedule
                </Link>
                <Link href="#" className="text-gray-300 hover:text-white transition-colors">
                  Standings
                </Link>
                <Link href="#" className="text-gray-300 hover:text-white transition-colors">
                  Teams
                </Link>
              </nav>
              <UserButton />
            </div>
          </div>
        </div>
      </nav>

      <div className="container mx-auto px-4 py-6">
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
          {/* Main Content Area */}
          <div className="lg:col-span-3">
            {/* Hero Section */}
            <div className="bg-white rounded-lg shadow-sm mb-6 overflow-hidden">
              <div className="bg-gradient-to-r from-red-600 to-red-700 p-6 text-white">
                <h1 className="text-2xl font-bold mb-2">{league.name}</h1>
                <p className="text-red-100">2025 Fantasy Football Season</p>
              </div>
            </div>

            {/* Articles Section */}
            <div className="bg-white rounded-lg shadow-sm mb-6">
              <div className="p-6 border-b border-gray-200">
                <div className="flex justify-between items-center">
                  <h2 className="text-xl font-bold text-gray-900">League Articles</h2>
                  <button
                    onClick={handleGenerateArticle}
                    disabled={isGeneratingArticle}
                    className="bg-red-600 text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-red-700 transition-colors disabled:opacity-50"
                  >
                    {isGeneratingArticle ? "Generating..." : "Generate Article"}
                  </button>
                </div>
              </div>
              
              <div className="p-6">
                {!aiContent || aiContent.length === 0 ? (
                  <div className="text-center py-8">
                    <div className="text-gray-400 mb-4">
                      <svg className="w-16 h-16 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                      </svg>
                    </div>
                    <h3 className="text-lg font-semibold text-gray-900 mb-2">No Articles Yet</h3>
                    <p className="text-gray-600 mb-4">
                      Generate AI-powered articles about your league, including weekly recaps, matchup previews, and player analysis.
                    </p>
                    <button
                      onClick={handleGenerateArticle}
                      disabled={isGeneratingArticle}
                      className="bg-red-600 text-white px-6 py-3 rounded-lg font-semibold hover:bg-red-700 transition-colors disabled:opacity-50"
                    >
                      {isGeneratingArticle ? "Generating..." : "Generate Your First Article"}
                    </button>
                  </div>
                ) : (
                  <div className="space-y-4">
                    {aiContent.map((article) => (
                      <div key={article._id} className="border-b border-gray-200 pb-4 last:border-0">
                        <h3 className="font-bold text-lg text-gray-900 mb-2">{article.title}</h3>
                        <p className="text-gray-600 text-sm mb-2">
                          {new Date(article.publishedAt || article.createdAt).toLocaleDateString()}
                        </p>
                        <p className="text-gray-700 line-clamp-3">{article.content}</p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Standings */}
            <div className="bg-white rounded-lg shadow-sm">
              <div className="p-6 border-b border-gray-200">
                <h2 className="text-xl font-bold text-gray-900">League Standings</h2>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Rank
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Team
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Record
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Points For
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Points Against
                      </th>
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-gray-200">
                    {sortedTeams.map((team, index) => (
                      <tr key={team._id} className="hover:bg-gray-50">
                        <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">
                          {index + 1}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap">
                          <div className="flex items-center">
                            {team.logo && (
                              <img className="h-8 w-8 rounded mr-3" src={team.logo} alt="" />
                            )}
                            <div>
                              <div className="text-sm font-medium text-gray-900">{team.name}</div>
                              <div className="text-sm text-gray-500">{team.owner}</div>
                            </div>
                          </div>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                          {team.record.wins}-{team.record.losses}
                          {team.record.ties > 0 && `-${team.record.ties}`}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                          {team.record.pointsFor?.toFixed(1) || '0.0'}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                          {team.record.pointsAgainst?.toFixed(1) || '0.0'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          {/* Sidebar */}
          <div className="lg:col-span-1">
            {/* User's Team */}
            {userTeam && (
              <div className="bg-white rounded-lg shadow-sm mb-6">
                <div className="p-6 border-b border-gray-200">
                  <h3 className="text-lg font-bold text-gray-900">Your Team</h3>
                </div>
                <div className="p-6">
                  <div className="text-center">
                    {userTeam.logo && (
                      <img 
                        src={userTeam.logo} 
                        alt={`${userTeam.name} logo`}
                        className="w-16 h-16 mx-auto mb-3 rounded"
                      />
                    )}
                    <h4 className="font-bold text-lg text-gray-900">{userTeam.name}</h4>
                    {userTeam.abbreviation && (
                      <p className="text-gray-600 text-sm">{userTeam.abbreviation}</p>
                    )}
                    <div className="mt-3 text-sm">
                      <div className="text-gray-600">Record</div>
                      <div className="font-semibold text-lg">
                        {userTeam.record.wins}-{userTeam.record.losses}
                        {userTeam.record.ties > 0 && `-${userTeam.record.ties}`}
                      </div>
                    </div>
                    {userTeam.record.pointsFor && (
                      <div className="mt-2 text-sm">
                        <div className="text-gray-600">Points For</div>
                        <div className="font-semibold">{userTeam.record.pointsFor.toFixed(1)}</div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* League Info */}
            <div className="bg-white rounded-lg shadow-sm">
              <div className="p-6 border-b border-gray-200">
                <h3 className="text-lg font-bold text-gray-900">League Info</h3>
              </div>
              <div className="p-6 space-y-3">
                <div>
                  <div className="text-sm text-gray-600">League Size</div>
                  <div className="font-semibold">{teams.length} Teams</div>
                </div>
                <div>
                  <div className="text-sm text-gray-600">Scoring</div>
                  <div className="font-semibold capitalize">{league.settings.scoringType}</div>
                </div>
                <div>
                  <div className="text-sm text-gray-600">Your Role</div>
                  <div className="font-semibold capitalize">{league.role}</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}