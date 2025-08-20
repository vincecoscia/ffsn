import { v } from "convex/values";
import { query, internalQuery } from "./_generated/server";
import { Id, Doc } from "./_generated/dataModel";

// Interface for simplified draft data for AI generation
export interface SimplifiedDraftPick {
  teamName: string;
  teamAbbreviation: string;
  teamOwner: string;
  pickNumber: number;
  roundNumber: number;
  roundPickNumber: number;
  playerName: string;
  playerPosition: string;
  playerTeam: string;
  playerProjectedPoints: number | null;
  playerADP: number | null;
  perceivedValue: number; // Formula-based value assessment
}

export interface DraftStrategy {
  strategy: "Hero RB" | "Hero WR" | "Balanced" | "Zero RB" | "Zero WR" | "TE Premium" | "QB Early" | "Unknown";
  confidence: number; // 0-1 scale
  reasoning: string;
}

export interface TeamDraftGrade {
  teamName: string;
  teamOwner: string;
  grade: "A+" | "A" | "A-" | "B+" | "B" | "B-" | "C+" | "C" | "C-" | "D+" | "D" | "F";
  gradeScore: number; // 0-100 numerical score
  strategy: DraftStrategy;
  bestPicks: SimplifiedDraftPick[];
  worstPicks: SimplifiedDraftPick[];
  projectedStarterPoints: number;
  benchDepthScore: number; // 0-100
  reasoning: string;
}

