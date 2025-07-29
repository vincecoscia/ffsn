import { LeagueDataContext } from './prompt-builder';

/**
 * Data aggregation helpers for calculating derived metrics
 * These functions process raw league data to generate insights for AI content generation
 */

// Calculate strength of schedule for a team
export function calculateStrengthOfSchedule(
  teamId: string,
  matchups: LeagueDataContext['recentMatchups'],
  standings: LeagueDataContext['standings']
): number {
  if (!matchups || !standings) return 0;

  const teamMatchups = matchups.filter(m => 
    m.teamA === teamId || m.teamB === teamId
  );

  let totalOpponentRank = 0;
  let opponentCount = 0;

  teamMatchups.forEach(matchup => {
    const opponentId = matchup.teamA === teamId ? matchup.teamB : matchup.teamA;
    const opponentStanding = standings.find(s => s.team === opponentId || s.teamId === opponentId);
    
    if (opponentStanding) {
      totalOpponentRank += opponentStanding.rank;
      opponentCount++;
    }
  });

  // Lower average rank = harder schedule
  return opponentCount > 0 ? totalOpponentRank / opponentCount : standings.length / 2;
}

// Calculate recent form (last N weeks)
export function calculateRecentForm(
  teamId: string,
  matchups: LeagueDataContext['recentMatchups'],
  weeksToConsider: number = 3
): { wins: number; losses: number; avgPoints: number; } {
  if (!matchups) return { wins: 0, losses: 0, avgPoints: 0 };

  // Sort matchups by week (most recent first)
  const sortedMatchups = [...matchups].sort((a, b) => (b.week || 0) - (a.week || 0));
  const recentMatchups = sortedMatchups.slice(0, weeksToConsider).filter(m => 
    m.teamA === teamId || m.teamB === teamId
  );

  let wins = 0;
  let losses = 0;
  let totalPoints = 0;

  recentMatchups.forEach(matchup => {
    const isTeamA = matchup.teamA === teamId;
    const teamScore = isTeamA ? matchup.scoreA : matchup.scoreB;
    const opponentScore = isTeamA ? matchup.scoreB : matchup.scoreA;

    if (teamScore > opponentScore) {
      wins++;
    } else if (teamScore < opponentScore) {
      losses++;
    }

    totalPoints += teamScore;
  });

  const avgPoints = recentMatchups.length > 0 ? totalPoints / recentMatchups.length : 0;

  return { wins, losses, avgPoints };
}

// Detect rivalries based on matchup history
export function detectRivalries(
  matchups: LeagueDataContext['recentMatchups'],
  minGames: number = 3,
  closeGameThreshold: number = 10
): Array<{
  teamA: string;
  teamB: string;
  games: number;
  closeGames: number;
  avgMargin: number;
  intensity: "casual" | "competitive" | "heated" | "bitter";
}> {
  if (!matchups) return [];

  const headToHeadMap = new Map<string, {
    games: number;
    totalMargin: number;
    closeGames: number;
    upsets: number;
  }>();

  matchups.forEach(matchup => {
    const key = [matchup.teamA, matchup.teamB].sort().join('|');
    const margin = Math.abs(matchup.scoreA - matchup.scoreB);
    const isCloseGame = margin <= closeGameThreshold;
    const isUpset = matchup.isUpset || false;

    if (!headToHeadMap.has(key)) {
      headToHeadMap.set(key, {
        games: 0,
        totalMargin: 0,
        closeGames: 0,
        upsets: 0,
      });
    }

    const record = headToHeadMap.get(key)!;
    record.games++;
    record.totalMargin += margin;
    if (isCloseGame) record.closeGames++;
    if (isUpset) record.upsets++;
  });

  const rivalries: Array<{
    teamA: string;
    teamB: string;
    games: number;
    closeGames: number;
    avgMargin: number;
    intensity: "casual" | "competitive" | "heated" | "bitter";
  }> = [];

  headToHeadMap.forEach((record, key) => {
    if (record.games >= minGames) {
      const [teamA, teamB] = key.split('|');
      const avgMargin = record.totalMargin / record.games;
      const closeGameRatio = record.closeGames / record.games;

      // Determine intensity based on metrics
      let intensity: "casual" | "competitive" | "heated" | "bitter";
      if (closeGameRatio >= 0.75 && record.upsets >= 2) {
        intensity = "bitter";
      } else if (closeGameRatio >= 0.5 || record.upsets >= 1) {
        intensity = "heated";
      } else if (avgMargin <= 15) {
        intensity = "competitive";
      } else {
        intensity = "casual";
      }

      rivalries.push({
        teamA,
        teamB,
        games: record.games,
        closeGames: record.closeGames,
        avgMargin,
        intensity,
      });
    }
  });

  return rivalries.sort((a, b) => b.closeGames - a.closeGames);
}

