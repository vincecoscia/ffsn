import { personaPrompts, getPersonaSettings } from './persona-prompts';
import { contentTemplates, ContentTemplate } from './content-templates';

export interface PromptBuilderOptions {
  leagueId: string;
  contentType: string;
  persona: string;
  leagueData: LeagueDataContext;
  customContext?: string;
  includeExamples?: boolean;
}

export interface LeagueDataContext {
  leagueName: string;
  currentWeek: number;
  teams: Array<{
    id: string;
    name: string;
    manager: string;
    record: { wins: number; losses: number; ties: number; pointsFor?: number; pointsAgainst?: number; };
    pointsFor: number;
    pointsAgainst: number;
    externalId?: string; // ESPN team ID for consistency tracking
    roster?: Array<{
      playerId: string;
      playerName: string;
      position: string;
      team: string;
      lineupSlotId?: number;
      acquisitionType?: string;
      fullName?: string;
      eligiblePositions?: string[];
      injuryStatus?: string;
      stats?: {
        appliedTotal?: number;
        projectedTotal?: number;
        seasonStats?: {
          appliedTotal?: number;
          projectedTotal?: number;
          averagePoints?: number;
        };
        weeklyStats?: Array<{
          week: number;
          appliedTotal?: number;
          projectedTotal?: number;
        }>;
      };
      ownership?: {
        percentOwned?: number;
        percentChange?: number;
        percentStarted?: number;
      };
    }>;
  }>;
  previousSeasons?: Record<number, Array<{
    teamId: string;
    teamName: string;
    manager: string;
    record: { wins: number; losses: number; ties: number; pointsFor?: number; pointsAgainst?: number; };
    roster: Array<{
      playerId: string;
      playerName: string;
      position: string;
      team: string;
      acquisitionType: string;
      fullName?: string;
    }>;
  }>>;
  recentMatchups?: Array<{
    teamA: string;
    teamB: string;
    scoreA: number;
    scoreB: number;
    winner?: string;
    week?: number;
    topPerformers: Array<{ 
      playerId?: string;
      playerName?: string;
      points: number; 
      teamId?: string;
      position?: string;
      player?: string; // legacy support
      team?: string; // legacy support
    }>;
  }>;
  trades?: Array<{
    teamA: string;
    teamB: string;
    playersFromA: string[];
    playersFromB: string[];
    date: string;
  }>;
  standings?: Array<{
    rank: number;
    team: string;
    wins: number;
    losses: number;
    pointsFor: number;
  }>;
  scoringType?: string;
  rosterSize?: number;
  leagueHistory?: {
    foundedYear: number;
    totalSeasons: number;
    seasons?: Array<{
      year: number;
      champion?: { teamId: string; teamName: string; owner: string; };
      runnerUp?: { teamId: string; teamName: string; owner: string; };
      regularSeasonChampion?: { teamId: string; teamName: string; owner: string; };
      settings?: { scoringType: string; teamCount: number; playoffWeeks: number; };
    }>;
  };
  [key: string]: unknown;
}

export class PromptBuilder {
  private options: PromptBuilderOptions;
  private template: ContentTemplate;
  private personaPrompt: typeof personaPrompts[string];

  constructor(options: PromptBuilderOptions) {
    this.options = options;
    this.template = contentTemplates[options.contentType];
    this.personaPrompt = personaPrompts[options.persona];

    if (!this.template) {
      throw new Error(`Unknown content type: ${options.contentType}`);
    }
    if (!this.personaPrompt) {
      throw new Error(`Unknown persona: ${options.persona}`);
    }
  }

  build(): { systemPrompt: string; userPrompt: string; settings: { maxTokens: number; temperature: number; } } {
    console.log("=== PromptBuilder START ===");
    console.log("Content type:", this.options.contentType);
    console.log("Persona:", this.options.persona);
    console.log("League data available:", !!this.options.leagueData);
    
    const systemPrompt = this.buildSystemPrompt();
    const userPrompt = this.buildUserPrompt();
    const settings = getPersonaSettings(this.options.persona);
    
    console.log("System prompt length:", systemPrompt.length);
    console.log("User prompt length:", userPrompt.length);
    console.log("=== PromptBuilder END ===");

    return { systemPrompt, userPrompt, settings };
  }

