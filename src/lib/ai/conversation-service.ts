/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unused-vars */
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

// Conversation context interface
export interface ConversationContext {
  userId: string;
  leagueId: string;
  scheduledContentId: string | undefined;
  contentType: string; // Support all content types from templates
  week: number;
  seasonId: number;
  draftData?: {
    draftType?: string;
    draftOrder?: any[];
    userDraftPicks?: Array<{
      isRookie?: boolean;
      perceivedValue: number;
      pickNumber: number;
      playerADP: number | null;
      playerName: string;
      playerPosition: string;
      playerProjectedPoints: number | null;
      playerTeam: string;
      roundNumber: number;
      roundPickNumber: number;
      teamName: string;
      teamOwner: string;
    }>;
    allDraftPicks?: Array<{
      isRookie?: boolean;
      perceivedValue: number;
      pickNumber: number;
      playerADP: number | null;
      playerName: string;
      playerPosition: string;
      playerProjectedPoints: number | null;
      playerTeam: string;
      roundNumber: number;
      roundPickNumber: number;
      teamName: string;
      teamOwner: string;
    }>;
  };
  teamPerformance: {
    teamId: string;
    teamName: string;
    score: number;
    projectedScore?: number;
    won: boolean;
    underperformers: Array<{
      player: string;
      position: string;
      expectedPts: number;
      actualPts: number;
    }>;
    overperformers: Array<{
      player: string;
      position: string;
      expectedPts: number;
      actualPts: number;
    }>;
    keyDecisions?: Array<{
      type: "start_sit" | "waiver_pickup" | "trade";
      description: string;
      impact: string;
    }>;
  };
  leagueContext: {
    standings: Array<{
      teamId: string;
      teamName: string;
      rank: number;
      record: string;
    }>;
    recentTrades?: Array<{
      date: number;
      teams: string[];
      players: string[];
    }>;
    rivalries?: Array<{
      team1: string;
      team2: string;
      intensity: number;
    }>;
    playoffContext?: {
      isPlayoffWeek: boolean;
      userInPlayoffs: boolean;
      playoffImplications: string;
    };
  };
  conversationHistory?: Array<{
    role: "ai" | "user";
    content: string;
    timestamp: number;
  }>;
}

// AI response structure
export interface AIConversationResult {
  question: string;
  confidence: number;
  intent: "initial" | "follow_up" | "clarification" | "closing";
  expectedResponseType: "opinion" | "analysis" | "story" | "explanation" | "mixed";
  contextualReasons: string[];
  shouldEndAfterResponse: boolean;
  suggestedFollowUpTopics?: string[];
  detectedAbuse?: {
    type: "off_topic" | "spam" | "inappropriate" | "questioning_ai";
    severity: "low" | "medium" | "high";
    reason: string;
  };
}

// Zod schema for structured conversation output
const ConversationResponse = z.object({
  question: z.string().describe("The question to ask the user, focused on the article topic"),
  confidence: z.number().min(0).max(100).describe("Confidence in the question's relevance (0-100)"),
  intent: z.enum(["initial", "follow_up", "clarification", "closing"]).describe("The purpose of this message"),
  expectedResponseType: z.enum(["opinion", "analysis", "story", "explanation", "mixed"]).describe("What kind of response we're hoping for"),
  contextualReasons: z.array(z.string()).describe("Why this question is being asked based on context"),
  shouldEndAfterResponse: z.boolean().describe("Whether to end the conversation after getting a response"),
  suggestedFollowUpTopics: z.array(z.string()).optional().describe("Potential follow-up topics if conversation continues"),
});

export class ConversationService {
  private modelConfig = {
    primary: "claude-opus-5",
    fallback: "claude-sonnet-5",
  };

