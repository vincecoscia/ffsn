import { Id } from "../../../convex/_generated/dataModel";

export interface CommentResponseData {
  userId: Id<"users">;
  userName?: string;
  teamName?: string;
  rawResponse: string;
  processedResponse: string;
  responseType: "opinion" | "analysis" | "prediction" | "story" | "question" | "mixed";
  relevanceMetadata: {
    topicRelevance: number;
    qualityScore: number;
    extractedQuotes?: string[];
    keyInsights?: string[];
    suggestedUsage?: string;
  };
}

export interface CommentIntegrationContext {
  commentResponses: CommentResponseData[];
  contentType: string;
  week?: number;
}

/**
 * Formats comment responses for inclusion in AI prompts
 */
export function formatCommentsForPrompt(context: CommentIntegrationContext): string {
  if (context.commentResponses.length === 0) {
    return "";
  }

  const sections: string[] = [
    "\n=== LEAGUE MEMBER COMMENTS ===",
    "The following are actual quotes and insights from league members about this topic:",
    ""
  ];

  // For weekly recaps, organize comments by team for better matchup association
  if (context.contentType === 'weekly_recap') {
    sections.push("COMMENTS BY TEAM (for matchup integration):");
    sections.push("🚨 CRITICAL RULE: When analyzing each matchup, ONLY use comments from the teams involved in that specific matchup.");
    sections.push("🚨 VIOLATION EXAMPLES TO AVOID:");
    sections.push("   ❌ WRONG: Analyzing 'Team A vs Team B' but using comments from 'Team C'");
    sections.push("   ❌ WRONG: Using generic comments that don't specify which team they're from");
    sections.push("   ✅ CORRECT: Analyzing 'Team A vs Team B' and ONLY using comments from '## Team A:' and '## Team B:' sections");
    sections.push("");
    
    // Group by team name for weekly recaps
    const commentsByTeam = context.commentResponses.reduce((acc, response) => {
      const teamKey = response.teamName || "Unknown Team";
      if (!acc[teamKey]) {
        acc[teamKey] = [];
      }
      acc[teamKey].push(response);
      return acc;
    }, {} as Record<string, CommentResponseData[]>);

    // Format each team's comments with enhanced context
    Object.entries(commentsByTeam).forEach(([teamName, responses]) => {
      sections.push(`## ${teamName}:`);
      sections.push(`MANAGER: ${responses[0]?.userName || "Unknown"}`);
      sections.push(`🎯 TEAM CONTEXT: Use these comments ONLY when analyzing ${teamName}'s matchups`);
      sections.push(`🚫 DO NOT use these comments when analyzing other teams' matchups`);
      sections.push("");
      
      responses.forEach(response => {
        const questionContext = response.relevanceMetadata.suggestedUsage || "about their team performance";
        sections.push(`**${response.userName || "Anonymous"} - ${questionContext}:**`);
        
        // Use extracted quotes if available, otherwise use processed response
        if (response.relevanceMetadata.extractedQuotes && response.relevanceMetadata.extractedQuotes.length > 0) {
          response.relevanceMetadata.extractedQuotes.forEach(quote => {
            sections.push(`> "${quote}"`);
          });
        } else {
          // Format the response as a quote
          const quotedResponse = response.processedResponse
            .split('\n')
            .map(line => `> ${line}`)
            .join('\n');
          sections.push(quotedResponse);
        }

        // Add key insights if available
        if (response.relevanceMetadata.keyInsights && response.relevanceMetadata.keyInsights.length > 0) {
          sections.push("*Question topics:* " + response.relevanceMetadata.keyInsights.join(", "));
        }
        sections.push("");
      });
      sections.push("---");
      sections.push("");
    });
  } else {
    // For other content types, use the original grouping by response type
    const groupedComments = context.commentResponses.reduce((acc, response) => {
      if (!acc[response.responseType]) {
        acc[response.responseType] = [];
      }
      acc[response.responseType].push(response);
      return acc;
    }, {} as Record<string, CommentResponseData[]>);

    // Format each group
    Object.entries(groupedComments).forEach(([type, responses]) => {
      const typeLabel = getResponseTypeLabel(type);
      sections.push(`## ${typeLabel}:`);
      
      responses.forEach(response => {
        // Include question context in the header
        const questionContext = response.relevanceMetadata.suggestedUsage || "about their team";
        sections.push(`\n**${response.userName || "Anonymous"} (${response.teamName || "Unknown Team"}) - ${questionContext}:**`);
        
        // Use extracted quotes if available, otherwise use processed response
        if (response.relevanceMetadata.extractedQuotes && response.relevanceMetadata.extractedQuotes.length > 0) {
          response.relevanceMetadata.extractedQuotes.forEach(quote => {
            sections.push(`> "${quote}"`);
          });
        } else {
          // Format the response as a quote
          const quotedResponse = response.processedResponse
            .split('\n')
            .map(line => `> ${line}`)
            .join('\n');
          sections.push(quotedResponse);
        }

        // Add key insights if available (these now contain question contexts)
        if (response.relevanceMetadata.keyInsights && response.relevanceMetadata.keyInsights.length > 0) {
          sections.push("\n*Question topics:* " + response.relevanceMetadata.keyInsights.join(", "));
        }
      });
      sections.push("");
    });
  }

  sections.push("=== END OF MEMBER COMMENTS ===");
  sections.push("");
  sections.push("🚨 FINAL REMINDER FOR WEEKLY RECAPS:");
  sections.push("- Each matchup analysis should ONLY reference comments from the teams in that specific matchup");
  sections.push("- If analyzing 'Chodie mcgruber vs Moisty Loins', ONLY use comments from those two team sections");
  sections.push("- NEVER use comments from other teams like 'Team Destroyers' when analyzing different teams");
  sections.push("- If a team has no comments, analyze their game without quotes - don't substitute other teams' comments");
  sections.push("");

  return sections.join('\n');
}