  private buildSystemPrompt(): string {
    return `${this.personaPrompt.systemPrompt}

STYLE GUIDE:
${this.personaPrompt.styleGuide}

VOCABULARY PREFERENCES:
Use these phrases and words frequently: ${this.personaPrompt.vocabularyPreferences.join(', ')}

FORBIDDEN PHRASES:
Never use these phrases: ${this.personaPrompt.forbiddenPhrases.join(', ')}

CONTENT STRUCTURE:
You are writing a ${this.template.name} article for a fantasy football league.
Target length: approximately ${this.template.estimatedWords} words.

${this.options.includeExamples ? `
EXAMPLE OUTPUTS IN YOUR STYLE:
${this.personaPrompt.exampleOutputs.join('\n')}
` : ''}`;
  }

  private buildUserPrompt(): string {
    const { leagueData, customContext } = this.options;
    
    console.log("=== buildUserPrompt START ===");
    console.log("Building prompt for:", this.template.name);
    console.log("League context:", {
      name: leagueData.leagueName,
      week: leagueData.currentWeek,
      teams: leagueData.teams.length,
      hasPreviousSeasons: !!leagueData.previousSeasons && Object.keys(leagueData.previousSeasons).length > 0,
      hasMatchups: !!leagueData.recentMatchups && leagueData.recentMatchups.length > 0,
      hasRosters: leagueData.teams.some(t => t.roster && t.roster.length > 0),
    });
    
    let prompt = `Write a ${this.template.name} article for "${leagueData.leagueName}" fantasy football league.

CURRENT CONTEXT:
- Week: ${leagueData.currentWeek}
- Number of teams: ${leagueData.teams.length} (current season only)
- Teams maintain consistent externalId across seasons for performance tracking

`;

    // Add section requirements
    prompt += `\nARTICLE SECTIONS (follow this structure):\n`;
    this.template.sections.forEach(section => {
      if (section.required) {
        prompt += `- ${section.name} (${section.description}): ~${section.wordCount} words\n`;
      }
    });

    // Add specific data based on content type
    const contentSpecificData = this.addContentSpecificData(leagueData);
    console.log("Content specific data length:", contentSpecificData.length);
    console.log("Content specific data preview:", contentSpecificData.substring(0, 200) + "...");
    prompt += `\n${contentSpecificData}`;

    // Add custom context if provided
    if (customContext) {
      console.log("Custom context provided, length:", customContext.length);
      prompt += `\nADDITIONAL CONTEXT:\n${customContext}\n`;
    }

    // Add formatting instructions
    prompt += `\nFORMATTING:
- Use markdown formatting
- Include a compelling title
- Break up sections with clear headers
- Stay in character as ${this.options.persona} throughout
- Make specific references to team names and manager names
- Include specific scores and statistics where relevant
- When discussing past performance, remember team names may change but externalId stays consistent`;

    console.log("Final user prompt length:", prompt.length);
    console.log("=== buildUserPrompt END ===");
    
    return prompt;
  }

  private addContentSpecificData(data: LeagueDataContext): string {
    let contextData = '';

    switch (this.options.contentType) {
      case 'weekly_recap':
        contextData = this.buildWeeklyRecapData(data);
        break;
      case 'power_rankings':
        contextData = this.buildPowerRankingsData(data);
        break;
      case 'trade_analysis':
        contextData = this.buildTradeAnalysisData(data);
        break;
      case 'rivalry_week_special':
        contextData = this.buildRivalryData(data);
        break;
      case 'waiver_wire_report':
        contextData = this.buildWaiverWireData(data);
        break;
      case 'season_welcome':
        contextData = this.buildSeasonWelcomeData(data);
        break;
      default:
        contextData = this.buildGenericData(data);
    }

    return contextData;
  }

