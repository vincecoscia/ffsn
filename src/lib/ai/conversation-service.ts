import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

// Conversation context interface
export interface ConversationContext {
  userId: string;
  leagueId: string;
  scheduledContentId: string;
  contentType: "weekly_recap" | "trade_analysis" | "waiver_wire_report";
  week: number;
  seasonId: number;
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
    primary: "claude-sonnet-4-20250514",
    fallback: "claude-3-7-sonnet-20250219",
  };

  async generateConversationQuestion(
    context: ConversationContext,
    apiKey: string
  ): Promise<AIConversationResult> {
    const anthropic = new Anthropic({ apiKey });

    try {
      const { systemPrompt, userPrompt } = this.buildConversationPrompts(context);
      
      // Use structured output for better control
      const response = await anthropic.messages.create({
        model: this.modelConfig.primary,
        max_tokens: 1000,
        temperature: 0.7,
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
      console.error('Conversation generation failed:', error);
      throw new Error('Failed to generate conversation question');
    }
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

    const analysisPrompt = `Analyze this user response for a fantasy football article comment request.

Context:
- Article Type: ${context.contentType}
- Week: ${context.week}
- Team Performance: ${context.teamPerformance.won ? 'Won' : 'Lost'} with ${context.teamPerformance.score} points
- Conversation Goal: Gather quotable insights about ${context.contentType === 'weekly_recap' ? 'their team\'s performance' : 'their fantasy decisions'}

User Response: "${userResponse}"

Analyze for:
1. Response quality and quotability (0-100)
2. Completeness of thought (0-100)
3. Relevant topics mentioned
4. Whether follow-up would yield better content
5. Sentiment analysis
6. Extract any quotable segments (exact quotes that could be used in article)
7. Off-topic score (0-100, where 100 means completely off-topic)

Return a structured analysis.`;

    try {
      await anthropic.messages.create({
        model: this.modelConfig.primary,
        max_tokens: 1000,
        temperature: 0.3,
        system: "You are an expert at analyzing user responses for fantasy football content generation. Focus on identifying quotable content and assessing relevance.",
        messages: [{ role: 'user', content: analysisPrompt }],
      });

      // Parse the response (implement proper parsing based on Claude's output format)
      // This is a simplified version - implement proper parsing
      return {
        responseQuality: 70,
        completeness: 80,
        relevantTopics: this.extractTopics(userResponse, context),
        needsFollowUp: userResponse.length < 50 || userResponse.includes('?'),
        sentiment: this.analyzeSentiment(userResponse),
        quotableSegments: this.extractQuotes(userResponse),
        offTopicScore: this.calculateOffTopicScore(userResponse, context),
      };
    } catch (error) {
      console.error('Response analysis failed:', error);
      throw new Error('Failed to analyze user response');
    }
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

CONVERSATION STYLE:
- Casual but focused, like a reporter doing a quick interview
- Reference specific players, scores, and situations from their team
- Show you've done your homework about their team's performance
- Make them feel their input is valuable for the article

ANTI-PATTERNS TO AVOID:
- Generic questions that could apply to any team
- Asking for advice or tips
- Engaging in back-and-forth analysis
- Responding to off-topic comments
- Continuing conversation after getting good quotes`;

    const userPrompt = this.buildUserPrompt(context, isInitialMessage);
    
    return { systemPrompt, userPrompt };
  }

  private buildUserPrompt(context: ConversationContext, isInitial: boolean): string {
    const { teamPerformance, leagueContext, week, contentType, conversationHistory } = context;
    
    if (isInitial) {
      // Initial message crafting based on context
      if (contentType === 'weekly_recap') {
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
          // Lost - focus on underperformers
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
      }
      // Add other content types as needed
    } else {
      // Follow-up message based on conversation history
      const lastUserMessage = conversationHistory?.filter(m => m.role === 'user').pop();
      return `Generate a follow-up question based on the conversation history.
      
Previous user response: "${lastUserMessage?.content}"
Team: ${teamPerformance.teamName}
Context: ${contentType} for Week ${week}

Create a follow-up that:
1. Digs deeper into something specific they mentioned
2. Asks for more detail on a decision or player
3. Stays focused on getting quotable content for the article
4. Considers ending the conversation if we have enough good material`;
    }

    return '';
  }

  private getTeamStanding(teamId: string, standings: Array<{ teamId: string; rank: number; record: string }>): string {
    const standing = standings.find(s => s.teamId === teamId);
    return standing ? `#${standing.rank} (${standing.record})` : 'Unknown';
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
}

// Export singleton instance
export const conversationService = new ConversationService();