/**
 * Generates instructions for AI on how to use the comments
 */
export function getCommentIntegrationInstructions(contentType: string): string {
  const baseInstructions = `
IMPORTANT: You have been provided with actual comments from league members. You MUST:
1. Reference and quote these comments naturally throughout the article
2. ALWAYS use member names when attributing quotes (e.g., "As John from Team Destroyers noted...")
3. ALWAYS provide context about what question or topic prompted their response
4. Weave their insights into your narrative - don't just list them
5. Respond to their opinions and build upon their observations
6. Create a conversational feel by acknowledging different viewpoints
7. NEVER quote someone without their name - anonymous quotes are forbidden
8. Include the general topic/question context (e.g., "When asked about their draft strategy", "Regarding their Week 5 performance")
`;

  const typeSpecificInstructions: Record<string, string> = {
    weekly_recap: `
For the weekly recap:
- Comments are organized BY TEAM NAME with clear section headers (## Team Name:)
- Each team section shows: MANAGER name and TEAM CONTEXT instructions
- CRITICAL RULE: When analyzing a matchup between "Team A vs Team B", ONLY use:
  * Comments from "## Team A:" section when discussing Team A's performance
  * Comments from "## Team B:" section when discussing Team B's performance
- NEVER mix team comments - Team A's quotes should NEVER appear in Team B's analysis
- INTEGRATE comments directly into each team's matchup analysis, not as a separate section
- MANDATORY FORMAT: "[AI analysis of Team A's game] When asked about [SPECIFIC QUESTION/TOPIC], [MANAGER'S FULL NAME] said: '[EXACT QUOTE]' [AI's response to their comment]"
- NEVER use generic phrases like "When asked" - be specific: "When asked about their Week 1 performance", "Regarding their lineup decisions", "About their player's breakout game"
- ALWAYS include the manager's full name, never just "the manager" or anonymous references
- Make the comments feel like a natural conversation between the AI and team managers during game analysis
- Use their quotes to add authenticity to game recaps and decision-making stories
- Reference their emotional reactions (excitement, frustration, regret) to make matchups more engaging
- Provide clear context for what prompted each quote so readers understand the conversation flow
- EXAMPLE CORRECT USAGE: 
  * Matchup: "Team Destroyers (John Smith) vs Team Rivals (Mike Johnson)"
  * When analyzing Team Destroyers: Use comments from "## Team Destroyers:" section only
  * When analyzing Team Rivals: Use comments from "## Team Rivals:" section only
- If no comments exist for a team, analyze their game without quotes - don't use another team's comments as filler
`,
    trade_analysis: `
For trade analysis:
- Include both sides' perspectives on the trade
- Quote their rationale for making the deal
- Use their predictions about impact
- Reference any negotiation details they shared
- Build drama around conflicting opinions
`,
    waiver_wire_report: `
For the waiver wire report:
- Quote members' FAAB strategies
- Include their sleeper picks and reasoning
- Reference their regrets about missed pickups
- Use their insights about league tendencies
- Build recommendations around their experiences
`,
    power_rankings: `
For power rankings:
- Use member quotes to justify ranking changes
- Include their hot takes about team trajectories
- Reference their insights about matchup advantages
- Quote reactions to surprising performances
- Let their opinions add color to the rankings
`,
    draft_rankings: `
For draft rankings:
- INTEGRATE comments directly into each team's breakdown, not as a separate section
- Quote their draft strategy explanations while analyzing their picks
- Include their reactions to specific draft selections (both pride and regret)
- Use their comments to explain reasoning behind controversial picks
- MANDATORY FORMAT: "[AI analysis of pick] When asked about [SPECIFIC QUESTION/TOPIC], [MANAGER'S FULL NAME] said: '[EXACT QUOTE]' [AI's snarky response]"
- NEVER use generic phrases like "When asked" - be specific: "When asked about their early RB strategy", "Regarding their Mahomes pick", "About their bench depth approach"
- ALWAYS include the manager's full name, never just "the manager" or anonymous references
- Make the comments feel like a natural conversation between the AI and team managers
- Use their quotes to add authenticity to draft day stories and decision-making
- Reference their comments when discussing team construction and strategy
- Provide clear context for what prompted each quote so readers understand the conversation flow
`,
  };

  return baseInstructions + (typeSpecificInstructions[contentType] || "");
}