  private buildWeeklyRecapData(data: LeagueDataContext): string {
    if (!data.recentMatchups || data.recentMatchups.length === 0) {
      return 'No matchup data available. Create fictional but realistic matchups.';
    }

    let recap = 'THIS WEEK\'S MATCHUPS:\n';
    data.recentMatchups.forEach(matchup => {
      recap += `- ${matchup.teamA} (${matchup.scoreA}) vs ${matchup.teamB} (${matchup.scoreB})`;
      if (matchup.winner) {
        recap += ` - ${matchup.winner === 'home' ? matchup.teamA : matchup.teamB} wins`;
      }
      recap += '\n';
      
      if (matchup.topPerformers && matchup.topPerformers.length > 0) {
        recap += '  Top performers:\n';
        matchup.topPerformers.slice(0, 3).forEach(perf => {
          const playerName = perf.playerName || perf.player || 'Unknown Player';
          const position = perf.position ? ` (${perf.position})` : '';
          recap += `    - ${playerName}${position} - ${perf.points.toFixed(1)} pts\n`;
        });
      }
    });

    // Add injury report if we have roster data
    const injuredPlayers: string[] = [];
    data.teams.forEach(team => {
      if (team.roster) {
        team.roster.forEach(player => {
          if (player.injuryStatus && player.injuryStatus !== 'ACTIVE') {
            injuredPlayers.push(`${player.fullName || player.playerName} (${team.name}) - ${player.injuryStatus}`);
          }
        });
      }
    });

    if (injuredPlayers.length > 0) {
      recap += '\nKEY INJURIES:\n';
      injuredPlayers.slice(0, 5).forEach(injury => {
        recap += `- ${injury}\n`;
      });
    }

    if (data.standings) {
      recap += '\nCURRENT STANDINGS:\n';
      data.standings.slice(0, 5).forEach(team => {
        recap += `${team.rank}. ${team.team} (${team.wins}-${team.losses})\n`;
      });
    }

    return recap;
  }

  private buildPowerRankingsData(data: LeagueDataContext): string {
    let rankings = 'CURRENT TEAM RECORDS:\n';
    
    const sortedTeams = [...data.teams].sort((a, b) => {
      const winDiff = b.record.wins - a.record.wins;
      return winDiff !== 0 ? winDiff : b.pointsFor - a.pointsFor;
    });

    sortedTeams.forEach((team, index) => {
      rankings += `${index + 1}. ${team.name} (${team.record.wins}-${team.record.losses}`;
      if (team.record.ties > 0) rankings += `-${team.record.ties}`;
      rankings += `) - ${team.pointsFor.toFixed(1)} PF, ${team.pointsAgainst.toFixed(1)} PA\n`;
      
      // Add top performers from each team
      if (team.roster && team.roster.length > 0) {
        const topPlayers = team.roster
          .filter(p => p.stats?.seasonStats?.averagePoints)
          .sort((a, b) => (b.stats?.seasonStats?.averagePoints || 0) - (a.stats?.seasonStats?.averagePoints || 0))
          .slice(0, 2);
        
        if (topPlayers.length > 0) {
          rankings += `  Key players: `;
          topPlayers.forEach((player, idx) => {
            const avg = player.stats?.seasonStats?.averagePoints?.toFixed(1) || '0';
            rankings += `${player.fullName || player.playerName} (${avg} ppg)`;
            if (idx < topPlayers.length - 1) rankings += ', ';
          });
          rankings += '\n';
        }
      }
    });

    // Add recent performance trends
    if (data.recentMatchups && data.recentMatchups.length > 0) {
      rankings += '\nRECENT PERFORMANCE TRENDS:\n';
      
      // Calculate recent scoring averages
      const recentScores: Record<string, number[]> = {};
      data.recentMatchups.forEach(matchup => {
        if (!recentScores[matchup.teamA]) recentScores[matchup.teamA] = [];
        if (!recentScores[matchup.teamB]) recentScores[matchup.teamB] = [];
        recentScores[matchup.teamA].push(matchup.scoreA);
        recentScores[matchup.teamB].push(matchup.scoreB);
      });
      
      Object.entries(recentScores).slice(0, 5).forEach(([teamId, scores]) => {
        const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
        const team = data.teams.find(t => t.externalId === teamId || t.name === teamId);
        if (team) {
          rankings += `- ${team.name}: ${avg.toFixed(1)} ppg last ${scores.length} games\n`;
        }
      });
    }

    return rankings;
  }

  private buildTradeAnalysisData(data: LeagueDataContext): string {
    if (!data.trades || data.trades.length === 0) {
      return 'Create a fictional but realistic trade between two teams for analysis.';
    }

    const latestTrade = data.trades[0];
    return `TRADE DETAILS:
Team A: ${latestTrade.teamA}
Team B: ${latestTrade.teamB}
Players from Team A: ${latestTrade.playersFromA.join(', ')}
Players from Team B: ${latestTrade.playersFromB.join(', ')}
Trade Date: ${latestTrade.date}

Analyze this trade from both perspectives.`;
  }