// Calculate optimal lineup points left on bench
export function calculateBenchPoints(
  roster: NonNullable<LeagueDataContext['teams'][0]['roster']>,
  lineupPositions: string[] = ['QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'TE', 'FLEX', 'K', 'DST']
): number {
  if (!roster || roster.length === 0) return 0;

  // Get players who played (have points)
  const playersWithPoints = roster.filter(p => 
    p.stats?.appliedTotal !== undefined && p.stats.appliedTotal > 0
  );

  // Separate starters and bench
  const starters = playersWithPoints.filter(p => p.lineupSlotId !== undefined && p.lineupSlotId < 20);
  const bench = playersWithPoints.filter(p => p.lineupSlotId === undefined || p.lineupSlotId >= 20);

  // Calculate optimal lineup
  const optimalLineup = calculateOptimalLineup(playersWithPoints, lineupPositions);
  const actualPoints = starters.reduce((sum, p) => sum + (p.stats?.appliedTotal || 0), 0);
  const optimalPoints = optimalLineup.reduce((sum, p) => sum + (p.stats?.appliedTotal || 0), 0);

  return Math.max(0, optimalPoints - actualPoints);
}

// Helper: Calculate optimal lineup from available players
function calculateOptimalLineup(
  players: NonNullable<LeagueDataContext['teams'][0]['roster']>,
  positions: string[]
): NonNullable<LeagueDataContext['teams'][0]['roster']> {
  const selected: typeof players = [];
  const available = [...players].sort((a, b) => 
    (b.stats?.appliedTotal || 0) - (a.stats?.appliedTotal || 0)
  );

  // Fill each position with best available
  positions.forEach(pos => {
    let bestPlayer: typeof players[0] | null = null;
    let bestIndex = -1;

    available.forEach((player, index) => {
      if (canPlayPosition(player, pos) && 
          (!bestPlayer || (player.stats?.appliedTotal || 0) > (bestPlayer.stats?.appliedTotal || 0))) {
        bestPlayer = player;
        bestIndex = index;
      }
    });

    if (bestPlayer && bestIndex !== -1) {
      selected.push(bestPlayer);
      available.splice(bestIndex, 1);
    }
  });

  return selected;
}

// Helper: Check if player can play a position
function canPlayPosition(
  player: NonNullable<LeagueDataContext['teams'][0]['roster']>[0],
  position: string
): boolean {
  if (position === 'FLEX') {
    return ['RB', 'WR', 'TE'].includes(player.position);
  }
  return player.position === position || 
         (player.eligiblePositions?.includes(position) ?? false);
}

// Analyze transaction trends
export function analyzeTransactionTrends(
  transactions: LeagueDataContext['transactions'],
  weekWindow: number = 4
): {
  hotPickups: Array<{ playerName: string; position: string; pickupCount: number; }>;
  frequentDrops: Array<{ playerName: string; position: string; dropCount: number; }>;
  mostActiveTeams: Array<{ teamName: string; transactionCount: number; }>;
} {
  if (!transactions || transactions.length === 0) {
    return { hotPickups: [], frequentDrops: [], mostActiveTeams: [] };
  }

  const pickupCounts = new Map<string, { playerName: string; position: string; count: number; }>();
  const dropCounts = new Map<string, { playerName: string; position: string; count: number; }>();
  const teamActivity = new Map<string, number>();

  transactions.forEach(trans => {
    // Track team activity
    teamActivity.set(trans.teamName, (teamActivity.get(trans.teamName) || 0) + 1);

    // Track pickups
    if (trans.playerAdded) {
      const key = trans.playerAdded.playerId;
      if (!pickupCounts.has(key)) {
        pickupCounts.set(key, {
          playerName: trans.playerAdded.playerName,
          position: trans.playerAdded.position,
          count: 0,
        });
      }
      pickupCounts.get(key)!.count++;
    }

    // Track drops
    if (trans.playerDropped) {
      const key = trans.playerDropped.playerId;
      if (!dropCounts.has(key)) {
        dropCounts.set(key, {
          playerName: trans.playerDropped.playerName,
          position: trans.playerDropped.position,
          count: 0,
        });
      }
      dropCounts.get(key)!.count++;
    }
  });

  // Convert to sorted arrays
  const hotPickups = Array.from(pickupCounts.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, 10)
    .map(p => ({ playerName: p.playerName, position: p.position, pickupCount: p.count }));

  const frequentDrops = Array.from(dropCounts.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, 10)
    .map(p => ({ playerName: p.playerName, position: p.position, dropCount: p.count }));

  const mostActiveTeams = Array.from(teamActivity.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([teamName, count]) => ({ teamName, transactionCount: count }));

  return { hotPickups, frequentDrops, mostActiveTeams };
}

// Calculate playoff probabilities (simplified)
export function calculatePlayoffProbabilities(
  standings: LeagueDataContext['standings'],
  remainingWeeks: number,
  playoffTeams: number = 6
): Array<{ teamId: string; teamName: string; probability: number; }> {
  if (!standings || standings.length === 0) return [];

  return standings.map(team => {
    // Simple probability based on current position and games remaining
    const currentPosition = team.rank;
    const gamesBack = team.wins - standings[0].wins;
    
    let probability: number;
    if (currentPosition <= playoffTeams) {
      // Currently in playoffs
      probability = Math.max(0.5, 1 - (gamesBack * 0.1) - (remainingWeeks * 0.02));
    } else {
      // Currently out of playoffs
      const spotsOut = currentPosition - playoffTeams;
      probability = Math.max(0, 0.5 - (spotsOut * 0.15) - (gamesBack * 0.1));
    }

    return {
      teamId: team.teamId,
      teamName: team.team,
      probability: Math.min(1, Math.max(0, probability)),
    };
  });
}

// Find memorable moments in matchups
export function identifyMemorableMoments(
  matchup: NonNullable<LeagueDataContext['recentMatchups']>[0]
): string | undefined {
  const margin = Math.abs(matchup.scoreA - matchup.scoreB);
  const totalScore = matchup.scoreA + matchup.scoreB;
  
  // Check for various memorable scenarios
  if (margin <= 1) {
    return "Decided by less than a point!";
  }
  
  if (margin >= 50) {
    return "Absolute blowout victory";
  }
  
  if (matchup.isUpset && margin <= 10) {
    return "Stunning upset victory";
  }
  
  if (totalScore >= 300) {
    return "Offensive explosion";
  }
  
  if (totalScore <= 150) {
    return "Defensive struggle";
  }
  
  if (matchup.projectedScoreA && matchup.projectedScoreB) {
    const projectedWinner = matchup.projectedScoreA > matchup.projectedScoreB ? 'A' : 'B';
    const actualWinner = matchup.scoreA > matchup.scoreB ? 'A' : 'B';
    
    if (projectedWinner !== actualWinner && margin >= 20) {
      return "Complete reversal of projections";
    }
  }
  
  if (matchup.benchPointsA && matchup.benchPointsA >= 50) {
    return `Left ${matchup.benchPointsA.toFixed(0)} points on the bench`;
  }
  
  return undefined;
}

// Export all helpers
export const dataAggregationHelpers = {
  calculateStrengthOfSchedule,
  calculateRecentForm,
  detectRivalries,
  calculateBenchPoints,
  analyzeTransactionTrends,
  calculatePlayoffProbabilities,
  identifyMemorableMoments,
};