/**
 * Enhances the user prompt with comment context
 */
export function enhancePromptWithComments(
  originalPrompt: string,
  commentContext: CommentIntegrationContext
): string {
  if (commentContext.commentResponses.length === 0) {
    return originalPrompt;
  }

  const commentSection = formatCommentsForPrompt(commentContext);
  const instructions = getCommentIntegrationInstructions(commentContext.contentType);

  return `${originalPrompt}

${instructions}

${commentSection}

Remember: These are real quotes from real league members. Use them to make the article feel authentic and connected to the actual league experience. The best articles will feel like a conversation with the league, not just analysis about it.`;
}

/**
 * Validates that comments were properly integrated into generated content
 */
export function validateCommentIntegration(
  generatedContent: string,
  commentResponses: CommentResponseData[]
): {
  integrated: boolean;
  missingQuotes: string[];
  integrationScore: number;
} {
  if (commentResponses.length === 0) {
    return { integrated: true, missingQuotes: [], integrationScore: 100 };
  }

  const contentLower = generatedContent.toLowerCase();
  const missingQuotes: string[] = [];
  let quotesFound = 0;

  commentResponses.forEach(response => {
    // Check if user name is mentioned
    const userMentioned = response.userName && 
      contentLower.includes(response.userName.toLowerCase());

    // Check if any quotes are included
    const quotesIncluded = response.relevanceMetadata.extractedQuotes?.some(quote => 
      contentLower.includes(quote.toLowerCase().substring(0, 20)) // Check first 20 chars
    );

    if (userMentioned || quotesIncluded) {
      quotesFound++;
    } else {
      missingQuotes.push(response.userName || "Anonymous");
    }
  });

  const integrationScore = (quotesFound / commentResponses.length) * 100;

  return {
    integrated: integrationScore >= 50, // At least half should be integrated
    missingQuotes,
    integrationScore: Math.round(integrationScore),
  };
}

function getResponseTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    opinion: "Member Opinions",
    analysis: "Member Analysis",
    prediction: "Predictions",
    story: "Stories & Anecdotes",
    question: "Questions Raised",
    mixed: "General Comments",
  };
  return labels[type] || "Comments";
}

/**
 * Example of how to extract the most quotable segments from responses
 */
export function extractBestQuotes(
  responses: CommentResponseData[],
  maxQuotes: number = 10
): Array<{
  quote: string;
  author: string;
  teamName: string;
  relevance: number;
}> {
  const allQuotes: Array<{
    quote: string;
    author: string;
    teamName: string;
    relevance: number;
  }> = [];

  responses.forEach(response => {
    const quotes = response.relevanceMetadata.extractedQuotes || [response.processedResponse];
    
    quotes.forEach(quote => {
      allQuotes.push({
        quote: quote.trim(),
        author: response.userName || "Anonymous",
        teamName: response.teamName || "Unknown Team",
        relevance: response.relevanceMetadata.topicRelevance * response.relevanceMetadata.qualityScore / 100,
      });
    });
  });

  // Sort by relevance and return top quotes
  return allQuotes
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, maxQuotes);
}