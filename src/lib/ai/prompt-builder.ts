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
    record: { wins: number; losses: number; ties: number };
    pointsFor: number;
    pointsAgainst: number;
    externalId?: string; // ESPN team ID for consistency tracking
  }>;
  recentMatchups?: Array<{
    teamA: string;
    teamB: string;
    scoreA: number;
    scoreB: number;
    topPerformers: Array<{ player: string; points: number; team: string }>;
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
  [key: string]: any;
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

  build(): { systemPrompt: string; userPrompt: string; settings: any } {
    const systemPrompt = this.buildSystemPrompt();
    const userPrompt = this.buildUserPrompt();
    const settings = getPersonaSettings(this.options.persona);

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
    prompt += `\n${this.addContentSpecificData(leagueData)}`;

    // Add custom context if provided
    if (customContext) {
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
      recap += `- ${matchup.teamA} (${matchup.scoreA}) vs ${matchup.teamB} (${matchup.scoreB})\n`;
      if (matchup.topPerformers && matchup.topPerformers.length > 0) {
        recap += `  Top performer: ${matchup.topPerformers[0].player} - ${matchup.topPerformers[0].points} pts\n`;
      }
    });

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
      rankings += `) - ${team.pointsFor.toFixed(1)} PF\n`;
    });

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
    return `LEAGUE CONTEXT:
- Scoring type: ${data.scoringType || 'PPR'}
- Roster size: ${data.rosterSize || 16}
- Top teams needing help: Focus on teams in playoff contention

Create waiver wire recommendations with statistical backing.
Include specific player names and why they should be picked up.`;
  }

  private buildGenericData(data: LeagueDataContext): string {
    return `LEAGUE OVERVIEW:
- ${data.teams.length} teams
- Current leader: ${data.teams.sort((a, b) => b.record.wins - a.record.wins)[0].name}
- Week ${data.currentWeek} of the season`;
  }
}

// Example usage function
export async function generatePrompt(options: PromptBuilderOptions) {
  const builder = new PromptBuilder(options);
  return builder.build();
}