  async generateConversationQuestion(
    context: ConversationContext,
    apiKey: string
  ): Promise<AIConversationResult> {
    const anthropic = new Anthropic({ apiKey });

    // Implement retry logic with exponential backoff for 529 errors
    let lastError: Error | null = null;
    const maxRetries = 3;
    const baseDelay = 1000; // 1 second

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const { systemPrompt, userPrompt } = this.buildConversationPrompts(context);
        
        // Log token usage for monitoring
        const systemTokens = this.estimateTokens(systemPrompt);
        const userTokens = this.estimateTokens(userPrompt);
        const totalInputTokens = systemTokens + userTokens;
        
        if (totalInputTokens > 15000) {
          console.warn(`Very high token usage detected: ${totalInputTokens} estimated input tokens`, {
            systemTokens,
            userTokens,
            conversationLength: context.conversationHistory?.length || 0
          });
        } else if (totalInputTokens > 10000) {
          console.log(`High token usage: ${totalInputTokens} estimated input tokens for conversation prevention`);
        }
        
        // Use structured output for better control
        const response = await anthropic.messages.create({
          model: this.modelConfig.primary,
          max_tokens: 2000, // Increased to handle more complex reasoning
          output_config: { effort: 'low' },
          system: systemPrompt,
          messages: [{ role: 'user', content: userPrompt }],
          tools: [{
            name: "generate_conversation_question",
            description: "Generate a contextual question for fantasy football article comments",
            input_schema: {
              type: "object",
              // Narrow down types by extracting the exact shape from zodToJsonSchema at runtime
              // Use unknown instead of any to satisfy lint without weakening types
              properties: (zodToJsonSchema(ConversationResponse) as unknown as { properties: Record<string, unknown> }).properties,
              required: (zodToJsonSchema(ConversationResponse) as unknown as { required: string[] }).required
            },
          }],
          tool_choice: { type: "tool", name: "generate_conversation_question" },
        });

        const toolUse = response.content.find((c) => c.type === 'tool_use');
        if (!toolUse || toolUse.type !== 'tool_use') {
          throw new Error('No structured output received');
        }

        // Parse tool input using zod schema, avoid any
        const structuredData = ConversationResponse.parse((toolUse as unknown as { input: unknown }).input);
        
        // Analyze for potential abuse patterns
        const abuseDetection = this.detectAbusePatterns(context);
        
        return {
          ...structuredData,
          detectedAbuse: abuseDetection,
        };
      } catch (error) {
        lastError = error as Error;
        
        // Check if this is a 529 Overloaded error that we should retry
        const errorObj = error as any;
        const is529Error = error instanceof Anthropic.APIError && errorObj.status === 529;
        const isOverloadedError = errorObj.name === 'OverloadedError' || errorObj.type === 'overloaded_error';
        
        if ((is529Error || isOverloadedError) && attempt < maxRetries) {
          // Calculate exponential backoff delay
          const delay = baseDelay * Math.pow(2, attempt) + Math.random() * 1000; // Add jitter
          console.warn(`API overloaded (attempt ${attempt + 1}/${maxRetries + 1}). Retrying in ${Math.round(delay)}ms...`, {
            error: errorObj.message || 'API overloaded',
            status: errorObj.status,
            type: errorObj.type
          });
          
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        
        // For non-retryable errors or max retries exceeded, break out of loop
        break;
      }
    }

