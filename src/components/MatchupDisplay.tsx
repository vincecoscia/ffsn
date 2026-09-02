import React from 'react';
import { ScoreBug } from '@/components/broadcast';

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

function recordLabel(record: Team["record"]): string {
  return `${record.wins}-${record.losses}${record.ties > 0 ? `-${record.ties}` : ""}`;
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
      <p className="text-[15px] text-bc-text-2">
        No matchups available for Week {currentWeek}.
      </p>
    );
  }

  // "Game of the week" = the completed matchup with the closest final margin.
  const completed = matchups.filter(m => m.winner && m.winner !== "tie");
  const gameOfWeekId =
    completed.length > 0
      ? [...completed].sort(
          (a, b) => Math.abs(a.homeScore - a.awayScore) - Math.abs(b.homeScore - b.awayScore)
        )[0]._id
      : null;

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
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

        const mode = isComplete ? "final" : "projected";
        const isGameOfWeek = matchup._id === gameOfWeekId;

        return (
          <ScoreBug
            key={matchup._id}
            mode={mode}
            strip={isComplete ? `Week ${currentWeek} · Final` : `Week ${currentWeek} · Projected`}
            stripRight={isGameOfWeek ? "Game of the week" : undefined}
            stripRightTone="highlight"
            home={{
              name: homeTeam.name,
              sub: `${homeTeam.owner} · ${recordLabel(homeTeam.record)}`,
              score: (isComplete ? homeActualScore : homeProjectedScore).toFixed(1),
              winner: homeWins,
            }}
            away={{
              name: awayTeam.name,
              sub: `${awayTeam.owner} · ${recordLabel(awayTeam.record)}`,
              score: (isComplete ? awayActualScore : awayProjectedScore).toFixed(1),
              winner: awayWins,
            }}
          />
        );
      })}
    </div>
  );
}
