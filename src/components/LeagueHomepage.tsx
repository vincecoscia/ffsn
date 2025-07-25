"use client";

import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import { useState, Suspense } from "react";
import { Button } from "@radix-ui/themes";
import { ContentGenerator } from "./ContentGenerator";
import { LeagueWeeklySection } from "./LeagueWeeklySection";
import { ArticleList } from "./ArticleList";
import { ArticleListSkeleton } from "./ui/ArticleSkeleton";
import { ChevronLeft, ChevronRight } from "lucide-react";

interface Team {
  _id: Id<"teams">;
  name: string;
  abbreviation?: string;
  logo?: string;
  owner: string;
  externalId: string;
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
  const [currentPage, setCurrentPage] = useState(1);
  const [cursor, setCursor] = useState<string | null>(null);
  
  // Get AI content result for pagination controls
  const aiContentResult = useQuery(api.aiContent.getByLeague, {
    leagueId: league._id,
    paginationOpts: {
      numItems: 3,
      cursor: cursor
    }
  });
  
  // Pagination functions
  const handleNextPage = () => {
    if (aiContentResult && !aiContentResult.isDone) {
      setCursor(aiContentResult.continueCursor);
      setCurrentPage(prev => prev + 1);
    }
  };

  const handlePreviousPage = () => {
    if (currentPage > 1) {
      // For simplicity, we'll reset to first page when going back
      // In a more complex implementation, you'd store previous cursors
      setCursor(null);
      setCurrentPage(1);
    }
  };

  const canGoNext = aiContentResult && !aiContentResult.isDone;
  const canGoPrevious = currentPage > 1;

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
    <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
          {/* Main Content Area */}
          <div className="lg:col-span-3 space-y-6">
            {/* Featured Story Section */}
            {/* <div className="bg-white rounded-lg overflow-hidden shadow-sm">
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
            </div> */}

            {/* Weekly Section - Matchups or Draft Order */}
            <LeagueWeeklySection
              leagueId={league._id}
              teams={teams}
              seasonId={2025}
            />

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

                <Suspense fallback={<ArticleListSkeleton />}>
                  <ArticleList 
                    leagueId={league._id} 
                    cursor={cursor}
                    isCommissioner={league.role === "commissioner"}
                    onShowContentGenerator={() => setShowContentGenerator(true)}
                  />
                </Suspense>
                
                {/* Pagination Controls */}
                {aiContentResult && aiContentResult.page && aiContentResult.page.length > 0 && (canGoNext || canGoPrevious) && (
                  <div className="flex justify-center items-center gap-8 p-6 border-t border-gray-200">
                    {/* Previous Button - Only show if we can go previous */}
                    {canGoPrevious && (
                      <button
                        onClick={handlePreviousPage}
                        className="flex items-center justify-center w-10 h-10 rounded-full bg-red-600 hover:bg-red-700 text-white transition-colors duration-200 shadow-lg hover:shadow-xl"
                        aria-label="Previous page"
                      >
                        <ChevronLeft size={20} />
                      </button>
                    )}
                    
                    {/* Page Indicator */}
                    <div className="px-4 py-2 bg-gray-100 rounded-lg text-sm font-medium text-gray-700">
                      Page {currentPage}
                    </div>
                    
                    {/* Next Button - Only show if we can go next */}
                    {canGoNext && (
                      <button
                        onClick={handleNextPage}
                        className="flex items-center justify-center w-10 h-10 rounded-full bg-red-600 hover:bg-red-700 text-white transition-colors duration-200 shadow-lg hover:shadow-xl"
                        aria-label="Next page"
                      >
                        <ChevronRight size={20} />
                      </button>
                    )}
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
                    Cowboys&apos; Parsons ready for &apos;terrible&apos; NFL start
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
                    Jets&apos; Gardner defends deal: &apos;There ain&apos;t no roof&apos;
                  </h4>
                  <p className="text-xs text-gray-600">Confident about team&apos;s potential this season</p>
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
                      Ranking the NFL&apos;s best players at every position for 2025
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
  );
}