    // If all retries failed, throw the error
    console.error('Conversation generation failed after retries:', lastError?.message);
    throw new Error(`Failed to generate conversation question: ${lastError?.message || 'Unknown error'}`);
  }

  async analyzeUserResponse(
    userResponse: string,
    context: ConversationContext,
    apiKey: string
  ): Promise<{
    responseQuality: number; // 0-100
    completeness: number; // 0-100
    relevantTopics: string[];
    needsFollowUp: boolean;
    suggestedFollowUps?: string[];
    sentiment: "positive" | "negative" | "neutral" | "mixed";
    quotableSegments: string[];
    offTopicScore: number; // 0-100, higher means more off-topic
  }> {
    const anthropic = new Anthropic({ apiKey });

    // Define structured response schema
    const ResponseAnalysisSchema = z.object({
      responseQuality: z.number().min(0).max(100).describe("Quality and quotability score (0-100)"),
      completeness: z.number().min(0).max(100).describe("Completeness of thought score (0-100)"),
      relevantTopics: z.array(z.string()).describe("Relevant fantasy football topics mentioned"),
      needsFollowUp: z.boolean().describe("Whether a follow-up question would yield better content"),
      suggestedFollowUps: z.array(z.string()).optional().describe("Suggested follow-up topics if needed"),
      sentiment: z.enum(["positive", "negative", "neutral", "mixed"]).describe("Overall sentiment of the response"),
      quotableSegments: z.array(z.string()).describe("Exact quotes that could be used in the article"),
      offTopicScore: z.number().min(0).max(100).describe("How off-topic the response is (0=on-topic, 100=completely off-topic)")
    });

    const analysisPrompt = `Analyze this user response for a fantasy football article comment request.

Context:
- Article Type: ${context.contentType}
- Week: ${context.week}
- Team Performance: ${context.teamPerformance.won ? 'Won' : 'Lost'} with ${context.teamPerformance.score} points
- Conversation Goal: Gather quotable insights about ${context.contentType === 'weekly_recap' ? 'their team\'s performance' : 'their fantasy decisions'}

User Response: "${userResponse}"

Provide a detailed analysis focusing on:
1. Response quality and quotability (0-100)
2. Completeness of thought (0-100)
3. Relevant fantasy football topics mentioned
4. Whether follow-up would yield better content
5. Sentiment analysis
6. Extract exact quotable segments (phrases that could be used in article)
7. Off-topic score (0-100, where 100 means completely off-topic)

Return your analysis as structured data.`;

    // Implement retry logic with exponential backoff for 529 errors
    let lastError: Error | null = null;
    const maxRetries = 3;
    const baseDelay = 1000; // 1 second

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const response = await anthropic.messages.create({
          model: this.modelConfig.primary,
          max_tokens: 1500, // Increased for more detailed analysis
          output_config: { effort: 'low' },
          system: "You are an expert at analyzing user responses for fantasy football content generation. Focus on identifying quotable content and assessing relevance. Return structured JSON data.",
          messages: [{ role: 'user', content: analysisPrompt }],
          tools: [{
            name: "analyze_response",
            description: "Analyze user response for fantasy football content generation",
            input_schema: {
              type: "object",
              properties: (zodToJsonSchema(ResponseAnalysisSchema) as unknown as { properties: Record<string, unknown> }).properties,
              required: (zodToJsonSchema(ResponseAnalysisSchema) as unknown as { required: string[] }).required
            },
          }],
          tool_choice: { type: "tool", name: "analyze_response" },
        });

        const toolUse = response.content.find((c) => c.type === 'tool_use');
        if (!toolUse || toolUse.type !== 'tool_use') {
          throw new Error('No structured analysis received from AI');
        }

        // Parse and validate the structured response
        const analysis = ResponseAnalysisSchema.parse((toolUse as unknown as { input: unknown }).input);
        
        return analysis;
      } catch (error) {
        lastError = error as Error;
        
        // Check if this is a 529 Overloaded error that we should retry
        const errorObj = error as any;
        const is529Error = error instanceof Anthropic.APIError && errorObj.status === 529;
        const isOverloadedError = errorObj.name === 'OverloadedError' || errorObj.type === 'overloaded_error';
        
        if ((is529Error || isOverloadedError) && attempt < maxRetries) {
          // Calculate exponential backoff delay
          const delay = baseDelay * Math.pow(2, attempt) + Math.random() * 1000; // Add jitter
          console.warn(`API overloaded (attempt ${attempt + 1}/${maxRetries + 1}). Retrying in ${Math.round(delay)}ms...`, {
            error: errorObj.message || 'API overloaded',
            status: errorObj.status,
            type: errorObj.type
          });
          
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        
        // For non-retryable errors or max retries exceeded, break out of loop
        break;
      }
    }

    // If all retries failed, fall back to local analysis
    console.warn('AI analysis failed after retries, using local fallback analysis:', lastError?.message);
    
    return {
      responseQuality: this.calculateResponseQuality(userResponse, context),
      completeness: this.calculateCompleteness(userResponse),
      relevantTopics: this.extractTopics(userResponse, context),
      needsFollowUp: userResponse.length < 50 || userResponse.includes('?') || this.shouldFollowUp(userResponse, context),
      suggestedFollowUps: this.generateSuggestedFollowUps(userResponse, context),
      sentiment: this.analyzeSentiment(userResponse),
      quotableSegments: this.extractQuotes(userResponse),
      offTopicScore: this.calculateOffTopicScore(userResponse, context),
    };
  }

  private buildConversationPrompts(context: ConversationContext): {
    systemPrompt: string;
    userPrompt: string;
  } {
    const isInitialMessage = !context.conversationHistory || context.conversationHistory.length === 0;
    
    const systemPrompt = `You are a fantasy football content creator gathering quotes and insights from league members for an upcoming ${context.contentType.replace('_', ' ')} article.

CRITICAL RULES:
1. ONLY ask questions - NEVER provide analysis, opinions, or answers
2. Stay laser-focused on the article topic and the user's specific team/situation
3. Ask for their thoughts, decisions, and reactions - not general advice
4. Keep questions concise and specific to their experience
5. If user tries to chat or ask you questions, politely redirect to getting their input
6. End conversations naturally after getting good quotes (1-3 exchanges max)
7. NEVER make assumptions about player status - use ONLY the provided data about players (especially rookie status)
8. NEVER repeat questions about topics already covered in the conversation
9. If you have sufficient quotable material, set shouldEndAfterResponse: true

CONVERSATION FLOW:
- Initial question: Broad but specific to their situation
- Follow-up 1: Dig deeper into something specific they mentioned
- Follow-up 2 (if needed): Explore one remaining unexplored aspect
- End: After 2-3 quality exchanges or when you have enough material

CONVERSATION STYLE:
- Casual but focused, like a reporter doing a quick interview
- Reference specific players, scores, and situations from their team
- Show you've done your homework about their team's performance
- Make them feel their input is valuable for the article
- Use accurate player information from the provided context

ANTI-PATTERNS TO AVOID:
- Generic questions that could apply to any team
- Asking for advice or tips
- Engaging in back-and-forth analysis
- Responding to off-topic comments
- Continuing conversation after getting good quotes
- Making incorrect assumptions about players (e.g., calling veterans "rookies")
- Repeating similar questions already asked in the conversation
- Asking about the same topic with different wording
- Dragging out conversations beyond 3-4 total exchanges`;

    const userPrompt = this.buildUserPrompt(context, isInitialMessage);
    
    return { systemPrompt, userPrompt };
  }

  private buildUserPrompt(context: ConversationContext, isInitial: boolean): string {
    const { teamPerformance, leagueContext, week, contentType, conversationHistory, seasonId } = context;
    
    if (isInitial) {
      // Initial message crafting based on content type
      switch (contentType) {
        case 'weekly_recap':
          if (teamPerformance.won) {
            const topPerformer = teamPerformance.overperformers[0];
            return `Generate an initial question for ${teamPerformance.teamName}'s manager about their Week ${week} victory.
          
Team Context:
- Won with ${teamPerformance.score} points (projected: ${teamPerformance.projectedScore || 'N/A'})
- Top performer: ${topPerformer?.player || 'N/A'} (${topPerformer?.actualPts || 0} pts vs ${topPerformer?.expectedPts || 0} expected)
- Current standing: ${this.getTeamStanding(teamPerformance.teamId, leagueContext.standings)}
${leagueContext.playoffContext?.isPlayoffWeek ? `- PLAYOFF WEEK: ${leagueContext.playoffContext.playoffImplications}` : ''}

Focus the question on:
1. Their key decision that led to victory
2. Specific player performance they're proud of
3. How this win impacts their season goals`;
          } else {
            const worstPerformer = teamPerformance.underperformers[0];
            return `Generate an initial question for ${teamPerformance.teamName}'s manager about their Week ${week} loss.
          
Team Context:
- Lost with ${teamPerformance.score} points (projected: ${teamPerformance.projectedScore || 'N/A'})
- Biggest disappointment: ${worstPerformer?.player || 'N/A'} (${worstPerformer?.actualPts || 0} pts vs ${worstPerformer?.expectedPts || 0} expected)
- Current standing: ${this.getTeamStanding(teamPerformance.teamId, leagueContext.standings)}
${leagueContext.playoffContext?.isPlayoffWeek ? `- PLAYOFF IMPLICATIONS: ${leagueContext.playoffContext.playoffImplications}` : ''}

Focus the question on:
1. Which player disappointment hurt most and why
2. What they would have done differently
3. Their mindset going forward`;
          }

        case 'weekly_preview':
          return `Generate an initial question for ${teamPerformance.teamName}'s manager about their upcoming Week ${week} matchup.
          
Team Context:
- Current standing: ${this.getTeamStanding(teamPerformance.teamId, leagueContext.standings)}
- Last week's score: ${teamPerformance.score} points
${leagueContext.playoffContext?.isPlayoffWeek ? `- PLAYOFF IMPLICATIONS: ${leagueContext.playoffContext.playoffImplications}` : ''}

Focus the question on:
1. Their lineup strategy for this week
2. Key players they're counting on
3. Concerns about their opponent
4. Any tough start/sit decisions they're facing`;

        case 'trade_analysis':
          return `Generate an initial question for ${teamPerformance.teamName}'s manager about a recent trade.
          
Team Context:
- Current standing: ${this.getTeamStanding(teamPerformance.teamId, leagueContext.standings)}
- Recent performance: ${teamPerformance.score} points in Week ${week}
${leagueContext.recentTrades?.length ? `- Recent league trades: ${leagueContext.recentTrades.length} trades completed` : ''}

Focus the question on:
1. What motivated them to pursue/accept this trade
2. Which player they're most excited/sad about
3. How this impacts their playoff push
4. Their negotiation strategy`;

        case 'power_rankings':
          const teamStanding = this.getTeamStanding(teamPerformance.teamId, leagueContext.standings);
          return `Generate an initial question for ${teamPerformance.teamName}'s manager about their power ranking position.
          
Team Context:
- Current standing: ${teamStanding}
- Recent performance: ${teamPerformance.score} points in Week ${week}
- Trend: ${teamPerformance.won ? 'Won last game' : 'Lost last game'}

Focus the question on:
1. Whether they agree with their ranking
2. What they think sets them apart from teams around them
3. Their biggest strength or weakness
4. Teams they view as their main competition`;

        case 'waiver_wire_report':
          return `Generate an initial question for ${teamPerformance.teamName}'s manager about waiver wire strategy.
          
Team Context:
- Current standing: ${this.getTeamStanding(teamPerformance.teamId, leagueContext.standings)}
- Recent underperformers: ${teamPerformance.underperformers[0]?.player || 'None'}
- FAAB/Priority status: Available for Week ${week}

Focus the question on:
1. Their biggest roster needs right now
2. Players they're targeting on waivers
3. Who they might drop to make room
4. Their FAAB bidding strategy or waiver priority`;

        case 'mock_draft':
        case 'draft_rankings':
          const draftInfo = context.draftData;
          const userPicks = draftInfo?.userDraftPicks || [];
          const topPicks = userPicks.slice(0, 3).map((p: any) => {
            const rookieLabel = p.isRookie ? ' [ROOKIE]' : '';
            return `Round ${p.roundNumber}: ${p.playerName} (${p.playerPosition})${rookieLabel}`;
          }).join(', ');
          
          // Get draft position info
          const draftPosition = draftInfo?.draftOrder?.find((d: any) => d.teamName === teamPerformance.teamName)?.position || 'Unknown';
          
          // Identify notable picks with rookie status
          const firstPick = userPicks[0];
          const rookiePicks = userPicks.filter(p => p.isRookie);
          const valuePicks = userPicks.filter(p => p.perceivedValue > 10);
          
          return `Generate an initial question for ${teamPerformance.teamName}'s manager about the ${seasonId} draft.
          
Team Context:
- Team: ${teamPerformance.teamName}
- Draft Type: ${draftInfo?.draftType || 'Standard'}
- Draft Position: ${draftPosition}
${topPicks ? `- Top Picks: ${topPicks}` : ''}
- Current roster standing: ${this.getTeamStanding(teamPerformance.teamId, leagueContext.standings)}
${rookiePicks.length > 0 ? `- Rookie Picks: ${rookiePicks.map(p => `${p.playerName} (${p.playerPosition})`).join(', ')}` : ''}
${valuePicks.length > 0 ? `- Value Picks: ${valuePicks.map(p => `${p.playerName} (Round ${p.roundNumber})`).join(', ')}` : ''}

Focus the question on:
1. Their draft strategy from position ${draftPosition}
2. Specific players they drafted (${firstPick?.playerName || 'their first pick'}${firstPick?.isRookie ? ' - a rookie' : ' - a veteran'})
3. Best value pick or biggest reach from their selections
4. How they feel about their drafted team overall
5. Players they missed out on or wished they got

IMPORTANT: Use the isRookie field accurately - ${firstPick?.playerName || 'their first pick'} is ${firstPick?.isRookie ? 'a rookie' : 'NOT a rookie'}.`;

        case 'rivalry_week_special':
          return `Generate an initial question for ${teamPerformance.teamName}'s manager about their rivalry matchup.
          
Team Context:
- Current standing: ${this.getTeamStanding(teamPerformance.teamId, leagueContext.standings)}
- Week ${week} opponent: Their rival
${leagueContext.rivalries?.length ? '- Known league rivalry' : ''}

Focus the question on:
1. The history of this rivalry
2. Trash talk or side bets
3. Why this matchup matters more than others
4. Their game plan to win`;

        case 'emergency_hot_takes':
          return `Generate an initial question for ${teamPerformance.teamName}'s manager about breaking news/events.
          
Team Context:
- Team: ${teamPerformance.teamName}
- Current standing: ${this.getTeamStanding(teamPerformance.teamId, leagueContext.standings)}
- Affected by recent news: Week ${week}

Focus the question on:
1. Their immediate reaction to the news
2. How this impacts their lineup decisions
3. Whether they saw this coming
4. Their contingency plans`;

        case 'trade_rumor_mill':
          return `Generate an initial question for ${teamPerformance.teamName}'s manager about trade rumors.
          
Team Context:
- Team: ${teamPerformance.teamName}
- Current standing: ${this.getTeamStanding(teamPerformance.teamId, leagueContext.standings)}

Focus the question on:
1. Players they're looking to move
2. What they need in return
3. Teams they've been talking to
4. Their trade deadline strategy`;

        case 'mid_season_awards':
          return `Generate an initial question for ${teamPerformance.teamName}'s manager about mid-season awards.
          
Team Context:
- Team: ${teamPerformance.teamName}
- Current standing: ${this.getTeamStanding(teamPerformance.teamId, leagueContext.standings)}
- Best performer: ${teamPerformance.overperformers[0]?.player || 'N/A'}
- Biggest bust: ${teamPerformance.underperformers[0]?.player || 'N/A'}

Focus the question on:
1. Their MVP candidate from their team or league
2. Biggest surprise/disappointment player
3. Best/worst manager move so far
4. Predictions for second half`;

        case 'championship_manifesto':
          return `Generate an initial question for ${teamPerformance.teamName}'s manager about the championship.
          
Team Context:
- Team: ${teamPerformance.teamName}
- Championship week performance
- Season journey to this point

Focus the question on:
1. Their emotions heading into championship week
2. Key decisions that got them here
3. Their game plan for the title
4. What winning would mean to them`;

        case 'season_recap':
          return `Generate an initial question for ${teamPerformance.teamName}'s manager about the completed season.
          
Team Context:
- Team: ${teamPerformance.teamName}
- Final standing: ${this.getTeamStanding(teamPerformance.teamId, leagueContext.standings)}
- Season ${seasonId} complete

Focus the question on:
1. Overall feelings about their season
2. Best and worst moments
3. What they learned for next year
4. Players they'll keep/target in next draft`;

        case 'custom_roast':
          return `Generate an initial question for ${teamPerformance.teamName}'s manager for a roast article.
          
Team Context:
- Team being roasted: ${teamPerformance.teamName}
- Current standing: ${this.getTeamStanding(teamPerformance.teamId, leagueContext.standings)}
- Recent blunders in Week ${week}

Focus the question on:
1. Their worst decision this season
2. Most embarrassing loss
3. Player they regret drafting most
4. Whether they accept responsibility for failures`;

        case 'season_welcome':
          return `Generate an initial question for ${teamPerformance.teamName}'s manager for season welcome article.
          
Team Context:
- Team: ${teamPerformance.teamName}
- League history participant
- New season ${seasonId}

Focus the question on:
1. Favorite league memory from past seasons
2. Their team's identity or reputation
3. Goals for the new season
4. Predictions for how the league will unfold`;

        default:
          // Fallback for any unhandled content types
          return `Generate an initial question for ${teamPerformance.teamName}'s manager about the ${contentType.replace('_', ' ')} article.
          
Team Context:
- Team: ${teamPerformance.teamName}
- Current standing: ${this.getTeamStanding(teamPerformance.teamId, leagueContext.standings)}
- Week ${week}, Season ${seasonId}

Focus on getting their unique perspective and quotable insights for the article.`;
      }
    } else {
      // Follow-up message based on conversation history
      const lastUserMessage = conversationHistory?.filter(m => m.role === 'user').pop();
      const allUserMessages = conversationHistory?.filter(m => m.role === 'user') || [];
      const allAIMessages = conversationHistory?.filter(m => m.role === 'ai') || [];
      
      // Extract specific topics and questions that have already been covered
      const discussedTopics = this.extractDiscussedTopics(allUserMessages, allAIMessages, context);
      // Include all AI questions to prevent repetition
      const allAIQuestions = allAIMessages.map(msg => msg.content).join('\n\n');
      
      // Check if we should end the conversation
      const shouldConsiderEnding = allUserMessages.length >= 2 || 
        (lastUserMessage && lastUserMessage.content.length > 100 && discussedTopics.length >= 3);
      
      let followUpPrompt = `Generate a follow-up question based on the conversation history.
      
Previous user response: "${lastUserMessage?.content || 'None'}"
Team: ${teamPerformance.teamName}
Context: ${contentType.replace('_', ' ')} for Week ${week}
Total user responses: ${allUserMessages.length}
Total conversation exchanges: ${Math.floor((conversationHistory?.length || 0) / 2)}

TOPICS ALREADY COVERED (DO NOT REPEAT):
${discussedTopics.map(topic => `- ${topic}`).join('\n')}

ALL PREVIOUS AI QUESTIONS (AVOID SIMILAR PHRASING):
${allAIQuestions}

${shouldConsiderEnding ? `
IMPORTANT: This conversation has ${allUserMessages.length} user responses. Consider if we have enough quotable material to end naturally. Only continue if the user's last response was incomplete or if there's a specific detail worth exploring further.

If the user has provided substantial insights about their team/strategy, you should set shouldEndAfterResponse: true to end the conversation gracefully.
` : ''}

Create a follow-up that:
1. Digs deeper into something NEW and specific they mentioned in their last response
2. Asks for more detail on a decision or player they referenced (but haven't already discussed)
3. Stays focused on getting quotable content for the article
4. COMPLETELY AVOIDS repeating questions about topics already covered above
5. Uses different wording and approach than previous AI questions
6. ${shouldConsiderEnding ? 'STRONGLY considers ending the conversation if we have sufficient material' : 'Explores new aspects of their team/strategy'}`;

      // Add draft-specific context for follow-ups if available
      if ((contentType === 'draft_rankings' || contentType === 'mock_draft') && context.draftData?.userDraftPicks) {
        const userPicks = context.draftData.userDraftPicks;
        followUpPrompt += `

Draft Context for Follow-up:
${userPicks.map(p => `- ${p.playerName} (${p.playerPosition}, Round ${p.roundNumber})${p.isRookie ? ' [ROOKIE]' : ' [VETERAN]'} - ${p.perceivedValue > 0 ? 'Good value' : 'Reach'}`).join('\n')}

CRITICAL: Use accurate rookie status from the data above. Do NOT assume any player is a rookie unless marked [ROOKIE].`;
      }
      
      return followUpPrompt;
    }
  }

  private getTeamStanding(teamId: string, standings: Array<{ teamId: string; teamName: string; rank: number; record: string }>): string {
    // Debug logging for team standing lookup
    console.log("getTeamStanding debug:", {
      lookingForTeamId: teamId,
      standingsCount: standings.length,
      availableTeamIds: standings.map(s => ({ teamId: s.teamId, teamName: s.teamName, rank: s.rank })),
    });
    
    const standing = standings.find(s => s.teamId === teamId);
    const result = standing ? `#${standing.rank} (${standing.record})` : 'Unknown';
    
    console.log("getTeamStanding result:", {
      teamId,
      foundStanding: !!standing,
      foundTeamName: standing?.teamName,
      result,
    });
    
    return result;
  }

  private extractDiscussedTopics(
    userMessages: Array<{ content: string }>, 
    aiMessages: Array<{ content: string }>, 
    context: ConversationContext
  ): string[] {
    const topics: Set<string> = new Set();
    
    // Extract topics from user messages
    userMessages.forEach(msg => {
      const content = msg.content.toLowerCase();
      
      // Check for player mentions
      if (context.draftData?.userDraftPicks) {
        context.draftData.userDraftPicks.forEach(pick => {
          if (content.includes(pick.playerName.toLowerCase())) {
            topics.add(`${pick.playerName} (${pick.playerPosition})`);
          }
        });
      }
      
      // Check for strategy mentions
      if (content.includes('rookie') || content.includes('young')) {
        topics.add('rookie/young player strategy');
      }
      if (content.includes('veteran') || content.includes('experienced')) {
        topics.add('veteran player strategy');
      }
      if (content.includes('draft') && (content.includes('strategy') || content.includes('approach'))) {
        topics.add('overall draft strategy');
      }
      if (content.includes('value') || content.includes('reach')) {
        topics.add('draft value and reaches');
      }
      if (content.includes('trade')) {
        topics.add('trade considerations');
      }
      if (content.includes('waiver') || content.includes('pickup')) {
        topics.add('waiver wire strategy');
      }
      if (content.includes('lineup') || content.includes('start') || content.includes('sit')) {
        topics.add('lineup decisions');
      }
    });
    
    // Extract topics from AI questions to understand what was asked about
    aiMessages.forEach(msg => {
      const content = msg.content.toLowerCase();
      
      // Draft strategy topics
      if (content.includes('rookie') || content.includes('first-year')) {
        topics.add('rookie/first-year player strategy');
      }
      if (content.includes('veteran') || content.includes('experienced') || content.includes('proven')) {
        topics.add('veteran/experienced player strategy');
      }
      if (content.includes('young') && (content.includes('player') || content.includes('talent'))) {
        topics.add('young player preferences');
      }
      if (content.includes('draft') && (content.includes('strategy') || content.includes('approach') || content.includes('philosophy'))) {
        topics.add('overall draft strategy/approach');
      }
      if (content.includes('value') || content.includes('reach') || content.includes('adp')) {
        topics.add('draft value and reaches');
      }
      if (content.includes('position') && content.includes('draft')) {
        topics.add('draft position strategy');
      }
      
      // Performance topics
      if (content.includes('performance') || content.includes('production')) {
        topics.add('player performance discussion');
      }
      if (content.includes('disappointment') || content.includes('underperform')) {
        topics.add('player disappointments');
      }
      if (content.includes('surprise') || content.includes('overperform')) {
        topics.add('player surprises');
      }
      
      // Decision topics
      if (content.includes('decision') || content.includes('choice')) {
        topics.add('decision-making process');
      }
      if (content.includes('regret') || content.includes('mistake')) {
        topics.add('regrets and mistakes');
      }
      if (content.includes('confident') || content.includes('proud')) {
        topics.add('confident decisions');
      }
    });
    
    return Array.from(topics);
  }

  private detectAbusePatterns(context: ConversationContext): AIConversationResult['detectedAbuse'] {
    const lastMessage = context.conversationHistory?.filter(m => m.role === 'user').pop();
    if (!lastMessage) return undefined;

    const content = lastMessage.content.toLowerCase();
    
    // Check for off-topic patterns
    const offTopicKeywords = ['weather', 'politics', 'recipe', 'how do i', 'what is', 'can you help'];
    const hasOffTopic = offTopicKeywords.some(keyword => content.includes(keyword));
    
    // Check for spam patterns
    const spamPatterns = /(.)\1{4,}|[A-Z]{10,}|http/;
    const isSpam = spamPatterns.test(content) || content.length > 1000;
    
    // Check for AI questioning
    const aiQuestions = ['what model are you', 'are you chatgpt', 'how do you work', 'tell me about yourself'];
    const isQuestioningAI = aiQuestions.some(q => content.includes(q));
    
    if (isQuestioningAI) {
      return {
        type: 'questioning_ai',
        severity: 'medium',
        reason: 'User trying to engage with AI instead of providing fantasy football insights'
      };
    }
    
    if (isSpam) {
      return {
        type: 'spam',
        severity: 'high',
        reason: 'Message appears to be spam or nonsense'
      };
    }
    
    if (hasOffTopic) {
      return {
        type: 'off_topic',
        severity: 'low',
        reason: 'Response is not related to fantasy football or the article topic'
      };
    }
    
    return undefined;
  }

  private extractTopics(response: string, context: ConversationContext): string[] {
    const topics: string[] = [];
    const lowerResponse = response.toLowerCase();
    
    // Check for player mentions
    [...context.teamPerformance.underperformers, ...context.teamPerformance.overperformers].forEach(player => {
      if (lowerResponse.includes(player.player.toLowerCase())) {
        topics.push(`${player.player} performance`);
      }
    });
    
    // Check for decision types
    if (lowerResponse.includes('start') || lowerResponse.includes('bench')) {
      topics.push('start/sit decision');
    }
    if (lowerResponse.includes('waiver') || lowerResponse.includes('pickup')) {
      topics.push('waiver wire move');
    }
    if (lowerResponse.includes('trade')) {
      topics.push('trade consideration');
    }
    
    // Check for emotional/strategic themes
    if (lowerResponse.includes('mistake') || lowerResponse.includes('regret')) {
      topics.push('roster regret');
    }
    if (lowerResponse.includes('lucky') || lowerResponse.includes('fortunate')) {
      topics.push('luck factor');
    }
    
    return topics;
  }

  private analyzeSentiment(response: string): "positive" | "negative" | "neutral" | "mixed" {
    const lower = response.toLowerCase();
    
    const positiveWords = ['great', 'awesome', 'perfect', 'happy', 'excited', 'love', 'best', 'win', 'success'];
    const negativeWords = ['terrible', 'awful', 'hate', 'worst', 'disaster', 'failed', 'disappointed', 'frustrat'];
    
    const positiveCount = positiveWords.filter(word => lower.includes(word)).length;
    const negativeCount = negativeWords.filter(word => lower.includes(word)).length;
    
    if (positiveCount > negativeCount + 1) return 'positive';
    if (negativeCount > positiveCount + 1) return 'negative';
    if (positiveCount > 0 && negativeCount > 0) return 'mixed';
    return 'neutral';
  }

  private extractQuotes(response: string): string[] {
    const quotes: string[] = [];
    
    // Split into sentences
    const sentences = response.match(/[^.!?]+[.!?]+/g) || [];
    
    // Look for quotable sentences (opinionated, specific, emotional)
    sentences.forEach(sentence => {
      const trimmed = sentence.trim();
      
      // Good quote indicators
      const hasOpinion = /I (think|believe|feel|knew|should|couldn't|had to)/i.test(trimmed);
      const hasEmotion = /(frustrat|disappoint|thrill|excit|angry|happy|devastat)/i.test(trimmed);
      const hasSpecificity = /\d+\s*(points|yards|touchdowns|receptions)/.test(trimmed);
      const isReasonablyShort = trimmed.length < 200;
      
      if ((hasOpinion || hasEmotion || hasSpecificity) && isReasonablyShort) {
        quotes.push(trimmed);
      }
    });
    
    return quotes.slice(0, 3); // Return top 3 quotes
  }

  private calculateOffTopicScore(response: string, context: ConversationContext): number {
    const lower = response.toLowerCase();
    let score = 0;
    
    // Fantasy football keywords (lower score = more on topic)
    const ffKeywords = ['team', 'player', 'points', 'roster', 'lineup', 'start', 'bench', 'waiver', 'trade', 'matchup', 'week', 'score'];
    const ffMatches = ffKeywords.filter(keyword => lower.includes(keyword)).length;
    
    // Reduce score for each FF keyword found
    score = Math.max(0, 50 - (ffMatches * 10));
    
    // Increase score for clearly off-topic content
    const offTopicIndicators = ['recipe', 'weather', 'politics', 'movie', 'restaurant', 'vacation'];
    const offTopicMatches = offTopicIndicators.filter(keyword => lower.includes(keyword)).length;
    score += offTopicMatches * 25;
    
    // Check if response mentions specific players from context
    const mentionsContextPlayers = [...context.teamPerformance.underperformers, ...context.teamPerformance.overperformers]
      .some(player => lower.includes(player.player.toLowerCase()));
    
    if (mentionsContextPlayers) {
      score = Math.max(0, score - 20);
    }
    
    return Math.min(100, score);
  }

  private calculateResponseQuality(response: string, context: ConversationContext): number {
    let quality = 50; // Base quality score
    
    // Length factor - longer responses tend to be more substantial
    if (response.length > 100) quality += 15;
    if (response.length > 200) quality += 10;
    
    // Check for specific details
    const hasSpecifics = /\d+\s*(points|yards|touchdowns)/.test(response);
    if (hasSpecifics) quality += 20;
    
    // Check for emotional content (more quotable)
    const emotionalWords = ['excited', 'frustrated', 'disappointed', 'thrilled', 'angry', 'happy'];
    const hasEmotion = emotionalWords.some(word => response.toLowerCase().includes(word));
    if (hasEmotion) quality += 15;
    
    // Check for player mentions from context
    const mentionsContextPlayers = [...context.teamPerformance.underperformers, ...context.teamPerformance.overperformers]
      .some(player => response.toLowerCase().includes(player.player.toLowerCase()));
    if (mentionsContextPlayers) quality += 10;
    
    return Math.min(100, quality);
  }

  private calculateCompleteness(response: string): number {
    let completeness = 30; // Base score
    
    // Length indicates more complete thoughts
    if (response.length > 50) completeness += 20;
    if (response.length > 150) completeness += 25;
    if (response.length > 300) completeness += 25;
    
    // Check for reasoning words
    const reasoningWords = ['because', 'since', 'therefore', 'however', 'although', 'but'];
    const hasReasoning = reasoningWords.some(word => response.toLowerCase().includes(word));
    if (hasReasoning) completeness += 15;
    
    // Questions suggest incomplete thoughts
    if (response.includes('?')) completeness -= 15;
    
    return Math.min(100, Math.max(0, completeness));
  }

  private shouldFollowUp(response: string, context: ConversationContext): boolean {
    // Short responses need follow-up
    if (response.length < 50) return true;
    
    // Responses with questions need follow-up
    if (response.includes('?')) return true;
    
    // Vague responses need follow-up
    const vagueIndicators = ['not sure', 'maybe', 'i guess', 'probably', 'kinda'];
    const hasVagueLanguage = vagueIndicators.some(phrase => response.toLowerCase().includes(phrase));
    
    return hasVagueLanguage;
  }

  private estimateTokens(text: string): number {
    // Rough estimation: ~4 characters per token for English text
    return Math.ceil(text.length / 4);
  }

  private generateSuggestedFollowUps(response: string, context: ConversationContext): string[] {
    const suggestions: string[] = [];
    const lower = response.toLowerCase();
    
    // If they mention a player decision, ask for details
    if (lower.includes('start') || lower.includes('bench')) {
      suggestions.push('What made you decide on that start/sit choice?');
    }
    
    // If they mention frustration, dig deeper
    if (lower.includes('frustrat') || lower.includes('disappoint')) {
      suggestions.push('What was the most frustrating part of that decision?');
    }
    
    // If they mention a specific player, ask about impact
    const mentionedPlayers = [...context.teamPerformance.underperformers, ...context.teamPerformance.overperformers]
      .filter(player => lower.includes(player.player.toLowerCase()));
    if (mentionedPlayers.length > 0) {
      suggestions.push(`How did ${mentionedPlayers[0].player}'s performance affect your week?`);
    }
    
    // Default follow-ups if nothing specific
    if (suggestions.length === 0) {
      suggestions.push('Can you tell me more about that decision?');
      suggestions.push('What was going through your mind when that happened?');
    }
    
    return suggestions.slice(0, 3); // Return max 3 suggestions
  }
}

// Export singleton instance
export const conversationService = new ConversationService();