  private buildRivalryData(data: LeagueDataContext): string {
    // Pick two teams with similar records for rivalry
    const sortedTeams = [...data.teams].sort((a, b) => b.record.wins - a.record.wins);
    const team1 = sortedTeams[0];
    const team2 = sortedTeams[1];

    return `RIVALRY MATCHUP:
${team1.name} (${team1.record.wins}-${team1.record.losses}) vs ${team2.name} (${team2.record.wins}-${team2.record.losses})

Create an exciting rivalry narrative between these two teams.
Manager 1: ${team1.manager}
Manager 2: ${team2.manager}`;
  }

  private buildWaiverWireData(data: LeagueDataContext): string {
    let waiverData = `LEAGUE CONTEXT:
- Scoring type: ${data.scoringType || 'PPR'}
- Roster size: ${data.rosterSize || 16}
- Current week: ${data.currentWeek}
- Total teams: ${data.teams.length}

`;

    // Find available players (low ownership percentage)
    const availablePlayers: Array<{ playerId: string; playerName: string; position: string; team: string; ownership?: { percentOwned?: number; percentChange?: number; }; }> = [];
    const ownedPlayers = new Set<string>();
    
    // Collect all rostered players
    data.teams.forEach(team => {
      if (team.roster) {
        team.roster.forEach(player => {
          ownedPlayers.add(player.playerId);
          
          // Check for low ownership that might be available
          if (player.ownership && player.ownership.percentOwned && player.ownership.percentOwned < 50) {
            availablePlayers.push({
              playerId: player.playerId,
              playerName: player.fullName || player.playerName,
              position: player.position,
              team: player.team,
              ownership: {
                percentOwned: player.ownership.percentOwned,
                percentChange: player.ownership.percentChange,
              },
            });
          }
        });
      }
    });

    if (availablePlayers.length > 0) {
      waiverData += 'TRENDING AVAILABLE PLAYERS:\n';
      availablePlayers
        .sort((a, b) => (b.ownership?.percentChange || 0) - (a.ownership?.percentChange || 0))
        .slice(0, 10)
        .forEach(player => {
          waiverData += `- ${player.playerName} (${player.position}, ${player.team}) - ${player.ownership?.percentOwned}% owned`;
          if (player.ownership?.percentChange && player.ownership.percentChange > 0) {
            waiverData += ` (+${player.ownership.percentChange}% this week)`;
          }
          waiverData += '\n';
        });
    }

    // Add team needs analysis
    waiverData += '\nTEAM NEEDS ANALYSIS:\n';
    data.teams.slice(0, 5).forEach(team => {
      const positionCounts: Record<string, number> = {};
      if (team.roster) {
        team.roster.forEach(player => {
          const mainPos = player.position.replace(/[0-9]/g, ''); // Remove numbers from positions
          positionCounts[mainPos] = (positionCounts[mainPos] || 0) + 1;
        });
      }
      
      const needs: string[] = [];
      if ((positionCounts['RB'] || 0) < 4) needs.push('RB');
      if ((positionCounts['WR'] || 0) < 4) needs.push('WR');
      if ((positionCounts['TE'] || 0) < 2) needs.push('TE');
      
      if (needs.length > 0) {
        waiverData += `- ${team.name}: Needs ${needs.join(', ')}\n`;
      }
    });

    waiverData += '\nCreate waiver wire recommendations with statistical backing based on the available players and team needs.';
    
    return waiverData;
  }