// Helper function for the actual logic
async function getSimplifiedDraftDataImpl(ctx: any, args: {
  leagueId: Id<"leagues">;
  seasonId: number;
}): Promise<{
  draftPicks: SimplifiedDraftPick[];
  teamGrades: TeamDraftGrade[];
  draftOrder: Array<{
    position: number;
    teamId: string;
    teamName: string;
    manager: string;
  }>;
  leagueInfo: {
    name: string;
    teamCount: number;
    scoringType: string;
    draftType: string;
  };
}> {
    console.log(`=== getSimplifiedDraftData START ===`);
    console.log(`League: ${args.leagueId}, Season: ${args.seasonId}`);

    // Get league info
    const league = await ctx.db.get(args.leagueId);
    if (!league) {
      throw new Error("League not found");
    }

    // Get draft transactions from transactions table (like the transactions page does)
    const draftTransactions = await ctx.db
      .query("transactions")
      .withIndex("by_season", (q: any) => 
        q.eq("leagueId", args.leagueId).eq("seasonId", args.seasonId)
      )
      .filter((q: any) => q.eq(q.field("type"), "DRAFT"))
      .collect();

    console.log(`Found ${draftTransactions.length} draft transactions`);

    if (draftTransactions.length === 0) {
      return {
        draftPicks: [],
        teamGrades: [],
        draftOrder: [],
        leagueInfo: {
          name: league.name,
          teamCount: 0,
          scoringType: league.settings?.scoringType || "PPR",
          draftType: "Snake", // Default assumption
        },
      };
    }

    // Get teams for this season
    const teams = await ctx.db
      .query("teams")
      .withIndex("by_season", (q: any) => 
        q.eq("leagueId", args.leagueId).eq("seasonId", args.seasonId)
      )
      .collect();

    console.log(`Found ${teams.length} teams for season ${args.seasonId}`);

    interface TeamData {
      name: string;
      abbreviation: string;
      owner: string;
      _id: Id<"teams">;
    }

    const teamMap = new Map<string, TeamData>(
      teams.map((team: Doc<"teams">) => [team.externalId.toString(), {
        name: team.name,
        abbreviation: team.abbreviation || team.name.substring(0, 3).toUpperCase(),
        owner: team.owner,
        _id: team._id,
      }])
    );

    // Get draft order from leagueSeasons.draftSettings.pickOrder
    const leagueSeason = await ctx.db
      .query("leagueSeasons")
      .withIndex("by_league_season", (q: any) => 
        q.eq("leagueId", args.leagueId).eq("seasonId", args.seasonId)
      )
      .first();

    let draftOrder: Array<{
      position: number;
      teamId: string;
      teamName: string;
      manager: string;
    }> = [];

    if (leagueSeason?.draftSettings?.pickOrder) {
      // pickOrder is array of ESPN team IDs (as numbers)
      draftOrder = leagueSeason.draftSettings.pickOrder.map((espnTeamId: number, index: number) => {
        const team = teamMap.get(espnTeamId.toString());
        return {
          position: index + 1,
          teamId: espnTeamId.toString(),
          teamName: team ? team.name : `Team ${espnTeamId}`,
          manager: team ? team.owner : "Unknown",
        };
      });
      console.log(`Found draft order for ${draftOrder.length} teams`);
    } else {
      console.log("No draft order found in leagueSeasons.draftSettings.pickOrder");
    }

    // Get all players involved in draft
    const playerSeasonPairs = new Set<string>();
    draftTransactions.forEach((transaction: any) => {
      transaction.items.forEach((item: any) => {
        const key = `${item.playerId}:${transaction.seasonId}`;
        playerSeasonPairs.add(key);
      });
    });

    console.log(`Found ${playerSeasonPairs.size} unique players in draft`);

    // Fetch player information with projections (like transactions page does)
    const players = await Promise.all(
      Array.from(playerSeasonPairs).map(async (playerSeasonKey) => {
        const [playerId, seasonId] = playerSeasonKey.split(':');
        const player = await ctx.db
          .query("playersEnhanced")
          .withIndex("by_espn_id_season", (q: any) => 
            q.eq("espnId", playerId).eq("season", parseInt(seasonId))
          )
          .first();
        return player ? { [playerId]: player } : null;
      })
    );

    const playerMap = new Map(
      players
        .filter(p => p !== null)
        .map(p => [Object.keys(p!)[0], Object.values(p!)[0]])
    );

    console.log(`Found player data for ${playerMap.size} players`);

    // Process draft transactions into simplified format
    const simplifiedPicks: SimplifiedDraftPick[] = [];
    
    draftTransactions.forEach((transaction: any) => {
      transaction.items.forEach((item: any) => {
        const team = teamMap.get(item.toTeamId.toString());
        const player = playerMap.get(item.playerId.toString());

        if (team && player) {
          // Get projected points from player stats array
          let projectedPoints: number | null = null;
          
          // Look for projected stats in the stats array
          if (player.stats && Array.isArray(player.stats)) {
            const projectedStat = player.stats.find((stat: any) => 
              stat.scoringPeriodId === 0 && 
              stat.statSourceId === 1 && 
              stat.seasonId === args.seasonId
            );
            
            if (projectedStat && typeof projectedStat.appliedTotal === 'number') {
              projectedPoints = projectedStat.appliedTotal;
              console.log(`Found projected points for ${player.fullName}: ${projectedPoints}`);
            }
          }

          // Get ADP from ownership data
          const adp = player.ownership?.averageDraftPosition || null;

          // Calculate perceived value (how good this pick was relative to ADP and draft position)
          const perceivedValue = calculatePerceivedValue(
            item.overallPickNumber || 999,
            adp,
            projectedPoints,
            teams.length
          );

          simplifiedPicks.push({
            teamName: team.name,
            teamAbbreviation: team.abbreviation,
            teamOwner: team.owner,
            pickNumber: item.overallPickNumber || 999,
            roundNumber: Math.ceil((item.overallPickNumber || 999) / teams.length),
            roundPickNumber: ((item.overallPickNumber || 1) - 1) % teams.length + 1,
            playerName: player.fullName,
            playerPosition: player.defaultPosition,
            playerTeam: player.proTeamAbbrev || "FA",
            playerProjectedPoints: projectedPoints,
            playerADP: adp,
            perceivedValue,
          });
        }
      });
    });

    // Sort picks by pick number
    simplifiedPicks.sort((a, b) => a.pickNumber - b.pickNumber);

    // Analyze draft strategies and generate grades for each team
    const teamGrades = generateTeamGrades(simplifiedPicks, teams.length, league.settings?.scoringType || "PPR");

    console.log(`=== getSimplifiedDraftData COMPLETE ===`);
    console.log(`Processed ${simplifiedPicks.length} draft picks for ${teams.length} teams`);

    return {
      draftPicks: simplifiedPicks,
      teamGrades,
      draftOrder,
      leagueInfo: {
        name: league.name,
        teamCount: teams.length,
        scoringType: league.settings?.scoringType || "PPR",
        draftType: "Snake", // TODO: Determine from league settings if available
      },
    };
}

// Get simplified draft data for AI generation
export const getSimplifiedDraftData = internalQuery({
  args: {
    leagueId: v.id("leagues"),
    seasonId: v.number(),
  },
  handler: async (ctx, args) => {
    return getSimplifiedDraftDataImpl(ctx, args);
  },
});

