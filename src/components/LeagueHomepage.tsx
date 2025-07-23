"use client";

import { useQuery, useMutation } from "convex/react";
import { toast } from "sonner";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import Link from "next/link";
import { UserButton } from "@clerk/nextjs";
import { MarkdownPreview } from "./MarkdownPreview";
import { useState } from "react";
import Image from "next/image";
import { Button, Card, Badge, Flex, Text, Heading } from "@radix-ui/themes";
import { ContentGenerator } from "./ContentGenerator";

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
  const [showContentGenerator, setShowContentGenerator] = useState(false);
  
  // Get AI content for this league
  const aiContent = useQuery(api.aiContent.getByLeague, {
    leagueId: league._id
  });

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



  return (
    <div className="min-h-screen bg-gray-100">
      {/* ESPN-style Top Events Bar */}
      <div className="bg-black text-white py-2 px-4">
        <div className="container mx-auto">
          <div className="flex items-center justify-between text-sm">
            <div className="flex items-center gap-8">
              <span className="font-semibold">Top Events</span>
              <div className="flex items-center gap-6">
                <span className="text-gray-300">NFL</span>
                <span className="text-gray-300">Fantasy</span>
                <span className="text-gray-300">More Sports</span>
              </div>
            </div>
            <div className="flex items-center gap-4">
              <span className="text-gray-300">Watch</span>
              <span className="text-gray-300">Listen</span>
            </div>
          </div>
        </div>
      </div>

      {/* ESPN Main Header */}
      <header className="bg-red-600 shadow-lg">
        <div className="container mx-auto px-4">
          <div className="flex items-center justify-between h-16">
            <div className="flex items-center gap-6">
              <Link href="/" className="flex items-center cursor-pointer">
                <Image
                  src="/FFSN.png"
                  alt="FFSN Logo"
                  width={80}
                  height={53}
                  className="h-12 w-auto"
                />
              </Link>
              <span className="text-red-200">|</span>
              <span className="text-white font-semibold text-lg">{league.name}</span>
            </div>
            
            <div className="flex items-center gap-6">
              <nav className="hidden md:flex items-center gap-6">
                <Link href="#" className="text-white hover:text-red-200 transition-colors font-semibold cursor-pointer">
                  Home
                </Link>
                <Link href="#" className="text-white hover:text-red-200 transition-colors cursor-pointer">
                  Scores
                </Link>
                <Link href="#" className="text-white hover:text-red-200 transition-colors cursor-pointer">
                  Schedule
                </Link>
                <Link href="#" className="text-white hover:text-red-200 transition-colors cursor-pointer">
                  Standings
                </Link>
                <Link href="#" className="text-white hover:text-red-200 transition-colors cursor-pointer">
                  Teams
                </Link>
                <Link href="#" className="text-white hover:text-red-200 transition-colors cursor-pointer">
                  Odds
                </Link>
                {league.role === "commissioner" && (
                  <Link href={`/leagues/${league._id}/settings`} className="text-white hover:text-red-200 transition-colors cursor-pointer">
                    Settings
                  </Link>
                )}
              </nav>
              <UserButton />
            </div>
          </div>
        </div>
      </header>

      {/* NFL Sub Navigation */}
      <div className="bg-gray-800 border-b border-gray-600">
        <div className="container mx-auto px-4">
          <div className="flex items-center gap-8 py-3">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 bg-white rounded flex items-center justify-center">
                <span className="text-gray-800 font-bold text-sm">NFL</span>
              </div>
              <span className="text-white font-semibold">Fantasy</span>
            </div>
            <nav className="flex items-center gap-6 text-sm">
              <Link href="#" className="text-white hover:text-gray-300 transition-colors cursor-pointer">
                Home
              </Link>
              <Link href="#" className="text-gray-300 hover:text-white transition-colors cursor-pointer">
                Scores
              </Link>
              <Link href="#" className="text-gray-300 hover:text-white transition-colors cursor-pointer">
                Schedule
              </Link>
              <Link href="#" className="text-gray-300 hover:text-white transition-colors cursor-pointer">
                Standings
              </Link>
              <Link href="#" className="text-gray-300 hover:text-white transition-colors cursor-pointer">
                Teams
              </Link>
              <Link href="#" className="text-gray-300 hover:text-white transition-colors cursor-pointer">
                Depth Charts
              </Link>
              {league.role === "commissioner" && (
                <Link href={`/leagues/${league._id}/settings`} className="text-gray-300 hover:text-white transition-colors cursor-pointer">
                  Settings
                </Link>
              )}
              <Link href="#" className="text-gray-300 hover:text-white transition-colors cursor-pointer">
                More
              </Link>
            </nav>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="container mx-auto px-4 py-6">
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
          {/* Main Content Area */}
          <div className="lg:col-span-3 space-y-6">
            {/* Featured Story Section */}
            <div className="bg-white rounded-lg overflow-hidden shadow-sm">
              <div className="relative h-64 bg-gradient-to-r from-blue-600 to-purple-600">
                <div className="absolute inset-0 bg-black bg-opacity-40"></div>
                <div className="absolute bottom-0 left-0 right-0 p-6 text-white">
                  <h1 className="text-3xl font-bold mb-2">
                    We ranked the 50 most impactful {league.name} moves
                  </h1>
                  <p className="text-gray-200 text-lg">
                    From rookie sensations to veteran comebacks - which moves will have the most impact this season?
                  </p>
                </div>
              </div>
            </div>

            {/* League Articles & Stories */}
            <div className="bg-white rounded-lg shadow-sm">
              <div className="border-b border-gray-200 p-6">
                <div className="flex justify-between items-center">
                  <h2 className="text-2xl font-bold text-gray-900">League Stories</h2>
                  {league.role === "commissioner" && (
                    <Button
                      onClick={() => setShowContentGenerator(!showContentGenerator)}
                      color="red"
                      variant="solid"
                      size="2"
                      className="cursor-pointer"
                    >
                      {showContentGenerator ? "Hide Generator" : "Generate Story"}
                    </Button>
                  )}
                </div>
              </div>
              
              <div className="p-6">
                {/* Show Content Generator if toggled */}
                {showContentGenerator && league.role === "commissioner" && (
                  <div className="mb-6">
                    <ContentGenerator leagueId={league._id} isCommissioner={true} />
                  </div>
                )}

                {!aiContent || aiContent.length === 0 ? (
                  <div className="text-center py-12">
                    <div className="text-gray-400 mb-6">
                      <svg className="w-20 h-20 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                      </svg>
                    </div>
                    <h3 className="text-xl font-bold text-gray-900 mb-3">No Stories Yet</h3>
                    <p className="text-gray-600 mb-6 max-w-md mx-auto">
                      Generate AI-powered stories about your league including weekly recaps, trade analysis, and player breakdowns.
                    </p>
                    {league.role === "commissioner" && (
                      <Button
                        onClick={() => setShowContentGenerator(true)}
                        color="red"
                        size="3"
                        className="cursor-pointer"
                      >
                        Create Your First Story
                      </Button>
                    )}
                  </div>
                ) : (
                  <div className="grid gap-6">
                    {aiContent.map((article) => (
                      <article key={article._id} className="border-b border-gray-200 pb-6 last:border-0">
                        <Link href={`/articles/${article._id}`} className="block hover:bg-gray-50 transition-colors rounded-lg p-2 -m-2">
                          <div className="flex gap-4">
                            <div className="flex-1">
                              <h3 className="font-bold text-xl text-gray-900 mb-2 hover:text-red-600 cursor-pointer transition-colors">
                                {article.title}
                              </h3>
                            <div className="text-gray-600 text-sm mb-3">
                              {new Date(article.publishedAt || article.createdAt).toLocaleDateString('en-US', {
                                weekday: 'long',
                                year: 'numeric',
                                month: 'long',
                                day: 'numeric'
                              })}
                            </div>
                            <MarkdownPreview 
                              content={article.content} 
                              preview={true} 
                              maxLines={3} 
                            />
                          </div>
                          <div className="w-32 h-24 bg-gray-200 rounded flex-shrink-0"></div>
                          </div>
                        </Link>
                      </article>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* League Standings */}
            <div className="bg-white rounded-lg shadow-sm">
              <div className="border-b border-gray-200 p-6">
                <h2 className="text-2xl font-bold text-gray-900">League Standings</h2>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-6 py-4 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Rank
                      </th>
                      <th className="px-6 py-4 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Team
                      </th>
                      <th className="px-6 py-4 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Record
                      </th>
                      <th className="px-6 py-4 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Points For
                      </th>
                      <th className="px-6 py-4 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Points Against
                      </th>
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-gray-200">
                    {sortedTeams.map((team, index) => (
                      <tr key={team._id} className="hover:bg-gray-50 transition-colors">
                        <td className="px-6 py-4 whitespace-nowrap">
                          <span className="text-sm font-bold text-gray-900">{index + 1}</span>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap">
                          <div className="flex items-center">
                            {team.logo && (
                              <img className="h-10 w-10 rounded mr-3" src={team.logo} alt={`${team.name} logo`} />
                            )}
                            <div>
                              <div className="text-sm font-bold text-gray-900">{team.name}</div>
                              <div className="text-sm text-gray-500">{team.owner}</div>
                            </div>
                          </div>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap">
                          <span className="text-sm font-semibold text-gray-900">
                            {team.record.wins}-{team.record.losses}
                            {team.record.ties > 0 && `-${team.record.ties}`}
                          </span>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm font-semibold text-gray-900">
                          {team.record.pointsFor?.toFixed(1) || '0.0'}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm font-semibold text-gray-900">
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
          <div className="lg:col-span-1 space-y-6">
            {/* Your Team Card */}
            {userTeam && (
              <div className="bg-white rounded-lg shadow-sm">
                <div className="border-b border-gray-200 p-4">
                  <h3 className="text-lg font-bold text-gray-900">Your Team</h3>
                </div>
                <div className="p-6">
                  <div className="text-center">
                    {userTeam.logo && (
                      <img 
                        src={userTeam.logo} 
                        alt={`${userTeam.name} logo`}
                        className="w-20 h-20 mx-auto mb-4 rounded-lg"
                      />
                    )}
                    <h4 className="font-bold text-xl text-gray-900 mb-1">{userTeam.name}</h4>
                    {userTeam.abbreviation && (
                      <p className="text-gray-600 text-sm mb-4">{userTeam.abbreviation}</p>
                    )}
                    <div className="bg-gray-50 rounded-lg p-4 space-y-3">
                      <div>
                        <div className="text-gray-600 text-sm">Record</div>
                        <div className="font-bold text-2xl text-gray-900">
                          {userTeam.record.wins}-{userTeam.record.losses}
                          {userTeam.record.ties > 0 && `-${userTeam.record.ties}`}
                        </div>
                      </div>
                      {userTeam.record.pointsFor && (
                        <div>
                          <div className="text-gray-600 text-sm">Points For</div>
                          <div className="font-bold text-lg text-gray-900">
                            {userTeam.record.pointsFor.toFixed(1)}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Top Headlines */}
            <div className="bg-white rounded-lg shadow-sm">
              <div className="border-b border-gray-200 p-4">
                <h3 className="text-lg font-bold text-gray-900">🔥 Top Headlines</h3>
              </div>
              <div className="p-4 space-y-4">
                <div className="border-b border-gray-100 pb-3 last:border-0">
                  <h4 className="font-bold text-sm text-gray-900 hover:text-red-600 cursor-pointer mb-1">
                    Cowboys' Parsons ready for 'terrible' NFL start
                  </h4>
                  <p className="text-xs text-gray-600">Dallas prepares for tough opening stretch</p>
                </div>
                <div className="border-b border-gray-100 pb-3 last:border-0">
                  <h4 className="font-bold text-sm text-gray-900 hover:text-red-600 cursor-pointer mb-1">
                    Unhappy McLaurin a no-show for Commanders
                  </h4>
                  <p className="text-xs text-gray-600">WR skips voluntary workouts amid contract talks</p>
                </div>
                <div className="border-b border-gray-100 pb-3 last:border-0">
                  <h4 className="font-bold text-sm text-gray-900 hover:text-red-600 cursor-pointer mb-1">
                    Jets' Gardner defends deal: 'There ain't no roof'
                  </h4>
                  <p className="text-xs text-gray-600">Confident about team's potential this season</p>
                </div>
              </div>
            </div>

            {/* League Info */}
            <div className="bg-white rounded-lg shadow-sm">
              <div className="border-b border-gray-200 p-4">
                <h3 className="text-lg font-bold text-gray-900">League Info</h3>
              </div>
              <div className="p-4 space-y-4">
                <div className="flex justify-between">
                  <span className="text-gray-600 text-sm">Teams</span>
                  <span className="font-semibold text-gray-900">{teams.length}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600 text-sm">Scoring</span>
                  <span className="font-semibold text-gray-900 capitalize">{league.settings.scoringType}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600 text-sm">Your Role</span>
                  <span className="font-semibold text-gray-900 capitalize">{league.role}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600 text-sm">Platform</span>
                  <span className="font-semibold text-gray-900 uppercase">{league.platform}</span>
                </div>
              </div>
            </div>

            {/* Trending Now */}
            <div className="bg-white rounded-lg shadow-sm">
              <div className="border-b border-gray-200 p-4">
                <h3 className="text-lg font-bold text-gray-900">Trending Now</h3>
              </div>
              <div className="p-4 space-y-3">
                <div className="flex items-start gap-3">
                  <div className="w-12 h-12 bg-blue-600 rounded flex-shrink-0"></div>
                  <div className="flex-1">
                    <h4 className="font-bold text-sm text-gray-900 hover:text-red-600 cursor-pointer mb-1">
                      Ranking the NFL's best players at every position for 2025
                    </h4>
                    <p className="text-xs text-gray-600">Our experts rank the top 10 at each position</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <div className="w-12 h-12 bg-red-600 rounded flex-shrink-0"></div>
                  <div className="flex-1">
                    <h4 className="font-bold text-sm text-gray-900 hover:text-red-600 cursor-pointer mb-1">
                      2025 NFL draft top pick predictions
                    </h4>
                    <p className="text-xs text-gray-600">Early chances at No. 1 overall pick</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}