  private buildGenericData(data: LeagueDataContext): string {
    const leader = data.teams.sort((a, b) => b.record.wins - a.record.wins)[0];
    let genericData = `LEAGUE OVERVIEW:
- ${data.teams.length} teams
- Current leader: ${leader.name} (${leader.record.wins}-${leader.record.losses})
- Week ${data.currentWeek} of the season
- Scoring type: ${data.scoringType || 'PPR'}
`;

    // Add league history if available
    if (data.leagueHistory) {
      genericData += `- League founded: ${data.leagueHistory.foundedYear}\n`;
      genericData += `- Total seasons: ${data.leagueHistory.totalSeasons}\n`;
    }

    // Find league-wide top performers
    const allPlayers: Array<{ playerId: string; playerName: string; position: string; team: string; avgPoints: number; totalPoints: number; }> = [];
    data.teams.forEach(team => {
      if (team.roster) {
        team.roster.forEach(player => {
          if (player.stats?.seasonStats?.averagePoints) {
            allPlayers.push({
              playerId: player.playerId,
              playerName: player.fullName || player.playerName,
              position: player.position,
              team: team.name,
              avgPoints: player.stats.seasonStats.averagePoints,
              totalPoints: player.stats.seasonStats.appliedTotal || 0,
            });
          }
        });
      }
    });

    if (allPlayers.length > 0) {
      genericData += '\nTOP PERFORMERS THIS SEASON:\n';
      allPlayers
        .sort((a, b) => b.avgPoints - a.avgPoints)
        .slice(0, 5)
        .forEach((player, idx) => {
          genericData += `${idx + 1}. ${player.playerName} (${player.position}, ${player.team}) - ${player.avgPoints.toFixed(1)} ppg
`;
        });
    }

    return genericData;
  }