// Get reasonable max points by position to prevent inflation
function getMaxPointsByPosition(position: string): number {
  switch (position?.toUpperCase()) {
    case 'QB': return 400;  // Top QBs ~350-400 points
    case 'RB': return 350;  // Elite RBs ~300-350 points  
    case 'WR': return 300;  // Top WRs ~250-300 points
    case 'TE': return 250;  // Elite TEs ~200-250 points
    case 'K': return 150;   // Top kickers ~120-150 points
    case 'D/ST': return 200; // Top defenses ~150-200 points
    default: return 300;
  }
}

// Calculate perceived value of a draft pick
function calculatePerceivedValue(
  draftPosition: number,
  adp: number | null,
  projectedPoints: number | null,
  teamCount: number
): number {
  let value = 0;

  // ADP value component (50% of total) - corrected logic
  if (adp !== null) {
    // STEAL: drafted later than ADP (draftPosition > adp) = positive value
    // REACH: drafted earlier than ADP (draftPosition < adp) = negative value
    // Example: ADP 2.2, picked at 11 = STEAL (11 > 2.2), should be positive
    // Example: ADP 50.3, picked at 25 = REACH (25 < 50.3), should be negative
    
    // Simple approach: if drafted later than ADP, it's good value (positive)
    // Moderate impact to allow points-based variance to dominate
    if (draftPosition > adp) {
      // Steal: positive value proportional to how much later
      const stealValue = (draftPosition - adp) / (teamCount * 7) * 40; // Slightly reduced impact to favor points
      value += stealValue;
    } else {
      // Reach: negative value proportional to how much earlier
      const reachValue = (adp - draftPosition) / (teamCount * 7) * 40; // Slightly reduced impact to favor points
      value -= reachValue;
    }
  }

  // Note: Projected points component will be calculated later with position averages
  // This is just a placeholder for now
  const projectedPointsValue = 0; // Will be calculated in generateTeamGrades
  value += projectedPointsValue;

  // Draft position bonus/penalty (20% of total) - reduce since ADP captures this
  const positionValue = (teamCount * 16 - draftPosition) / (teamCount * 16) * 20;
  value += positionValue;

  // Normalize to -100 to +100 scale
  return Math.max(-100, Math.min(100, value));
}

// Calculate dynamic expected points based on actual draft data
function calculatePositionAverages(picks: SimplifiedDraftPick[]): {
  averagesByPosition: Record<string, { avg: number; stdDev: number; min: number; max: number }>;
  overallAverage: number;
} {
  // Group picks by position
  const positionGroups: Record<string, number[]> = {};
  
  picks.forEach(pick => {
    if (pick.playerProjectedPoints !== null) {
      const position = pick.playerPosition;
      if (!positionGroups[position]) {
        positionGroups[position] = [];
      }
      positionGroups[position].push(pick.playerProjectedPoints);
    }
  });

  // Calculate stats for each position
  const averagesByPosition: Record<string, { avg: number; stdDev: number; min: number; max: number }> = {};
  let totalPoints = 0;
  let totalPlayers = 0;

  Object.entries(positionGroups).forEach(([position, points]) => {
    const avg = points.reduce((sum, p) => sum + p, 0) / points.length;
    const variance = points.reduce((sum, p) => sum + Math.pow(p - avg, 2), 0) / points.length;
    const stdDev = Math.sqrt(variance);
    const min = Math.min(...points);
    const max = Math.max(...points);

    averagesByPosition[position] = { avg, stdDev, min, max };
    totalPoints += points.reduce((sum, p) => sum + p, 0);
    totalPlayers += points.length;
  });

  const overallAverage = totalPoints / totalPlayers;

  return { averagesByPosition, overallAverage };
}

// Get expected fantasy points based on position averages
function getExpectedPointsByPosition(
  draftPosition: number, 
  teamCount: number, 
  playerPosition: string,
  positionAverages: Record<string, { avg: number; stdDev: number; min: number; max: number }>
): number {
  // Use position average if available, otherwise use overall draft average
  if (positionAverages[playerPosition]) {
    return positionAverages[playerPosition].avg;
  }
  
  // Fallback to round-based estimates if position not found
  const round = Math.ceil(draftPosition / teamCount);
  const fallbackByRound: Record<number, number> = {
    1: 300, 2: 250, 3: 200, 4: 170, 5: 150, 6: 130, 7: 110, 8: 100,
    9: 90, 10: 80, 11: 70, 12: 60, 13: 50, 14: 40, 15: 30, 16: 20
  };
  return fallbackByRound[round] || 20;
}

