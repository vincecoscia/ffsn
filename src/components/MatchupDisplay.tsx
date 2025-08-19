import React from 'react';

interface Team {
  _id: string;
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

interface Player {
  lineupSlotId: number;
  espnId: number;
  firstName?: string;
  lastName?: string;
  fullName: string;
  position: string;
  points: number;
  projectedPoints?: number;
  projectedStats?: Record<string, number>;
}

interface Roster {
  appliedStatTotal: number;
  players: Player[];
}

interface Matchup {
  _id: string;
  homeTeamId: string;
  awayTeamId: string;
  homeScore: number;
  awayScore: number;
  homeProjectedScore?: number;
  awayProjectedScore?: number;
  winner?: 'home' | 'away' | 'tie';
  matchupPeriod: number;
  homeRoster?: Roster;
  awayRoster?: Roster;
}

interface MatchupDisplayProps {
  matchups: Matchup[];
  teams: Team[];
  currentWeek: number;
}

export function MatchupDisplay({ matchups, teams, currentWeek }: MatchupDisplayProps) {
  // Create a map for quick team lookup by external ID
  const teamMap = React.useMemo(() => {
    const map = new Map<string, Team>();
    teams.forEach(team => {
      map.set(team.externalId, team);
    });
    return map;
  }, [teams]);

  const getTeamByExternalId = (externalId: string): Team | null => {
    return teamMap.get(externalId) || null;
  };

  // Calculate projected score from roster data
  const calculateProjectedScore = (roster?: Roster): number => {
    if (!roster || !roster.players) {
      return 0;
    }
    
    return roster.players
      .filter(player => player.lineupSlotId !== 20) // Exclude bench players (lineupSlotId 20)
      .reduce((total, player) => {
        return total + (player.projectedPoints || 0);
      }, 0);
  };

  // Calculate actual score from roster data
  const calculateActualScore = (roster?: Roster): number => {
    if (!roster || !roster.players) {
      return 0;
    }
    
    return roster.players
      .filter(player => player.lineupSlotId !== 20) // Exclude bench players (lineupSlotId 20)
      .reduce((total, player) => {
        return total + (player.points || 0);
      }, 0);
  };

  if (matchups.length === 0) {
    return (
      <div className="bg-white rounded-lg shadow-sm p-6">
        <h2 className="text-xl font-bold text-gray-900 mb-4">Week {currentWeek} Matchups</h2>
        <p className="text-gray-500">No matchups available for this week.</p>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-lg shadow-sm p-4">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-bold text-gray-900">Week {currentWeek} Matchups</h2>
        {matchups.some(m => !m.winner) && (
          <span className="text-xs text-blue-500 bg-blue-50 px-2 py-1 rounded font-medium">
            Projected Scores
          </span>
        )}
      </div>
      
      {/* Horizontal scrollable grid of matchup cards */}
      <div className="overflow-x-auto">
        <div className="flex space-x-3 pb-2" style={{ minWidth: 'fit-content' }}>
          {matchups.map((matchup) => {
            const homeTeam = getTeamByExternalId(matchup.homeTeamId);
            const awayTeam = getTeamByExternalId(matchup.awayTeamId);

            if (!homeTeam || !awayTeam) {
              return null; // Skip if teams not found
            }

            const isComplete = matchup.winner !== undefined;
            const homeWins = matchup.winner === 'home';
            const awayWins = matchup.winner === 'away';

            // Calculate projected scores from roster data if available, otherwise use stored values
            const homeProjectedScore = matchup.homeRoster 
              ? calculateProjectedScore(matchup.homeRoster)
              : (matchup.homeProjectedScore || 0);
            
            const awayProjectedScore = matchup.awayRoster 
              ? calculateProjectedScore(matchup.awayRoster)
              : (matchup.awayProjectedScore || 0);

            // Calculate actual scores from roster data if available, otherwise use stored values
            const homeActualScore = matchup.homeRoster 
              ? calculateActualScore(matchup.homeRoster)
              : matchup.homeScore;
            
            const awayActualScore = matchup.awayRoster 
              ? calculateActualScore(matchup.awayRoster)
              : matchup.awayScore;

            return (
              <div key={matchup._id} className="flex-shrink-0 w-64 border border-gray-200 rounded-lg p-3 hover:shadow-md transition-shadow">
                {/* Status indicator */}
                <div className="text-center mb-2">
                  <span className={`text-xs font-medium px-2 py-1 rounded ${
                    isComplete 
                      ? 'bg-green-100 text-green-700' 
                      : 'bg-blue-100 text-blue-700'
                  }`}>
                    {isComplete ? 'FINAL' : 'LIVE'}
                  </span>
                </div>

                {/* Teams and scores */}
                <div className="space-y-2">
                  {/* Away Team */}
                  <div className={`flex items-center justify-between p-2 rounded ${
                    awayWins ? 'bg-green-50 border border-green-200' : 'bg-gray-50'
                  }`}>
                    <div className="flex-1">
                      <div className={`text-sm font-medium ${awayWins ? 'text-green-900' : 'text-gray-900'}`}>
                        {awayTeam.name}
                      </div>
                      <div className="text-xs text-gray-500">
                        {awayTeam.record.wins}-{awayTeam.record.losses}
                        {awayTeam.record.ties > 0 && `-${awayTeam.record.ties}`}
                      </div>
                    </div>
                    <div className="text-right">
                      {/* Projected Score - Small text on top */}
                      <div className="text-xs text-gray-500">
                        {awayProjectedScore.toFixed(1)}
                      </div>
                      {/* Actual Score - Large text below */}
                      <div className={`text-lg font-bold ${
                        isComplete ? (awayWins ? 'text-green-700' : 'text-gray-600') : 'text-blue-600'
                      }`}>
                        {awayActualScore.toFixed(1)}
                      </div>
                    </div>
                  </div>

                  {/* Home Team */}
                  <div className={`flex items-center justify-between p-2 rounded ${
                    homeWins ? 'bg-green-50 border border-green-200' : 'bg-gray-50'
                  }`}>
                    <div className="flex-1">
                      <div className={`text-sm font-medium ${homeWins ? 'text-green-900' : 'text-gray-900'}`}>
                        {homeTeam.name}
                      </div>
                      <div className="text-xs text-gray-500">
                        {homeTeam.record.wins}-{homeTeam.record.losses}
                        {homeTeam.record.ties > 0 && `-${homeTeam.record.ties}`}
                      </div>
                    </div>
                    <div className="text-right">
                      {/* Projected Score - Small text on top */}
                      <div className="text-xs text-gray-500">
                        {homeProjectedScore.toFixed(1)}
                      </div>
                      {/* Actual Score - Large text below */}
                      <div className={`text-lg font-bold ${
                        isComplete ? (homeWins ? 'text-green-700' : 'text-gray-600') : 'text-blue-600'
                      }`}>
                        {homeActualScore.toFixed(1)}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}