  private buildSeasonWelcomeData(data: LeagueDataContext): string {
    console.log("=== buildSeasonWelcomeData START ===");
    console.log("Previous seasons available:", data.previousSeasons ? Object.keys(data.previousSeasons).length : 0);
    console.log("Previous season years:", data.previousSeasons ? Object.keys(data.previousSeasons) : []);
    
    let welcomeData = `WELCOME TO THE ${new Date().getFullYear()} SEASON!\n\n`;
    
    welcomeData += `LEAGUE OVERVIEW:\n`;
    welcomeData += `- League Name: ${data.leagueName}\n`;
    welcomeData += `- Number of Teams: ${data.teams.length}\n`;
    welcomeData += `- Scoring Type: ${data.scoringType || 'PPR'}\n`;
    welcomeData += `- Roster Size: ${data.rosterSize || 16}\n`;
    
    if (data.leagueHistory) {
      welcomeData += `- League Founded: ${data.leagueHistory.foundedYear}\n`;
      welcomeData += `- Total Seasons Played: ${data.leagueHistory.totalSeasons}\n\n`;
      
      // Add previous champions
      if (data.leagueHistory.seasons && data.leagueHistory.seasons.length > 0) {
        console.log("League history seasons:", data.leagueHistory.seasons.length);
        welcomeData += `RECENT CHAMPIONS:\n`;
        data.leagueHistory.seasons
          .filter(s => s.champion)
          .slice(-3)
          .forEach(season => {
            console.log("Champion data for", season.year, ":", season.champion);
            if (season.champion) {
              welcomeData += `- ${season.year}: ${season.champion.teamName} (${season.champion.owner})
`;
            }
          });
        welcomeData += '\n';
      }
    }

    // Current season teams and managers
    welcomeData += `\n${new Date().getFullYear()} SEASON TEAMS:\n`;
    data.teams.forEach((team, idx) => {
      welcomeData += `${idx + 1}. ${team.name} - Manager: ${team.manager}\n`;
    });

    // Previous season analysis if available
    if (data.previousSeasons && Object.keys(data.previousSeasons).length > 0) {
      const lastYear = Math.max(...Object.keys(data.previousSeasons).map(Number));
      const lastSeasonTeams = data.previousSeasons[lastYear];
      
      console.log("Last year:", lastYear);
      console.log("Last season teams:", lastSeasonTeams?.length || 0);
      
      if (lastSeasonTeams && lastSeasonTeams.length > 0) {
        console.log("Sample last season team:", {
          name: lastSeasonTeams[0].teamName,
          manager: lastSeasonTeams[0].manager,
          rosterSize: lastSeasonTeams[0].roster?.length,
        });
      }
      
      welcomeData += `\nRETURNING PLAYERS FROM ${lastYear} ROSTERS:\n`;
      
      // Track which players are on which teams
      const currentRosters: Record<string, Set<string>> = {};
      const previousRosters: Record<string, Set<string>> = {};
      
      // Build current roster map
      data.teams.forEach(team => {
        currentRosters[team.externalId || team.name] = new Set();
        if (team.roster) {
          team.roster.forEach(player => {
            currentRosters[team.externalId || team.name].add(player.playerId);
          });
        }
      });
      console.log("Current rosters built for", Object.keys(currentRosters).length, "teams");
      
      // Build previous roster map and find key players
      lastSeasonTeams.forEach(team => {
        previousRosters[team.teamId] = new Set();
        team.roster.forEach(player => {
          previousRosters[team.teamId].add(player.playerId);
        });
      });
      console.log("Previous rosters built for", Object.keys(previousRosters).length, "teams");
      
      // Find notable keepers and player movements
      welcomeData += '\nKEY ROSTER MOVES:\n';
      
      // Track keepers by team
      const keepersByTeam: Record<string, string[]> = {};
      let totalKeepers = 0;
      let totalNewPlayers = 0;
      
      data.teams.forEach(currentTeam => {
        const currentTeamId = currentTeam.externalId || currentTeam.name;
        const lastSeasonTeam = lastSeasonTeams.find(t => t.teamId === currentTeamId);
        
        if (lastSeasonTeam && currentTeam.roster) {
          const keepers: string[] = [];
          const additions: string[] = [];
          
          currentTeam.roster.forEach(player => {
            if (previousRosters[currentTeamId]?.has(player.playerId)) {
              // This is a keeper
              if (player.acquisitionType === 'DRAFT' && ['RB', 'WR', 'QB', 'TE'].includes(player.position)) {
                keepers.push(`${player.fullName || player.playerName} (${player.position})`);
                totalKeepers++;
              }
            } else if (player.acquisitionType === 'DRAFT') {
              // New draft pick
              additions.push(`${player.fullName || player.playerName} (${player.position})`);
              totalNewPlayers++;
            }
          });
          
          if (keepers.length > 0) {
            keepersByTeam[currentTeam.name] = keepers;
          }
          
          // Report on this team
          if (keepers.length > 0 || additions.length > 0) {
            welcomeData += `\n${currentTeam.name}:\n`;
            if (keepers.length > 0) {
              welcomeData += `  Kept from last season: ${keepers.slice(0, 3).join(', ')}\n`;
            }
            if (additions.length > 0) {
              welcomeData += `  Key additions: ${additions.slice(0, 3).join(', ')}\n`;
            }
          }
        }
      });
      
      console.log("Total keepers found:", totalKeepers);
      console.log("Total new players:", totalNewPlayers);
      
      // Show notable players from last season rosters
      welcomeData += '\nNOTABLE PLAYERS FROM LAST SEASON:\n';
      const allLastSeasonPlayers: Array<{ name: string; position: string; team: string }> = [];
      
      lastSeasonTeams.forEach(team => {
        team.roster
          .filter(p => ['QB', 'RB', 'WR', 'TE'].includes(p.position) && p.acquisitionType === 'DRAFT')
          .slice(0, 5) // Top 5 drafted players per team
          .forEach(player => {
            allLastSeasonPlayers.push({
              name: player.fullName || player.playerName,
              position: player.position,
              team: team.teamName
            });
          });
      });
      
      console.log("Notable players from last season:", allLastSeasonPlayers.length);
      
      // Group by position
      const byPosition = allLastSeasonPlayers.reduce((acc, player) => {
        if (!acc[player.position]) acc[player.position] = [];
        acc[player.position].push(player);
        return acc;
      }, {} as Record<string, typeof allLastSeasonPlayers>);
      
      ['QB', 'RB', 'WR', 'TE'].forEach(pos => {
        if (byPosition[pos] && byPosition[pos].length > 0) {
          welcomeData += `\n${pos}s from ${lastYear}:\n`;
          byPosition[pos].slice(0, 8).forEach(player => {
            welcomeData += `- ${player.name} (${player.team})\n`;
          });
        }
      });
    } else {
      console.log("No previous seasons data available!");
      welcomeData += '\n\nNOTE: No previous season data available. This appears to be the first season!\n';
    }
    
    welcomeData += '\n\nUse this information to create an engaging season welcome package that gets managers excited for the new season!';
    
    console.log("Season welcome data length:", welcomeData.length);
    console.log("=== buildSeasonWelcomeData END ===");
    
    return welcomeData;
  }
}

// Example usage function
export async function generatePrompt(options: PromptBuilderOptions) {
  const builder = new PromptBuilder(options);
  return builder.build();
}