// Generate team grades based on draft performance
function generateTeamGrades(picks: SimplifiedDraftPick[], teamCount: number, scoringType: string): TeamDraftGrade[] {
  // Calculate position averages from all draft picks
  const { averagesByPosition, overallAverage } = calculatePositionAverages(picks);
  
  console.log('Position averages calculated:', averagesByPosition);
  console.log('Overall average:', overallAverage);

  // Recalculate perceived values with position-based projected points comparison
  const updatedPicks = picks.map(pick => {
    if (pick.playerProjectedPoints !== null) {
      const expectedPoints = getExpectedPointsByPosition(
        pick.pickNumber, 
        teamCount, 
        pick.playerPosition,
        averagesByPosition
      );
      
      // Calculate projected points component using standard deviation
      const positionStats = averagesByPosition[pick.playerPosition];
      let projectedPointsValue = 0;
      
      if (positionStats) {
        // Use z-score to determine how many standard deviations above/below average
        const zScore = (pick.playerProjectedPoints - positionStats.avg) / positionStats.stdDev;
        // Cap z-score at ±2 (within 95% of normal distribution) and scale to ±30 points
        const cappedZScore = Math.max(-2, Math.min(2, zScore));
        projectedPointsValue = cappedZScore * 15; // ±30 point swing max
      }
      
      // Recalculate perceived value with projected points component
      let newPerceivedValue = pick.perceivedValue + projectedPointsValue;
      newPerceivedValue = Math.max(-100, Math.min(100, newPerceivedValue));
      
      return { ...pick, perceivedValue: newPerceivedValue };
    }
    return pick;
  });

  // Group picks by team
  const picksByTeam = updatedPicks.reduce((acc, pick) => {
    if (!acc[pick.teamName]) {
      acc[pick.teamName] = [];
    }
    acc[pick.teamName].push(pick);
    return acc;
  }, {} as Record<string, SimplifiedDraftPick[]>);

  const grades: TeamDraftGrade[] = [];

  Object.entries(picksByTeam).forEach(([teamName, teamPicks]) => {
    // Sort team picks by pick number
    teamPicks.sort((a, b) => a.pickNumber - b.pickNumber);

    // Analyze draft strategy
    const strategy = analyzeDraftStrategy(teamPicks);

    // Calculate projected starter points (first 9-10 picks typically)
    const starterPicks = teamPicks.slice(0, Math.min(10, teamPicks.length));
    const projectedStarterPoints = starterPicks.reduce((sum, pick) => 
      sum + (pick.playerProjectedPoints || 0), 0
    );

    // Calculate bench depth score
    const benchPicks = teamPicks.slice(10);
    const benchDepthScore = calculateBenchDepthScore(benchPicks);

    // Find best and worst picks based on perceived value
    // Filter out D/ST and K unless drafted in first 13 picks (before last 2 picks of each team in 15-round draft)
    const eligiblePicks = teamPicks.filter(pick => {
      const isDefenseOrKicker = pick.playerPosition === 'D/ST' || pick.playerPosition === 'K';
      if (!isDefenseOrKicker) return true; // Always include skill position players
      
      // Only include D/ST or K if drafted unusually early (before pick 14 of their team's picks)
      const teamPickNumber = teamPicks.filter(p => p.pickNumber <= pick.pickNumber).length;
      return teamPickNumber <= 13; // Include D/ST/K only if drafted in first 13 team picks
    });
    
    const sortedByValue = [...eligiblePicks].sort((a, b) => b.perceivedValue - a.perceivedValue);
    const bestPicks = sortedByValue.slice(0, 3);
    const worstPicks = sortedByValue.slice(-2);

    // Calculate overall grade score (pass all picks for league-wide comparison)
    const gradeScore = calculateGradeScore(teamPicks, projectedStarterPoints, benchDepthScore, updatedPicks);
    
    // Store team data without grade for now (will assign dynamically)
    grades.push({
      teamName,
      teamOwner: teamPicks[0].teamOwner,
      grade: "C" as any, // Temporary, will be updated
      gradeScore,
      strategy,
      bestPicks,
      worstPicks,
      projectedStarterPoints,
      benchDepthScore,
      reasoning: "", // Will be generated after grade assignment
    });
  });

  // Calculate league-wide statistics for dynamic grading
  const allScores = grades.map(g => g.gradeScore);
  const avgScore = allScores.reduce((sum, score) => sum + score, 0) / allScores.length;
  const variance = allScores.reduce((sum, score) => sum + Math.pow(score - avgScore, 2), 0) / allScores.length;
  const stdDev = Math.sqrt(variance);
  
  console.log(`=== DYNAMIC GRADING STATS ===`);
  console.log(`Average score: ${avgScore.toFixed(2)}`);
  console.log(`Standard deviation: ${stdDev.toFixed(2)}`);
  console.log(`Score range: ${Math.min(...allScores).toFixed(2)} - ${Math.max(...allScores).toFixed(2)}`);

  // Now assign dynamic grades and generate reasoning
  grades.forEach(teamGrade => {
    const grade = convertToLetterGrade(teamGrade.gradeScore, avgScore, stdDev);
    const reasoning = generateGradeReasoning(
      updatedPicks.filter(p => p.teamName === teamGrade.teamName),
      teamGrade.strategy,
      teamGrade.gradeScore,
      teamGrade.bestPicks,
      teamGrade.worstPicks
    );
    
    teamGrade.grade = grade;
    teamGrade.reasoning = reasoning;
  });

  // Sort grades by score (highest first)
  grades.sort((a, b) => b.gradeScore - a.gradeScore);

  return grades;
}

