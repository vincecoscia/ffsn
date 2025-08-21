import { personaPrompts, getPersonaSettings } from './persona-prompts';
import { contentTemplates, ContentTemplate } from './content-templates';

interface Matchup {
  teamA: string;
  teamB: string;
  scoreA: number;
  scoreB: number;
  projectedScoreA?: number;
  projectedScoreB?: number;
  winner?: string;
  week?: number;
  isUpset?: boolean;
  closeness?: "blowout" | "comfortable" | "close" | "nail-biter";
  topPerformers?: Array<{
    playerId?: string;
    playerName?: string;
    points: number;
    teamId?: string;
    position?: string;
    player?: string;
    team?: string;
    overPerformance?: number;
  }>;
  benchPointsA?: number;
  benchPointsB?: number;
  memorableMoment?: string;
  playoffTier?: string;
}

interface PlayoffBreakdown {
  isChampionshipWeek?: boolean;
  playoffGameCount?: number;
  isPlayoffWeek?: boolean;
  playoffMatchups?: Matchup[];
  consolationMatchups?: Matchup[];
  regularSeasonMatchups?: Matchup[];
  championshipGame?: Matchup;
}

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
    playoffSeed?: number;
    divisionRecord?: { wins: number; losses: number; ties: number; };
    strengthOfSchedule?: number; // Calculated metric
    recentForm?: { wins: number; losses: number; avgPoints: number; }; // Last 3 weeks
    draftPosition?: number; // Draft position for mock drafts
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
        recentPerformance?: { // Last 3 weeks
          avgPoints: number;
          trend: "improving" | "declining" | "stable";
        };
      };
      ownership?: {
        percentOwned?: number;
        percentChange?: number;
        percentStarted?: number;
      };
    }>;
    benchPoints?: number; // Points left on bench this week
    optimalPoints?: number; // Best possible lineup score
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
    projectedScoreA?: number;
    projectedScoreB?: number;
    winner?: string;
    week?: number;
    isUpset?: boolean; // When underdog wins
    closeness?: "blowout" | "comfortable" | "close" | "nail-biter";
    topPerformers?: Array<{ 
      playerId?: string;
      playerName?: string;
      points: number; 
      teamId?: string;
      position?: string;
      player?: string; // legacy support
      team?: string; // legacy support
    }>;
    benchPointsA?: number;
    benchPointsB?: number;
    memorableMoment?: string; // e.g., "Comeback victory", "Monday night miracle"
  }>;
  trades?: Array<{
    teamA: string;
    teamB: string;
    playersFromA: Array<{ playerId: string; playerName: string; position: string; }>;
    playersFromB: Array<{ playerId: string; playerName: string; position: string; }>;
    date: string;
    tradeGrade?: { teamA: string; teamB: string; };
    analysis?: string;
  }>;
  transactions?: Array<{
    teamId: string;
    teamName: string;
    type: "add" | "drop" | "add_drop" | "waiver_claim";
    playerAdded?: { playerId: string; playerName: string; position: string; };
    playerDropped?: { playerId: string; playerName: string; position: string; };
    date: string;
    faabBid?: number;
  }>;
  standings?: Array<{
    rank: number;
    team: string;
    teamId: string;
    wins: number;
    losses: number;
    ties: number;
    pointsFor: number;
    pointsAgainst: number;
    playoffSeed?: number;
    divisionRank?: number;
    streakType?: "W" | "L";
    streakLength?: number;
  }>;
  rivalries?: Array<{
    teamA: { id: string; name: string; manager: string; };
    teamB: { id: string; name: string; manager: string; };
    allTimeRecord: { teamAWins: number; teamBWins: number; ties: number; };
    recentGames?: Array<{ week: number; scoreA: number; scoreB: number; }>;
    intensity: "casual" | "competitive" | "heated" | "bitter";
    backstory?: string;
  }>;
  managerActivity?: Array<{
    teamId: string;
    teamName: string;
    manager: string;
    totalTransactions: number;
    trades: number;
    waiverClaims: number;
    optimalLineupPercentage?: number;
    weeklyHighScores: number;
    weeklyLowScores: number;
  }>;
  scoringType?: string;
  rosterSize?: number;
  playoffTeams?: number;
  regularSeasonWeeks?: number;
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
    allTimeRecords?: {
      mostChampionships?: { manager: string; count: number; };
      highestSingleGameScore?: { team: string; score: number; week: number; season: number; };
      lowestSingleGameScore?: { team: string; score: number; week: number; season: number; };
      biggestBlowout?: { winner: string; loser: string; margin: number; week: number; season: number; };
      longestWinStreak?: { team: string; length: number; season: number; };
    };
  };
  availablePlayers?: Array<{
    playerId: string;
    playerName: string;
    position: string;
    team?: string;
    proTeam?: string;
    ownership?: {
      percentOwned?: number;
      percentChange?: number;
      percentStarted?: number;
      averageDraftPosition?: number;
      auctionValueAverage?: number;
    };
    injured?: boolean;
    injuryStatus?: string;
    seasonOutlook?: string;
    recentStats?: { avgPoints: number; trend: string; };
    upcomingSchedule?: Array<{ week: number; opponent: string; difficulty: "easy" | "medium" | "hard"; }>;
    projectedStats?: {
      projectedTotal: number;
      projectedAverage: number;
    };
  }>;
  injuryReport?: Array<{
    playerId: string;
    playerName: string;
    team: string;
    position: string;
    status: string;
    description?: string;
    fantasyImpact?: string;
  }>;
  // Mock draft specific data
  draftOrder?: Array<{
    position: number;
    teamId: string;
    teamName: string;
    manager: string;
  }>;
  draftType?: string; // "Snake", "Auction", "Manual"
  leagueType?: string; // "Dynasty", "Keeper", "Redraft"
  memorableMoments?: Array<{
    seasonId: number;
    type: string;
    description: string;
  }>;
  draftSettings?: {
    type?: string;
    orderType?: string;
    pickOrder?: Array<{ position: number; teamId: string; teamName: string; manager: string }>;
    isAuction?: boolean;
    isSnake?: boolean;
  };
  playerCount?: number;
  weatherImpact?: Array<{
    game: string;
    conditions: string;
    temperature?: number;
    windSpeed?: number;
    precipitation?: number;
    fantasyImpact?: { passing: string; rushing: string; kicking: string; };
  }>;
  upcomingSchedule?: Array<{
    teamId: string;
    teamName: string;
    nextOpponent: string;
    nextOpponentRank?: number;
    restOfSeasonDifficulty?: "easy" | "medium" | "hard";
  }>;
  // Draft rankings specific data
  draftPicks?: Array<{
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
    perceivedValue: number;
    isRookie?: boolean; // True if player is a rookie
  }>;
  teamGrades?: Array<{
    teamName: string;
    teamOwner: string;
    grade: "A+" | "A" | "A-" | "B+" | "B" | "B-" | "C+" | "C" | "C-" | "D+" | "D" | "F";
    gradeScore: number;
    strategy: {
      strategy: "Hero RB" | "Hero WR" | "Balanced" | "Zero RB" | "Zero WR" | "TE Premium" | "QB Early" | "Unknown";
      confidence: number;
      reasoning: string;
    };
    bestPicks: Array<{
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
      perceivedValue: number;
    }>;
    worstPicks: Array<{
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
      perceivedValue: number;
    }>;
    projectedStarterPoints: number;
    benchDepthScore: number;
    reasoning: string;
  }>;
  totalTeams?: number;
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
    
    // Validate required data for the template
    const validation = this.validateRequiredData();
    if (!validation.valid) {
      console.warn("=== MISSING REQUIRED DATA ===");
      console.warn("Content type:", this.options.contentType);
      console.warn("Missing fields:", validation.missing);
      console.warn("This may result in lower quality content generation");
    }
    
    const systemPrompt = this.buildSystemPrompt();
    const userPrompt = this.buildUserPrompt();
    const settings = getPersonaSettings(this.options.persona);
    
    console.log("System prompt length:", systemPrompt.length);
    console.log("User prompt length:", userPrompt.length);
    console.log("=== PromptBuilder END ===");

    return { systemPrompt, userPrompt, settings };
  }
  
  private validateRequiredData(): { valid: boolean; missing: string[] } {
    const missing: string[] = [];
    const data = this.options.leagueData;
    
    // Check each required field
    this.template.requiredData.forEach(field => {
      switch (field) {
        case 'historical_data':
          if (!data.previousSeasons || Object.keys(data.previousSeasons).length === 0) {
            missing.push('historical_data (previousSeasons)');
          }
          break;
        case 'all_time_records':
          if (!data.leagueHistory?.allTimeRecords || Object.keys(data.leagueHistory.allTimeRecords).length === 0) {
            missing.push('all_time_records');
          }
          break;
        case 'championship_history':
          if (!data.leagueHistory?.seasons || data.leagueHistory.seasons.length === 0) {
            missing.push('championship_history');
          }
          break;
        case 'matchup_results':
          if (!data.recentMatchups || data.recentMatchups.length === 0) {
            missing.push('matchup_results');
          }
          break;
        case 'player_scores':
          if (!data.teams.some(team => team.roster && team.roster.length > 0)) {
            missing.push('player_scores (rosters)');
          }
          break;
        case 'standings':
          if (!data.standings || data.standings.length === 0) {
            missing.push('standings');
          }
          break;
        case 'draft_order':
          if (!data.draftOrder || data.draftOrder.length === 0) {
            missing.push('draft_order');
          }
          break;
        case 'available_players':
          if (!data.availablePlayers || data.availablePlayers.length === 0) {
            missing.push('available_players');
          }
          break;
        case 'trade_details':
          if (!data.trades || data.trades.length === 0) {
            missing.push('trade_details');
          }
          break;
        case 'rivalry_history':
          if (!data.rivalries || data.rivalries.length === 0) {
            missing.push('rivalry_history');
          }
          break;
        case 'draft_results':
          if (!data.draftPicks || data.draftPicks.length === 0) {
            missing.push('draft_results (draftPicks)');
          }
          break;
        case 'team_rosters':
          if (!data.teams || data.teams.length === 0) {
            missing.push('team_rosters (teams)');
          }
          break;
        case 'player_projections':
          if (!data.draftPicks || !data.draftPicks.some(pick => pick.playerProjectedPoints !== null)) {
            missing.push('player_projections');
          }
          break;
        case 'league_settings':
          if (!data.scoringType && !data.totalTeams && !data.draftType) {
            missing.push('league_settings');
          }
          break;
      }
    });
    
    return {
      valid: missing.length === 0,
      missing
    };
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

    // Add section requirements with playoff-specific adjustments
    prompt += `\nARTICLE SECTIONS (follow this structure):\n`;
    this.template.sections.forEach(section => {
      let shouldInclude = section.required;
      
      // Handle playoff-specific sections for weekly recap
      if (this.options.contentType === 'weekly_recap') {
        const playoffData = (leagueData as LeagueDataContext & { playoffBreakdown?: PlayoffBreakdown }).playoffBreakdown;
        
        if (section.name === 'championship_game') {
          shouldInclude = playoffData?.isChampionshipWeek || false;
        } else if (section.name === 'playoff_games') {
          shouldInclude = (playoffData?.playoffGameCount || 0) > 0 && !playoffData?.isChampionshipWeek;
        } else if (section.name === 'playoff_implications') {
          shouldInclude = playoffData?.isPlayoffWeek || false;
        }
      }
      
      if (shouldInclude) {
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
      case 'mock_draft':
        contextData = this.buildMockDraftData(data);
        break;
      case 'draft_rankings':
        contextData = this.buildDraftRankingsData(data);
        break;
      case 'trade_rumor_mill':
        contextData = this.buildTradeRumorData(data);
        break;
      default:
        contextData = this.buildGenericData(data);
    }

    return contextData;
  }

  private formatMatchupDetails(matchup: Matchup, isChampionshipGame = false, isPlayoffGame = false): string {
    let details = `\n${matchup.teamA} (${matchup.scoreA}) vs ${matchup.teamB} (${matchup.scoreB})`;
    
    // Add projected scores for context
    if (matchup.projectedScoreA && matchup.projectedScoreB) {
      details += `\n  Projected: ${matchup.projectedScoreA.toFixed(1)} - ${matchup.projectedScoreB.toFixed(1)}`;
    }
    
    // Add playoff tier information
    if (matchup.playoffTier) {
      details += ` [${matchup.playoffTier}]`;
    }
    
    // Determine closeness and upsets with enhanced messaging
    if (matchup.closeness) {
      details += ` [${matchup.closeness.toUpperCase()}]`;
    }
    if (matchup.isUpset) {
      if (isChampionshipGame) {
        details += ' **CHAMPIONSHIP UPSET**';
      } else if (isPlayoffGame) {
        details += ' **PLAYOFF UPSET**';
      } else {
        details += ' **UPSET**';
      }
    }
    
    // Enhanced memorable moments
    if (matchup.memorableMoment) {
      details += `\n  💥 ${matchup.memorableMoment}`;
    }
    
    details += '\n';
    
    // Top performers with enhanced detail for championship/playoff games
    if (matchup.topPerformers && matchup.topPerformers.length > 0) {
      const performerCount = isChampionshipGame ? 5 : (isPlayoffGame ? 4 : 3);
      details += '  Top performers:\n';
      matchup.topPerformers.slice(0, performerCount).forEach((perf) => {
        const playerName = perf.playerName || perf.player || 'Unknown Player';
        const position = perf.position ? ` (${perf.position})` : '';
        const overPerf = perf.overPerformance ? ` (+${perf.overPerformance}% vs proj)` : '';
        details += `    - ${playerName}${position} - ${perf.points.toFixed(1)} pts${overPerf}\n`;
      });
    }
    
    // Bench points analysis (especially important for close games)
    if (matchup.benchPointsA !== undefined && matchup.benchPointsB !== undefined) {
      details += `  Bench points: ${matchup.teamA} (${matchup.benchPointsA.toFixed(1)}) vs ${matchup.teamB} (${matchup.benchPointsB.toFixed(1)})\n`;
      
      // Highlight significant bench disparities
      const benchDiff = Math.abs(matchup.benchPointsA - matchup.benchPointsB);
      if (benchDiff > 20) {
        const strongerBench = matchup.benchPointsA > matchup.benchPointsB ? matchup.teamA : matchup.teamB;
        details += `  📊 ${strongerBench} had significantly stronger bench production (+${benchDiff.toFixed(1)} pts)\n`;
      }
    }
    
    return details;
  }

  private buildWeeklyRecapData(data: LeagueDataContext): string {
    if (!data.recentMatchups || data.recentMatchups.length === 0) {
      return 'No matchup data available. Create fictional but realistic matchups.';
    }

    let recap = '';
    
    // Check if we have playoff breakdown data
    const hasPlayoffData = (data as LeagueDataContext & { playoffBreakdown?: PlayoffBreakdown }).playoffBreakdown;
    if (hasPlayoffData) {
      const playoffData = (data as LeagueDataContext & { playoffBreakdown?: PlayoffBreakdown }).playoffBreakdown;
      
      // Add playoff context header
      if (playoffData?.isChampionshipWeek) {
        recap += '🏆 CHAMPIONSHIP WEEK 🏆\n\n';
      } else if (playoffData?.isPlayoffWeek) {
        recap += '🏈 PLAYOFF WEEK 🏈\n\n';
      } else {
        recap += 'THIS WEEK\'S MATCHUPS:\n\n';
      }
      
      // CHAMPIONSHIP GAME (highest priority)
      if (playoffData?.isChampionshipWeek && playoffData?.championshipGame) {
        recap += '🏆 CHAMPIONSHIP GAME:\n';
        recap += this.formatMatchupDetails(playoffData?.championshipGame, true);
        recap += '\n';
      }
      
      // PLAYOFF GAMES (WINNERS_BRACKET)
      if (playoffData?.playoffMatchups && playoffData.playoffMatchups.length > 0 && !playoffData?.isChampionshipWeek) {
        recap += '🏈 PLAYOFF GAMES (Winners Bracket):\n';
        playoffData?.playoffMatchups?.forEach((matchup) => {
          recap += this.formatMatchupDetails(matchup, false, true);
        });
        recap += '\n';
      }
      
      // CONSOLATION GAMES
      if (playoffData?.consolationMatchups && playoffData.consolationMatchups.length > 0) {
        const bracketType = playoffData?.consolationMatchups?.[0]?.playoffTier === 'WINNERS_CONSOLATION_LADDER' 
          ? 'Consolation Playoff' : 'Consolation';
        recap += `📊 ${bracketType.toUpperCase()} GAMES:\n`;
        playoffData?.consolationMatchups?.forEach((matchup) => {
          recap += this.formatMatchupDetails(matchup);
        });
        recap += '\n';
      }
      
      // REGULAR SEASON GAMES (if any)
      if (playoffData?.regularSeasonMatchups && playoffData.regularSeasonMatchups.length > 0) {
        recap += '📅 REGULAR SEASON GAMES:\n';
        playoffData?.regularSeasonMatchups?.forEach((matchup) => {
          recap += this.formatMatchupDetails(matchup);
        });
        recap += '\n';
      }
    } else {
      // Fallback to original format if no playoff data
      recap += 'THIS WEEK\'S MATCHUPS:\n';
      data.recentMatchups.forEach(matchup => {
        recap += this.formatMatchupDetails(matchup);
      });
    }

    // Add injury report with impact analysis
    if (data.injuryReport && data.injuryReport.length > 0) {
      recap += '\nKEY INJURIES & FANTASY IMPACT:\n';
      data.injuryReport.slice(0, 5).forEach(injury => {
        recap += `- ${injury.playerName} (${injury.position}, ${injury.team}) - ${injury.status}`;
        if (injury.fantasyImpact) {
          recap += ` - ${injury.fantasyImpact}`;
        }
        recap += '\n';
      });
    }

    // Enhanced standings with streaks
    if (data.standings) {
      recap += '\nCURRENT STANDINGS & MOMENTUM:\n';
      data.standings.slice(0, 6).forEach(team => {
        recap += `${team.rank}. ${team.team} (${team.wins}-${team.losses}`;
        if (team.ties > 0) recap += `-${team.ties}`;
        recap += `)`;
        if (team.streakType && team.streakLength) {
          recap += ` [${team.streakType}${team.streakLength}]`;
        }
        if (team.playoffSeed) {
          recap += ` - #${team.playoffSeed} seed`;
        }
        recap += '\n';
      });
    }

    // Manager activity highlights
    if (data.managerActivity && data.managerActivity.length > 0) {
      recap += '\nMANAGER ACTIVITY THIS WEEK:\n';
      const activeManagers = data.managerActivity
        .filter(m => m.totalTransactions > 0)
        .sort((a, b) => b.totalTransactions - a.totalTransactions)
        .slice(0, 3);
      
      activeManagers.forEach(manager => {
        recap += `- ${manager.manager}: ${manager.totalTransactions} moves`;
        if (manager.trades > 0) recap += ` (${manager.trades} trades)`;
        recap += '\n';
      });
    }

    // Recent transactions
    if (data.transactions && data.transactions.length > 0) {
      const recentTransactions = data.transactions.slice(0, 5);
      recap += '\nNOTABLE TRANSACTIONS:\n';
      recentTransactions.forEach(trans => {
        if (trans.type === 'waiver_claim' && trans.playerAdded) {
          recap += `- ${trans.teamName} claimed ${trans.playerAdded.playerName} (${trans.playerAdded.position})`;
          if (trans.faabBid) recap += ` for $${trans.faabBid} FAAB`;
          recap += '\n';
        } else if (trans.type === 'add_drop' && trans.playerAdded && trans.playerDropped) {
          recap += `- ${trans.teamName} added ${trans.playerAdded.playerName} (${trans.playerAdded.position}), dropped ${trans.playerDropped.playerName}\n`;
        }
      });
    }

    // Weather impact if any
    if (data.weatherImpact && data.weatherImpact.length > 0) {
      recap += '\nWEATHER IMPACT:\n';
      data.weatherImpact.slice(0, 3).forEach(weather => {
        recap += `- ${weather.game}: ${weather.conditions}`;
        if (weather.fantasyImpact) {
          recap += ` (Passing: ${weather.fantasyImpact.passing})`;
        }
        recap += '\n';
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
    const teamAData = data.teams.find(t => t.name === latestTrade.teamA || t.externalId === latestTrade.teamA);
    const teamBData = data.teams.find(t => t.name === latestTrade.teamB || t.externalId === latestTrade.teamB);

    let tradeAnalysis = `TRADE DETAILS:
Team A: ${latestTrade.teamA}
- Record: ${teamAData ? `${teamAData.record.wins}-${teamAData.record.losses}` : 'Unknown'}
- Standing: ${data.standings?.find(s => s.team === latestTrade.teamA)?.rank || 'Unknown'}
- Manager: ${teamAData?.manager || 'Unknown'}

Team B: ${latestTrade.teamB}
- Record: ${teamBData ? `${teamBData.record.wins}-${teamBData.record.losses}` : 'Unknown'}
- Standing: ${data.standings?.find(s => s.team === latestTrade.teamB)?.rank || 'Unknown'}
- Manager: ${teamBData?.manager || 'Unknown'}

Players from Team A: ${latestTrade.playersFromA.map(p => `${p.playerName} (${p.position})`).join(', ')}
Players from Team B: ${latestTrade.playersFromB.map(p => `${p.playerName} (${p.position})`).join(', ')}
Trade Date: ${latestTrade.date}
`;

    // Add player performance data if available
    if (latestTrade.playersFromA.length > 0 && teamAData?.roster) {
      tradeAnalysis += '\nPLAYER PERFORMANCE (Team A assets):\n';
      latestTrade.playersFromA.forEach(player => {
        const rosterPlayer = teamBData?.roster?.find(p => p.playerId === player.playerId);
        if (rosterPlayer?.stats?.seasonStats) {
          tradeAnalysis += `- ${player.playerName}: ${rosterPlayer.stats.seasonStats.averagePoints?.toFixed(1)} ppg`;
          if (rosterPlayer.stats.recentPerformance) {
            tradeAnalysis += ` (${rosterPlayer.stats.recentPerformance.trend})`;
          }
          if (rosterPlayer.injuryStatus) {
            tradeAnalysis += ` [${rosterPlayer.injuryStatus}]`;
          }
          tradeAnalysis += '\n';
        }
      });
    }

    if (latestTrade.playersFromB.length > 0 && teamBData?.roster) {
      tradeAnalysis += '\nPLAYER PERFORMANCE (Team B assets):\n';
      latestTrade.playersFromB.forEach(player => {
        const rosterPlayer = teamAData?.roster?.find(p => p.playerId === player.playerId);
        if (rosterPlayer?.stats?.seasonStats) {
          tradeAnalysis += `- ${player.playerName}: ${rosterPlayer.stats.seasonStats.averagePoints?.toFixed(1)} ppg`;
          if (rosterPlayer.stats.recentPerformance) {
            tradeAnalysis += ` (${rosterPlayer.stats.recentPerformance.trend})`;
          }
          if (rosterPlayer.injuryStatus) {
            tradeAnalysis += ` [${rosterPlayer.injuryStatus}]`;
          }
          tradeAnalysis += '\n';
        }
      });
    }

    // Add team needs analysis
    tradeAnalysis += '\nTEAM NEEDS ANALYSIS:\n';
    if (teamAData?.roster) {
      const positionCounts: Record<string, number> = {};
      teamAData.roster.forEach(p => {
        const pos = p.position.replace(/[0-9]/g, '');
        positionCounts[pos] = (positionCounts[pos] || 0) + 1;
      });
      tradeAnalysis += `Team A depth: RB(${positionCounts['RB'] || 0}), WR(${positionCounts['WR'] || 0}), TE(${positionCounts['TE'] || 0})\n`;
    }
    if (teamBData?.roster) {
      const positionCounts: Record<string, number> = {};
      teamBData.roster.forEach(p => {
        const pos = p.position.replace(/[0-9]/g, '');
        positionCounts[pos] = (positionCounts[pos] || 0) + 1;
      });
      tradeAnalysis += `Team B depth: RB(${positionCounts['RB'] || 0}), WR(${positionCounts['WR'] || 0}), TE(${positionCounts['TE'] || 0})\n`;
    }

    if (latestTrade.tradeGrade) {
      tradeAnalysis += `\nINITIAL GRADES: Team A: ${latestTrade.tradeGrade.teamA}, Team B: ${latestTrade.tradeGrade.teamB}\n`;
    }

    tradeAnalysis += '\nAnalyze this trade considering team needs, player performance trends, injury risks, and playoff implications.';
    
    return tradeAnalysis;
  }

  private buildRivalryData(data: LeagueDataContext): string {
    // Check for existing rivalries
    if (data.rivalries && data.rivalries.length > 0) {
      // Find the most intense rivalry
      const rivalry = data.rivalries.find(r => r.intensity === "bitter" || r.intensity === "heated") || data.rivalries[0];
      
      let rivalryData = `RIVALRY MATCHUP:
${rivalry.teamA.name} vs ${rivalry.teamB.name}

RIVALRY HISTORY:
- All-time record: ${rivalry.teamA.name} ${rivalry.allTimeRecord.teamAWins}-${rivalry.allTimeRecord.teamBWins}${rivalry.allTimeRecord.ties > 0 ? `-${rivalry.allTimeRecord.ties}` : ''}
- Intensity level: ${rivalry.intensity.toUpperCase()}
${rivalry.backstory ? `- Backstory: ${rivalry.backstory}` : ''}

CURRENT SEASON STATUS:
`;
      
      const teamAData = data.teams.find(t => t.id === rivalry.teamA.id || t.externalId === rivalry.teamA.id);
      const teamBData = data.teams.find(t => t.id === rivalry.teamB.id || t.externalId === rivalry.teamB.id);
      
      if (teamAData && teamBData) {
        rivalryData += `${rivalry.teamA.name}: ${teamAData.record.wins}-${teamAData.record.losses}, ${teamAData.pointsFor.toFixed(1)} PF
${rivalry.teamB.name}: ${teamBData.record.wins}-${teamBData.record.losses}, ${teamBData.pointsFor.toFixed(1)} PF

RECENT FORM:
`;
        if (teamAData.recentForm) {
          rivalryData += `${rivalry.teamA.name}: ${teamAData.recentForm.wins}-${teamAData.recentForm.losses} last 3 weeks, ${teamAData.recentForm.avgPoints.toFixed(1)} ppg\n`;
        }
        if (teamBData.recentForm) {
          rivalryData += `${rivalry.teamB.name}: ${teamBData.recentForm.wins}-${teamBData.recentForm.losses} last 3 weeks, ${teamBData.recentForm.avgPoints.toFixed(1)} ppg\n`;
        }
      }
      
      if (rivalry.recentGames && rivalry.recentGames.length > 0) {
        rivalryData += '\nRECENT HEAD-TO-HEAD:\n';
        rivalry.recentGames.slice(-3).forEach(game => {
          rivalryData += `Week ${game.week}: ${rivalry.teamA.name} ${game.scoreA} - ${game.scoreB} ${rivalry.teamB.name}\n`;
        });
      }
      
      rivalryData += '\nCreate an exciting narrative about this rivalry matchup, incorporating the history and current context.';
      
      return rivalryData;
    }
    
    // Fallback: Create rivalry from two competitive teams
    const sortedTeams = [...data.teams].sort((a, b) => b.record.wins - a.record.wins);
    const team1 = sortedTeams[0];
    const team2 = sortedTeams[1];

    let rivalryData = `RIVALRY MATCHUP:
${team1.name} (${team1.record.wins}-${team1.record.losses}) vs ${team2.name} (${team2.record.wins}-${team2.record.losses})

CURRENT SEASON STATS:
${team1.name}:
- Manager: ${team1.manager}
- Points For: ${team1.pointsFor.toFixed(1)}
- Playoff Seed: ${team1.playoffSeed || 'TBD'}
${team1.recentForm ? `- Recent Form: ${team1.recentForm.wins}-${team1.recentForm.losses}, ${team1.recentForm.avgPoints.toFixed(1)} ppg` : ''}

${team2.name}:
- Manager: ${team2.manager}
- Points For: ${team2.pointsFor.toFixed(1)}
- Playoff Seed: ${team2.playoffSeed || 'TBD'}
${team2.recentForm ? `- Recent Form: ${team2.recentForm.wins}-${team2.recentForm.losses}, ${team2.recentForm.avgPoints.toFixed(1)} ppg` : ''}
`;

    // Check for previous matchups this season
    const headToHead = data.recentMatchups?.filter(m => 
      (m.teamA === team1.name && m.teamB === team2.name) ||
      (m.teamA === team2.name && m.teamB === team1.name)
    );
    
    if (headToHead && headToHead.length > 0) {
      rivalryData += '\nPREVIOUS MATCHUPS THIS SEASON:\n';
      headToHead.forEach(game => {
        rivalryData += `Week ${game.week}: ${game.teamA} ${game.scoreA} - ${game.scoreB} ${game.teamB}`;
        if (game.memorableMoment) {
          rivalryData += ` (${game.memorableMoment})`;
        }
        rivalryData += '\n';
      });
    }

    rivalryData += '\nCreate an exciting rivalry narrative between these two competitive teams.';
    
    return rivalryData;
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

  private buildMockDraftData(data: LeagueDataContext): string {
    console.log("=== buildMockDraftData START (OPTIMIZED) ===");
    console.log("Draft order available:", !!data.draftOrder);
    console.log("Available players:", data.availablePlayers?.length || 0);
    
    let mockDraftData = `MOCK DRAFT INFORMATION:\n\n`;
    
    // Compact League Settings
    mockDraftData += `LEAGUE SETTINGS:\n`;
    mockDraftData += `- ${data.leagueType || 'Redraft'} | ${data.draftType || 'Snake'} | ${data.scoringType || 'PPR'}\n`;
    mockDraftData += `- ${data.teams.length} teams | ${data.rosterSize || 16} roster spots\n\n`;
    
    // Draft Order (compact format)
    if (data.draftOrder && data.draftOrder.length > 0) {
      mockDraftData += `DRAFT ORDER:\n`;
      const orderList = data.draftOrder
        .slice(0, 12) // Limit to 12 teams max
        .map(pick => `${pick.position}. ${pick.teamName}`)
        .join(' | ');
      mockDraftData += `${orderList}\n\n`;
    }
    
    // Enhanced player pool presentation with outlook and projections
    if (data.availablePlayers && data.availablePlayers.length > 0) {
      mockDraftData += `TOP 50 DRAFT-ELIGIBLE PLAYERS:\n\n`;
      
      // Group players by position
      const playersByPosition = data.availablePlayers.reduce((acc: Record<string, typeof data.availablePlayers>, player: typeof data.availablePlayers[0]) => {
        const pos = player.position || 'UNKNOWN';
        if (!acc[pos]) acc[pos] = [];
        acc[pos].push(player);
        return acc;
      }, {} as Record<string, typeof data.availablePlayers>);
      
      // Show top players by position with enhanced data
      const positions = ['QB', 'RB', 'WR', 'TE'];
      positions.forEach(pos => {
        if (playersByPosition[pos] && playersByPosition[pos].length > 0) {
          mockDraftData += `\n${pos}s:\n`;
          const topPlayers = playersByPosition[pos]
            .slice(0, pos === 'QB' || pos === 'TE' ? 8 : 15); // More players shown
          
          topPlayers.forEach((p, idx) => {
            mockDraftData += `${idx + 1}. ${p.playerName} (${p.proTeam})`;
            
            // Add projected stats if available
            if (p.projectedStats) {
              mockDraftData += ` - Proj: ${p.projectedStats.projectedTotal.toFixed(0)} pts (${p.projectedStats.projectedAverage.toFixed(1)} ppg)`;
            }
            
            // Add outlook if available (truncate if too long)
            if (p.seasonOutlook && p.seasonOutlook.length > 0) {
              const outlook = p.seasonOutlook.length > 250 
                ? p.seasonOutlook.substring(0, 250) + '...' 
                : p.seasonOutlook;
              mockDraftData += `\n   Outlook: ${outlook}`;
            }
            
            mockDraftData += '\n';
          });
        }
      });
      mockDraftData += '\n';
    }
    
    // OPTIMIZED: Simplified team list
    if (data.teams && data.teams.length > 0) {
      mockDraftData += `DRAFT POSITIONS:\n`;
      const teamList = data.teams
        .filter(team => team.draftPosition && team.draftPosition > 0)
        .sort((a, b) => (a.draftPosition || 0) - (b.draftPosition || 0))
        .slice(0, 12)
        .map(team => {
          const pos = team.draftPosition || 0;
          if (pos > 0 && pos <= 3) return `${pos}. ${team.name} (early)`;
          if (pos > 0 && pos >= data.teams.length - 2) return `${pos}. ${team.name} (turn)`;
          return `${pos}. ${team.name}`;
        });
      mockDraftData += teamList.join(', ') + '\n\n';
    }
    
    // OPTIMIZED: Condensed strategy notes
    mockDraftData += `KEY DRAFT STRATEGY:\n`;
    mockDraftData += `- Format: ${data.leagueType} ${data.draftType} (${data.scoringType})\n`;
    
    if (data.draftType === 'Auction') {
      mockDraftData += `- Budget wisely, target 2-3 studs + depth\n`;
    } else {
      mockDraftData += `- Early picks: Elite RB/WR | Mid: Best available | Late: Upside\n`;
    }
    
    if (data.leagueType === 'Dynasty') {
      mockDraftData += `- Prioritize youth and multi-year value\n`;
    } else if (data.leagueType === 'Keeper') {
      mockDraftData += `- Account for keeper values in strategy\n`;
    }
    
    mockDraftData += `\nMOCK DRAFT PREDICTION INSTRUCTIONS:
- You are PREDICTING what each team WILL draft based on their needs and the available players
- This is a pre-draft prediction exercise - no picks have been made yet
- Present your predictions for rounds 1-2 in a "by team" format
- Base predictions on: team needs, draft position, player projections, player outlook, and league scoring settings
- For each pick, explain WHY you predict that team will select that player
- For later rounds (3+), provide general strategy predictions and likely targets
- Remember: You're forecasting future decisions, not critiquing past ones
- Use player projections and outlook to justify picks, NOT just ADP rankings
- Avoid mentioning ADP unless it's crucial for explaining a reach/value pick`;
    
    const finalLength = mockDraftData.length;
    console.log("Optimized mock draft data length:", finalLength, "(was", mockDraftData.length, ")");
    console.log("=== buildMockDraftData END (OPTIMIZED) ===");
    
    return mockDraftData;
  }

  private buildDraftRankingsData(data: LeagueDataContext): string {
    console.log("=== buildDraftRankingsData START ===");
    
    let draftData = `POST-DRAFT RANKINGS & ANALYSIS:\n\n`;
    
    // League Information
    draftData += `LEAGUE SETTINGS:\n`;
    draftData += `- ${data.leagueName}\n`;
    draftData += `- ${data.totalTeams} teams | ${data.scoringType || 'PPR'} scoring\n`;
    draftData += `- ${data.draftType || 'Snake'} draft format\n\n`;
    
    // Team-by-Team Draft Analysis
    if (data.teamGrades && data.teamGrades.length > 0) {
      draftData += `TEAM-BY-TEAM DRAFT ANALYSIS:\n`;
      data.teamGrades
        .sort((a, b) => b.gradeScore - a.gradeScore)
        .forEach((team, index) => {
          draftData += `${index + 1}. ${team.teamName} (${team.teamOwner}) - GRADE: ${team.grade}\n`;
          draftData += `   Score: ${team.gradeScore.toFixed(1)}/100\n`;
          // Only mention strategy if confidence is very high (>80%)
          if (team.strategy.confidence > 0.8) {
            draftData += `   Strategy: ${team.strategy.strategy}\n`;
          }
          draftData += `   Projected Starter Points: ${team.projectedStarterPoints.toFixed(0)}\n`;
          draftData += `   Best Pick: ${team.bestPicks[0]?.playerName} (${team.bestPicks[0]?.playerPosition}) at pick ${team.bestPicks[0]?.pickNumber}\n`;
          if (team.worstPicks.length > 0 && team.worstPicks[0].perceivedValue < -20) {
            draftData += `   Biggest Reach: ${team.worstPicks[0].playerName} at pick ${team.worstPicks[0].pickNumber}\n`;
          }
          draftData += `   Reasoning: ${team.reasoning}\n`;
          draftData += `\n`;
        });
      draftData += `\n`;
    }
    
    // Draft Pick Details (Top 3 rounds for space efficiency)
    if (data.draftPicks && data.draftPicks.length > 0) {
      const topRoundPicks = data.draftPicks.filter(pick => pick.roundNumber <= 3);
      
      if (topRoundPicks.length > 0) {
        draftData += `TOP 3 ROUNDS BREAKDOWN:\n`;
        
        // Group by round
        const picksByRound = topRoundPicks.reduce((acc, pick) => {
          if (!acc[pick.roundNumber]) acc[pick.roundNumber] = [];
          acc[pick.roundNumber].push(pick);
          return acc;
        }, {} as Record<number, typeof topRoundPicks>);
        
        Object.entries(picksByRound)
          .sort(([a], [b]) => Number(a) - Number(b))
          .forEach(([round, picks]) => {
            draftData += `\nRound ${round}:\n`;
            picks.sort((a, b) => a.pickNumber - b.pickNumber)
              .forEach(pick => {
                draftData += `${pick.pickNumber}. ${pick.playerName} (${pick.playerPosition}, ${pick.playerTeam}) → ${pick.teamName}`;
                
                if (pick.playerADP) {
                  const adpDiff = pick.pickNumber - pick.playerADP;
                  if (adpDiff > 10) {
                    draftData += ` [VALUE: ADP ${pick.playerADP.toFixed(1)}]`;
                  } else if (adpDiff < -10) {
                    draftData += ` [REACH: ADP ${pick.playerADP.toFixed(1)}]`;
                  }
                }
                
                if (pick.playerProjectedPoints) {
                  draftData += ` | Proj: ${pick.playerProjectedPoints.toFixed(0)} pts`;
                }
                
                draftData += `\n`;
              });
          });
        draftData += `\n`;
      }
      
      // Hot Take Best Picks - Mix of high projected points and value
      const hotTakeBestPicks: Array<NonNullable<typeof data.draftPicks>[0]> = [];
      
      // Get top projected players by position who were drafted
      const positionGroups = ['QB', 'RB', 'WR', 'TE'];
      positionGroups.forEach(position => {
        if (data.draftPicks) {
          const positionPicks = data.draftPicks
            .filter(pick => pick.playerPosition === position && pick.playerProjectedPoints !== null)
            .sort((a, b) => (b.playerProjectedPoints || 0) - (a.playerProjectedPoints || 0));
          
          // Add top 2 projected players for this position
          if (positionPicks.length > 0) {
            hotTakeBestPicks.push(...positionPicks.slice(0, 2));
          }
        }
      });
      
      // Add some high-value picks (steals) - players drafted significantly later than their ADP
      if (data.draftPicks) {
        const valueSteals = data.draftPicks
          .filter(pick => 
            pick.playerADP && 
            pick.pickNumber > pick.playerADP + 10 && // Drafted at least 10 spots later than ADP (true steals)
            pick.perceivedValue > 0 // Still has positive value
          )
          .sort((a, b) => (b.pickNumber - b.playerADP!) - (a.pickNumber - a.playerADP!)) // Sort by biggest steal (pick number - ADP)
          .slice(0, 3);
        hotTakeBestPicks.push(...valueSteals);
        
        // Add rookie sleepers (players marked as rookies, or late ADP with decent projections)
        const rookieSleepers = data.draftPicks
          .filter(pick => 
            (pick.isRookie || 
             (pick.playerADP && pick.playerADP > 100 && pick.playerProjectedPoints && pick.playerProjectedPoints > 150)) &&
            pick.perceivedValue > 0
          )
          .sort((a, b) => (b.playerProjectedPoints || 0) - (a.playerProjectedPoints || 0))
          .slice(0, 2);
        hotTakeBestPicks.push(...rookieSleepers);
      }
      
      // Remove duplicates and limit
      const uniqueBestPicks = hotTakeBestPicks
        .filter((pick, index, arr) => arr.findIndex(p => p.playerName === pick.playerName) === index)
        .slice(0, 8);
      
      if (uniqueBestPicks.length > 0) {
        draftData += `HOT TAKE BEST PICKS:\n`;
        uniqueBestPicks.forEach(pick => {
          draftData += `${pick.playerName} (${pick.playerPosition}) to ${pick.teamName} at pick ${pick.pickNumber}`;
          if (pick.playerProjectedPoints) {
            draftData += ` - Proj: ${pick.playerProjectedPoints.toFixed(0)} pts`;
          }
          if (pick.playerADP && pick.pickNumber > pick.playerADP + 10) {
            const adpDiff = pick.pickNumber - pick.playerADP;
            draftData += ` (STEAL: ADP ${pick.playerADP.toFixed(1)}, +${adpDiff.toFixed(1)} value)`;
          }
          if (pick.isRookie) {
            draftData += ` [ROOKIE SLEEPER]`;
          }
          draftData += `\n`;
        });
        draftData += `\n`;
      }
      
      // Hot Take Worst Picks - Mix of reaches and low projections
      const hotTakeWorstPicks: Array<NonNullable<typeof data.draftPicks>[0]> = [];
      
      if (data.draftPicks) {
        // Get extreme reaches (drafted much earlier than ADP)
        const extremeReaches = data.draftPicks
          .filter(pick => pick.playerADP && pick.pickNumber < pick.playerADP - 20)
          .sort((a, b) => (a.playerADP || 0) - (b.playerADP || 0) - (b.pickNumber - a.pickNumber))
          .slice(0, 4);
        hotTakeWorstPicks.push(...extremeReaches);
        
        // Get players with lowest projected points by position (drafted too early for their projection)
        positionGroups.forEach(position => {
          const positionPicks = data.draftPicks!
            .filter(pick => pick.playerPosition === position && pick.playerProjectedPoints !== null && pick.pickNumber <= 120)
            .sort((a, b) => (a.playerProjectedPoints || 0) - (b.playerProjectedPoints || 0));
          
          // Add bottom 1-2 projected players for this position (if drafted reasonably early)
          if (positionPicks.length > 2) {
            const worstProjected = positionPicks.slice(0, position === 'QB' || position === 'TE' ? 1 : 2);
            hotTakeWorstPicks.push(...worstProjected);
          }
        });
        
        // Add some terrible value picks
        const terribleValue = data.draftPicks
          .filter(pick => pick.perceivedValue < -30)
          .sort((a, b) => a.perceivedValue - b.perceivedValue)
          .slice(0, 3);
        hotTakeWorstPicks.push(...terribleValue);
      }
      
      // Remove duplicates and limit
      const uniqueWorstPicks = hotTakeWorstPicks
        .filter((pick, index, arr) => arr.findIndex(p => p.playerName === pick.playerName) === index)
        .slice(0, 6);
      
      if (uniqueWorstPicks.length > 0) {
        draftData += `HOT TAKE QUESTIONABLE PICKS:\n`;
        uniqueWorstPicks.forEach(pick => {
          draftData += `${pick.playerName} (${pick.playerPosition}) to ${pick.teamName} at pick ${pick.pickNumber}`;
          if (pick.playerProjectedPoints) {
            draftData += ` - Proj: ${pick.playerProjectedPoints.toFixed(0)} pts`;
          }
          if (pick.playerADP && pick.pickNumber < pick.playerADP - 15) {
            draftData += ` (REACH: ADP ${pick.playerADP.toFixed(1)})`;
          }
          if (pick.perceivedValue < -30) {
            draftData += ` [YIKES]`;
          }
          draftData += `\n`;
        });
        draftData += `\n`;
      }
    }
    
    // Draft Strategy Analysis
    if (data.teamGrades) {
      draftData += `STRATEGY BREAKDOWN:\n`;
      const strategies = data.teamGrades.reduce((acc, team) => {
        const strategy = team.strategy.strategy;
        if (!acc[strategy]) acc[strategy] = [];
        acc[strategy].push(team);
        return acc;
      }, {} as Record<string, typeof data.teamGrades>);
      
      Object.entries(strategies).forEach(([strategy, teams]) => {
        draftData += `${strategy}: ${teams.map(t => t.teamName).join(', ')} (${teams.length} teams)\n`;
      });
      draftData += `\n`;
    }
    
    draftData += `GRADING METHODOLOGY:\n`;
    draftData += `- Grades based on: projected starter points (40%), perceived pick value vs ADP (40%), bench depth (20%)\n`;
    draftData += `- Strategy analysis considers first 5 picks and position distribution\n`;
    draftData += `- STEALS/Value picks: Players drafted significantly LATER than their ADP (e.g., ADP 30, drafted at pick 50 = 20-spot steal)\n`;
    draftData += `- REACHES: Players drafted significantly EARLIER than their ADP (e.g., ADP 50, drafted at pick 30 = 20-spot reach)\n`;
    draftData += `- Consider league scoring system (${data.scoringType}) when evaluating positional value\n\n`;
    
    draftData += `CRITICAL ADP INTERPRETATION:\n`;
    draftData += `- When you see [VALUE: ADP X.X], this means the player was drafted LATER than their ADP (a STEAL)\n`;
    draftData += `- When you see [REACH: ADP X.X], this means the player was drafted EARLIER than their ADP (a REACH)\n`;
    draftData += `- NEVER call a reach a "steal" or "value" - reaches are BAD picks, steals are GOOD picks\n`;
    draftData += `- Example: Pick 30, ADP 43 = REACH (drafted 13 spots too early) - DO NOT CALL THIS A STEAL!\n`;
    draftData += `- Example: Pick 50, ADP 30 = STEAL (drafted 20 spots later than expected) - This is actual value!\n`;
    draftData += `- If a player's pick number is LOWER than their ADP, it's a REACH, not a steal!\n\n`;
    
    draftData += `DRAFT RANKINGS INSTRUCTIONS:\n`;
    draftData += `- Focus on ACTUAL draft results and grades, not predictions\n`;
    draftData += `- Go through EACH TEAM INDIVIDUALLY and give them their personalized grade and analysis\n`;
    draftData += `- Don't group teams by grade (no "A+ teams", "B teams" sections) - analyze each team separately\n`;
    draftData += `- Use the provided team-by-team data with specific reasoning for each team's grade\n`;
    draftData += `- CRITICAL: If team manager comments are provided, INTEGRATE them directly into each team's breakdown\n`;
    draftData += `- Structure team analysis: "[AI analysis of pick] When asked about [topic], [Manager] said: '[EXACT QUOTE]' [AI snarky response]"\n`;
    draftData += `- Make comments feel like natural conversation between you and the managers, not an afterthought\n`;
    draftData += `- Use manager quotes to explain controversial picks, draft strategy, or team construction decisions\n`;
    draftData += `- Be critical of bad picks but give credit where due\n`;
    draftData += `- Include specific analysis of each team's strategy (when provided), best picks, and biggest reaches\n`;
    draftData += `- NEVER mention confidence levels or percentages related to draft strategy analysis\n`;
    draftData += `- The "Hot Take Best Picks" section highlights elite projections, TRUE STEALS (drafted later than ADP), and rookie sleepers\n`;
    draftData += `- Rookies are identified by the isRookie field, determined from ESPN's eligibility data\n`;
    draftData += `- The "Hot Take Questionable Picks" section focuses on reaches and low-projection players drafted early\n`;
    draftData += `- Make bold, entertaining takes on these picks - don't just list them, give hot takes!\n`;
    draftData += `- Reference the grading methodology but don't be overly technical\n`;
    draftData += `- Make it entertaining while being informative with personalized takes for each team\n`;
    
    console.log("Draft rankings data length:", draftData.length);
    console.log("=== buildDraftRankingsData END ===");
    
    return draftData;
  }

  private buildTradeRumorData(data: LeagueDataContext): string {
    console.log("=== buildTradeRumorData START ===");
    
    let rumorData = `TRADE RUMOR CONTEXT:\n\n`;
    
    // League standings for context
    rumorData += `CURRENT STANDINGS:\n`;
    if (data.standings && data.standings.length > 0) {
      data.standings.slice(0, 8).forEach(team => {
        rumorData += `${team.rank}. ${team.team} (${team.wins}-${team.losses}`;
        if (team.ties > 0) rumorData += `-${team.ties}`;
        rumorData += `) - ${team.pointsFor.toFixed(1)} PF`;
        if (team.playoffSeed) {
          rumorData += ` [#${team.playoffSeed} seed]`;
        }
        rumorData += '\n';
      });
    }
    rumorData += '\n';
    
    // Recent trades in the league for context
    if (data.trades && data.trades.length > 0) {
      rumorData += `RECENT TRADE ACTIVITY:\n`;
      data.trades.slice(0, 3).forEach(trade => {
        rumorData += `- ${trade.teamA} traded ${trade.playersFromA.map(p => p.playerName).join(', ')} `;
        rumorData += `for ${trade.playersFromB.map(p => p.playerName).join(', ')} from ${trade.teamB}\n`;
      });
      rumorData += '\n';
    }
    
    // Team needs analysis
    rumorData += `TEAM NEEDS & SITUATIONS:\n`;
    data.teams.forEach(team => {
      const positionCounts: Record<string, number> = {};
      if (team.roster) {
        team.roster.forEach(player => {
          const mainPos = player.position.replace(/[0-9]/g, '');
          positionCounts[mainPos] = (positionCounts[mainPos] || 0) + 1;
        });
      }
      
      const needs: string[] = [];
      if ((positionCounts['RB'] || 0) < 4) needs.push('RB');
      if ((positionCounts['WR'] || 0) < 4) needs.push('WR');
      if ((positionCounts['TE'] || 0) < 2) needs.push('TE');
      
      if (needs.length > 0 || team.record.wins <= 3 || team.record.wins >= 7) {
        rumorData += `- ${team.name} (${team.record.wins}-${team.record.losses})`;
        if (needs.length > 0) {
          rumorData += ` needs: ${needs.join(', ')}`;
        }
        if (team.record.wins >= 7) {
          rumorData += ` [Contender - buying]`;
        } else if (team.record.wins <= 3) {
          rumorData += ` [Rebuilding - selling]`;
        }
        rumorData += '\n';
      }
    });
    rumorData += '\n';
    
    // Hot players who could be trade targets
    if (data.teams.length > 0) {
      rumorData += `HOT TRADE COMMODITIES:\n`;
      const allPlayers: Array<{
        playerName: string;
        position: string;
        teamName: string;
        avgPoints?: number;
        trend?: string;
      }> = [];
      
      data.teams.forEach(team => {
        if (team.roster) {
          team.roster.forEach(player => {
            if (player.stats?.seasonStats?.averagePoints && player.stats.seasonStats.averagePoints > 10) {
              allPlayers.push({
                playerName: player.fullName || player.playerName,
                position: player.position,
                teamName: team.name,
                avgPoints: player.stats.seasonStats.averagePoints,
                trend: player.stats.recentPerformance?.trend
              });
            }
          });
        }
      });
      
      // Show top performers who might be trade targets
      allPlayers
        .sort((a, b) => (b.avgPoints || 0) - (a.avgPoints || 0))
        .slice(0, 10)
        .forEach(player => {
          rumorData += `- ${player.playerName} (${player.position}, ${player.teamName}) - ${player.avgPoints?.toFixed(1)} ppg`;
          if (player.trend) {
            rumorData += ` [${player.trend}]`;
          }
          rumorData += '\n';
        });
    }
    
    rumorData += `\nTRADE RUMOR INSTRUCTIONS:
- You are Vinny "The Sauce" Marinara, spreading mysterious insider information
- The specific trade rumor details are provided in the ADDITIONAL CONTEXT section below
- IMPORTANT: Use the actual player names, team names, and stats provided in the ADDITIONAL CONTEXT
- DO NOT reference player IDs or team IDs - always use the proper names
- Make the rumor sound like it came from your unreliable but entertaining sources
- Add colorful details about where you heard it (barber, uber driver, guy at the deli, etc.)
- Be vague but tantalizing - hint at more information you can't share yet
- Use mob movie references and Italian-American slang
- Present it as insider knowledge but maintain plausible deniability
- Create drama and intrigue around the potential trade
- Reference the specific player stats and recent performance when discussing trade value

ADDITIONAL CONTEXT:
The custom context below contains the specific trade rumor details including:
- The actual player names involved (NOT IDs)
- Their positions and current team names
- Their season stats and recent performance
- The target team information if applicable
Use these specific details to craft your rumor narrative.`;
    
    console.log("Trade rumor data length:", rumorData.length);
    console.log("=== buildTradeRumorData END ===");
    
    return rumorData;
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
    if (data.leagueType) {
      welcomeData += `- League Type: ${data.leagueType}\n`;
    }
    
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
    
    // Memorable moments section if present
    if (data.memorableMoments && Array.isArray(data.memorableMoments) && data.memorableMoments.length > 0) {
      welcomeData += `\nMEMORABLE MOMENTS (Recent Seasons):\n`;
      const moments = data.memorableMoments;
      moments
        .slice(0, 12)
        .forEach(m => {
          welcomeData += `- ${m.seasonId}: ${m.description}\n`;
        });
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