// Analyze draft strategy based on pick patterns
function analyzeDraftStrategy(picks: SimplifiedDraftPick[]): DraftStrategy {
  if (picks.length < 3) {
    return {
      strategy: "Unknown",
      confidence: 0,
      reasoning: "Not enough picks to analyze strategy"
    };
  }

  const firstThreePicks = picks.slice(0, 3);
  const firstFivePicks = picks.slice(0, Math.min(5, picks.length));

  // Count positions in early picks
  const positionCounts = firstFivePicks.reduce((acc, pick) => {
    acc[pick.playerPosition] = (acc[pick.playerPosition] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  // Hero RB strategy: RB in first 2 picks, then other positions
  if (firstThreePicks[0].playerPosition === "RB" && 
      (positionCounts.RB || 0) >= 2 && 
      firstThreePicks.slice(1).every(p => p.playerPosition !== "RB")) {
    return {
      strategy: "Hero RB",
      confidence: 0.8,
      reasoning: "Drafted RB early then avoided position, classic Hero RB approach"
    };
  }

  // Hero WR strategy: WR heavy early, minimal RB
  if ((positionCounts.WR || 0) >= 3 && (positionCounts.RB || 0) <= 1) {
    return {
      strategy: "Hero WR",
      confidence: 0.7,
      reasoning: "Heavy WR investment early with minimal RB commitment"
    };
  }

  // Zero RB: No RB in first 3-4 picks
  if (firstThreePicks.every(p => p.playerPosition !== "RB")) {
    return {
      strategy: "Zero RB",
      confidence: 0.8,
      reasoning: "Avoided RB completely in early rounds, Zero RB strategy"
    };
  }

  // Zero WR: No WR in first 3-4 picks  
  if (firstThreePicks.every(p => p.playerPosition !== "WR")) {
    return {
      strategy: "Zero WR",
      confidence: 0.7,
      reasoning: "Avoided WR in early rounds, focusing on other positions first"
    };
  }

  // QB Early: QB in first 3 picks
  if (firstThreePicks.some(p => p.playerPosition === "QB")) {
    return {
      strategy: "QB Early",
      confidence: 0.9,
      reasoning: "Drafted QB early, prioritizing the position"
    };
  }

  // TE Premium: TE in first 4 picks
  if (firstFivePicks.slice(0, 4).some(p => p.playerPosition === "TE")) {
    return {
      strategy: "TE Premium",
      confidence: 0.7,
      reasoning: "Invested early draft capital in TE position"
    };
  }

  // Balanced: Mix of RB/WR in first few picks
  if ((positionCounts.RB || 0) >= 2 && (positionCounts.WR || 0) >= 2) {
    return {
      strategy: "Balanced",
      confidence: 0.6,
      reasoning: "Balanced approach with mix of RB and WR early"
    };
  }

  return {
    strategy: "Unknown",
    confidence: 0.3,
    reasoning: "Draft pattern doesn't clearly fit standard strategies"
  };
}

// Calculate bench depth score (0-100)
function calculateBenchDepthScore(benchPicks: SimplifiedDraftPick[]): number {
  if (benchPicks.length === 0) return 50; // Neutral if no bench picks

  // Average perceived value of bench picks
  const avgValue = benchPicks.reduce((sum, pick) => sum + pick.perceivedValue, 0) / benchPicks.length;
  
  // Convert to 0-100 scale (50 is average)
  return Math.max(0, Math.min(100, 50 + avgValue));
}

// Calculate overall grade score (0-100)
function calculateGradeScore(
  picks: SimplifiedDraftPick[], 
  projectedStarterPoints: number, 
  benchDepthScore: number,
  allLeaguePicks: SimplifiedDraftPick[]
): number {
  // Average perceived value of all picks (25% weight) - extreme variance
  const avgPerceivedValue = picks.reduce((sum, pick) => sum + pick.perceivedValue, 0) / picks.length;
  // Very low baseline with extreme amplification for maximum volatility
  const valueScore = Math.max(15, Math.min(100, 60 + (avgPerceivedValue * 3.0))); // Very low baseline, extreme amplification

  // Projected points component (30% weight) - dynamic range based on actual draft data
  // Calculate all teams' starter points for comparison using ALL league picks
  const allTeamStarterPoints: Record<string, number> = {};
  
  // Group ALL league picks by team and sum up starter points (first ~9 picks per team)
  allLeaguePicks.forEach(pick => {
    if (pick.playerProjectedPoints !== null) {
      if (!allTeamStarterPoints[pick.teamName]) {
        allTeamStarterPoints[pick.teamName] = 0;
      }
      // Count pick as starter if it's in the first 9 picks for that team
      const teamPicksSoFar = allLeaguePicks.filter(p => 
        p.teamName === pick.teamName && p.pickNumber <= pick.pickNumber
      ).length;
      
      if (teamPicksSoFar <= 9) { // First 9 picks are starters
        allTeamStarterPoints[pick.teamName] += pick.playerProjectedPoints;
      }
    }
  });
  
  const starterPointsArray = Object.values(allTeamStarterPoints);
  const avgTeamStarterPoints = starterPointsArray.reduce((sum, pts) => sum + pts, 0) / starterPointsArray.length;
  const variance = starterPointsArray.reduce((sum, pts) => sum + Math.pow(pts - avgTeamStarterPoints, 2), 0) / starterPointsArray.length;
  const stdDev = Math.sqrt(variance);
  
  console.log(`=== POINTS SCORE DEBUG ===`);
  console.log(`Current team projected starter points: ${projectedStarterPoints}`);
  console.log(`League average starter points: ${avgTeamStarterPoints}`);
  console.log(`Standard deviation: ${stdDev}`);
  console.log(`All team starter points:`, allTeamStarterPoints);
  console.log(`Starter points array:`, starterPointsArray);
  
  // Use z-score to determine points score with 75 as average
  let pointsScore = 75; // Default to average
  let zScore = 0;
  
  if (stdDev > 0) { // Avoid division by zero
    zScore = (projectedStarterPoints - avgTeamStarterPoints) / stdDev;
    const cappedZScore = Math.max(-4, Math.min(4, zScore)); // Cap at ±4 std devs for extreme values
    pointsScore = Math.max(10, Math.min(100, 75 + (cappedZScore * 25))); // 75 ± 100 points, extremely wide range, very low floor
    console.log(`Z-Score: ${zScore}, Capped Z-Score: ${cappedZScore}, Final Points Score: ${pointsScore}`);
  } else {
    console.log(`Standard deviation is 0, using default points score: ${pointsScore}`);
  }
  
  console.log(`=== END POINTS SCORE DEBUG ===`);

  // Bench depth (15% weight) - very low floor for extreme variance
  const depthScore = Math.max(20, benchDepthScore); // Very low floor for extreme variance

  // Weighted average with extreme emphasis on projected points for maximum volatility
  const finalScore = (valueScore * 0.20) + (pointsScore * 0.70) + (depthScore * 0.10);

  return Math.max(0, Math.min(100, finalScore));
}

// Convert numerical score to letter grade using dynamic thresholds
function convertToLetterGrade(score: number, avgScore: number, stdDev: number): TeamDraftGrade["grade"] {
  // Use z-score to determine grade relative to league average
  const zScore = stdDev > 0 ? (score - avgScore) / stdDev : 0;
  
  // Dynamic grading based on standard deviations from average
  // C is exactly average (z-score = 0)
  if (zScore >= 2.5) return "A+";   // 2.5+ std devs above average (~1% of teams)
  if (zScore >= 1.5) return "A";    // 1.5-2.5 std devs above average (~6% of teams)
  if (zScore >= 0.8) return "A-";   // 0.8-1.5 std devs above average (~15% of teams)
  if (zScore >= 0.3) return "B+";   // 0.3-0.8 std devs above average (~20% of teams)
  if (zScore >= -0.3) return "B";   // -0.3 to 0.3 std devs (around average, ~24% of teams)
  if (zScore >= -0.8) return "B-";  // -0.8 to -0.3 std devs below average (~20% of teams)
  if (zScore >= -1.5) return "C+";  // -1.5 to -0.8 std devs below average (~15% of teams)
  if (zScore >= -2.5) return "C";   // -2.5 to -1.5 std devs below average (~6% of teams)
  if (zScore >= -3.5) return "C-";  // -3.5 to -2.5 std devs below average (~1% of teams)
  if (zScore >= -4.5) return "D+";  // -4.5 to -3.5 std devs below average (~0.5% of teams)
  if (zScore >= -5.5) return "D";   // -5.5 to -4.5 std devs below average (~0.2% of teams)
  return "F";                       // Below -5.5 std devs (disaster teams)
}

// Generate reasoning text for grade
function generateGradeReasoning(
  picks: SimplifiedDraftPick[],
  strategy: DraftStrategy,
  gradeScore: number,
  bestPicks: SimplifiedDraftPick[],
  worstPicks: SimplifiedDraftPick[]
): string {
  const parts: string[] = [];

  // Strategy assessment
  parts.push(`Employed ${strategy.strategy} strategy with ${Math.round(strategy.confidence * 100)}% confidence.`);

  // Overall performance
  if (gradeScore >= 85) {
    parts.push("Excellent draft execution with strong value picks throughout.");
  } else if (gradeScore >= 75) {
    parts.push("Solid draft with good value in key spots.");
  } else if (gradeScore >= 65) {
    parts.push("Average draft performance with some missed opportunities.");
  } else {
    parts.push("Below-average draft with several questionable picks.");
  }

  // Best pick highlight
  if (bestPicks.length > 0) {
    const best = bestPicks[0];
    parts.push(`Best pick: ${best.playerName} (${best.playerPosition}) at ${best.pickNumber} overall.`);
  }

  // Worst pick if significant (only for skill position players or early D/ST/K picks)
  if (worstPicks.length > 0 && worstPicks[0].perceivedValue < -20) {
    const worst = worstPicks[0];
    parts.push(`Biggest reach: ${worst.playerName} (${worst.playerPosition}) at ${worst.pickNumber} overall.`);
  }

  return parts.join(" ");
}

// Public query wrapper for testing
export const getSimplifiedDraftDataPublic = query({
  args: {
    leagueId: v.id("leagues"),
    seasonId: v.number(),
  },
  handler: async (ctx, args) => {
    // Check if user has access to this league
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Not authenticated");
    }

    const membership = await ctx.db
      .query("leagueMemberships")
      .withIndex("by_league_user", (q) => 
        q.eq("leagueId", args.leagueId).eq("userId", identity.subject)
      )
      .first();

    if (!membership) {
      throw new Error("Not a member of this league");
    }

    // Call the shared implementation function
    return getSimplifiedDraftDataImpl(ctx, args);
  },
});

// Test function to analyze draft grades with detailed breakdown (no auth for testing)
export const testDraftGrades = query({
  args: {
    leagueId: v.id("leagues"),
    seasonId: v.number(),
  },
  handler: async (ctx, args) => {
    // Skip auth checks for testing purposes
    console.log(`Testing draft grades for league: ${args.leagueId}, season: ${args.seasonId}`);

    // Get the draft data
    const draftData = await getSimplifiedDraftDataImpl(ctx, args);
    
    // Calculate league-wide starter points statistics for proper points scoring
    const allTeamStarterPoints = draftData.teamGrades.map(team => team.projectedStarterPoints);
    const avgTeamStarterPoints = allTeamStarterPoints.reduce((sum, pts) => sum + pts, 0) / allTeamStarterPoints.length;
    const variance = allTeamStarterPoints.reduce((sum, pts) => sum + Math.pow(pts - avgTeamStarterPoints, 2), 0) / allTeamStarterPoints.length;
    const stdDev = Math.sqrt(variance);
    
    console.log(`Test function - League avg: ${avgTeamStarterPoints}, StdDev: ${stdDev}`);

    // Create detailed breakdown for each team
    const detailedGrades = draftData.teamGrades.map(teamGrade => {
      const teamPicks = draftData.draftPicks.filter(pick => pick.teamName === teamGrade.teamName);
      
      // Calculate component scores using the same logic as the main function
      const avgPerceivedValue = teamPicks.reduce((sum, pick) => sum + pick.perceivedValue, 0) / teamPicks.length;
      const valueScore = Math.max(30, Math.min(100, 65 + (avgPerceivedValue * 1.2)));
      
      // Use dynamic points scoring with 75 as average
      let pointsScore = 75;
      if (stdDev > 0) {
        const zScore = (teamGrade.projectedStarterPoints - avgTeamStarterPoints) / stdDev;
        const cappedZScore = Math.max(-3, Math.min(3, zScore));
        pointsScore = Math.max(0, Math.min(100, 75 + (cappedZScore * 8.33)));
      }
      
      const depthScore = Math.max(40, teamGrade.benchDepthScore);
      
      // Show the weighted calculation using current weights
      const finalScore = (valueScore * 0.45) + (pointsScore * 0.35) + (depthScore * 0.20);
      
      return {
        teamName: teamGrade.teamName,
        teamOwner: teamGrade.teamOwner,
        grade: teamGrade.grade,
        gradeScore: teamGrade.gradeScore,
        breakdown: {
          avgPerceivedValue: Math.round(avgPerceivedValue * 100) / 100,
          valueScore: Math.round(valueScore * 100) / 100,
          pointsScore: Math.round(pointsScore * 100) / 100,
          depthScore: Math.round(depthScore * 100) / 100,
          finalScore: Math.round(finalScore * 100) / 100,
          projectedStarterPoints: teamGrade.projectedStarterPoints,
        },
        strategy: teamGrade.strategy,
        pickDetails: teamPicks.map(pick => ({
          pickNumber: pick.pickNumber,
          playerName: pick.playerName,
          position: pick.playerPosition,
          projectedPoints: pick.playerProjectedPoints,
          adp: pick.playerADP,
          perceivedValue: Math.round(pick.perceivedValue * 100) / 100,
        })),
        bestPicks: teamGrade.bestPicks.map(pick => ({
          playerName: pick.playerName,
          pickNumber: pick.pickNumber,
          perceivedValue: Math.round(pick.perceivedValue * 100) / 100,
        })),
        worstPicks: teamGrade.worstPicks.map(pick => ({
          playerName: pick.playerName,
          pickNumber: pick.pickNumber,
          perceivedValue: Math.round(pick.perceivedValue * 100) / 100,
        })),
      };
    });

    return {
      leagueInfo: draftData.leagueInfo,
      gradingStats: {
        totalTeams: detailedGrades.length,
        gradeDistribution: {
          "A+": detailedGrades.filter(g => g.grade === "A+").length,
          "A": detailedGrades.filter(g => g.grade === "A").length,
          "A-": detailedGrades.filter(g => g.grade === "A-").length,
          "B+": detailedGrades.filter(g => g.grade === "B+").length,
          "B": detailedGrades.filter(g => g.grade === "B").length,
          "B-": detailedGrades.filter(g => g.grade === "B-").length,
          "C+": detailedGrades.filter(g => g.grade === "C+").length,
          "C": detailedGrades.filter(g => g.grade === "C").length,
          "C-": detailedGrades.filter(g => g.grade === "C-").length,
          "D+": detailedGrades.filter(g => g.grade === "D+").length,
          "D": detailedGrades.filter(g => g.grade === "D").length,
          "F": detailedGrades.filter(g => g.grade === "F").length,
        },
        averageGradeScore: Math.round((detailedGrades.reduce((sum, g) => sum + g.gradeScore, 0) / detailedGrades.length) * 100) / 100,
        scoreRange: {
          highest: Math.max(...detailedGrades.map(g => g.gradeScore)),
          lowest: Math.min(...detailedGrades.map(g => g.gradeScore)),
        }
      },
      detailedGrades: detailedGrades.sort((a, b) => b.gradeScore - a.gradeScore),
    };
  },
});
