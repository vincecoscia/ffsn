import Anthropic from '@anthropic-ai/sdk';
import { generatePrompt, PromptBuilderOptions, LeagueDataContext } from './prompt-builder';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

interface AnthropicSettings {
  maxTokens: number;
  temperature: number;
}

interface AnthropicResponse {
  content: Array<{ text: string }>;
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
}
import { contentTemplates } from './content-templates';
import { Id } from '../../../convex/_generated/dataModel';

export interface GenerationRequest {
  leagueId: Id<"leagues">;
  contentType: string;
  persona: string;
  leagueData: LeagueDataContext;
  customContext?: string;
  userId: string;
}

// Zod schema for structured article output
const ArticleSection = z.object({
  name: z.string().describe("The section heading/title as it should appear in the article (e.g., 'ROUND 1-2 PREDICTIONS' not 'rounds_1_2_by_team')"),
  content: z.string().describe("The section content written in the persona's style"),
  wordCount: z.number().describe("Number of words in the content"),
});

const GeneratedArticle = z.object({
  title: z.string().describe("Compelling article title that captures the essence of the content"),
  summary: z.string().describe("Brief 2-3 sentence summary of the article"),
  sections: z.array(ArticleSection).describe("Article sections as defined in the template"),
  featuredTeams: z.array(z.object({
    teamId: z.string(),
    teamName: z.string(),
    mentions: z.number().describe("Number of times team is mentioned"),
  })).describe("Teams prominently featured in the article"),
  featuredPlayers: z.array(z.object({
    playerName: z.string(),
    position: z.string(),
    team: z.string(),
    mentions: z.number(),
  })).describe("Players prominently featured in the article"),
  keyStats: z.array(z.object({
    stat: z.string(),
    value: z.string(),
    context: z.string(),
  })).optional().describe("Key statistics mentioned in the article"),
  tone: z.enum(["humorous", "analytical", "dramatic", "casual", "professional"]).describe("Overall tone of the article"),
});

export interface GeneratedContent {
  title: string;
  content: string;
  summary: string;
  metadata: {
    week?: number;
    featuredTeams: string[];
    featuredPlayers: string[];
    tags: string[];
    creditsUsed: number;
    generationTime: number;
    modelUsed: string;
    promptTokens: number;
    completionTokens: number;
  };
}

export class ContentGenerationService {
  private modelConfig = {
    primary: "claude-sonnet-4-20250514",
    fallback: "claude-3-7-sonnet-20250219",
    maxRetries: 3,
  };

  async generateContent(request: GenerationRequest, apiKey: string): Promise<GeneratedContent> {
    console.log("=== ContentGenerationService.generateContent START ===");
    console.log("Request:", {
      contentType: request.contentType,
      persona: request.persona,
      hasCustomContext: !!request.customContext,
      leagueDataKeys: Object.keys(request.leagueData),
    });
    
    // Initialize Anthropic client with provided API key
    const anthropic = new Anthropic({
      apiKey: apiKey,
    });
    const startTime = Date.now();
    
    try {
      // Build prompts using our prompt builder
      const promptOptions: PromptBuilderOptions = {
        leagueId: request.leagueId,
        contentType: request.contentType,
        persona: request.persona,
        leagueData: request.leagueData,
        customContext: request.customContext,
        includeExamples: true,
      };

      console.log("Building prompts...");
      const { systemPrompt, userPrompt, settings } = await generatePrompt(promptOptions);
      
      console.log("Prompt built successfully");
      console.log("System prompt preview:", systemPrompt.substring(0, 200) + "...");
      console.log("User prompt preview:", userPrompt.substring(0, 200) + "...");

      // Determine if we should use structured output (for supported models)
      const useStructuredOutput = this.modelConfig.primary.includes('claude-3') || 
                                  this.modelConfig.primary.includes('claude-sonnet-4');

      let response: AnthropicResponse;
      let structuredData: z.infer<typeof GeneratedArticle> | null = null;

      if (useStructuredOutput) {
        console.log("Using structured output with Zod schema...");
        try {
          // Call Claude API with structured output
          const structuredResponse = await this.callClaudeStructured(anthropic, systemPrompt, userPrompt, settings);
          structuredData = structuredResponse.structuredData;
          response = structuredResponse.response;
        } catch (structuredError) {
          console.warn("Structured output failed, falling back to regular mode:", structuredError);
          // Fallback to regular generation
          response = await this.callClaude(anthropic, systemPrompt, userPrompt, settings);
        }
      } else {
        // Call Claude API without structured output
        console.log("Using standard text generation...");
        response = await this.callClaude(anthropic, systemPrompt, userPrompt, settings);
      }
      
      console.log("Claude response received");
      console.log("Response usage:", {
        inputTokens: response.usage?.input_tokens,
        outputTokens: response.usage?.output_tokens,
      });

      let title: string;
      let content: string;
      let summary: string;
      let featuredTeams: string[];
      let featuredPlayers: string[];

      if (structuredData) {
        console.log("Processing structured data...");
        
        // Build content from structured sections
        title = structuredData.title;
        summary = structuredData.summary;
        
        // Combine sections into markdown content
        content = `# ${title}\n\n`;
        structuredData.sections.forEach(section => {
          content += `## ${section.name}\n\n${section.content}\n\n`;
        });

        // Extract featured teams and players
        // Map external team IDs from AI to internal Convex IDs
        featuredTeams = structuredData.featuredTeams
          .sort((a, b) => b.mentions - a.mentions)
          .slice(0, 5)
          .map(t => {
            // Find the team by external ID to get the internal ID
            const team = request.leagueData.teams.find(team => 
              team.externalId === t.teamId || team.externalId === String(t.teamId)
            );
            return team?.id || t.teamId; // Use internal ID if found, otherwise fallback
          })
          .filter(id => id && id.startsWith('j')); // Filter out any invalid IDs (Convex IDs start with 'j')
          
        featuredPlayers = structuredData.featuredPlayers
          .sort((a, b) => b.mentions - a.mentions)
          .slice(0, 10)
          .map(p => p.playerName);

        console.log("Structured content processed:", {
          sectionsCount: structuredData.sections.length,
          totalWordCount: structuredData.sections.reduce((sum, s) => sum + s.wordCount, 0),
          tone: structuredData.tone,
          keyStatsCount: structuredData.keyStats?.length || 0,
        });
      } else {
        // Parse the response using existing method
        const parsed = this.parseGeneratedContent(response.content[0].text);
        title = parsed.title;
        content = parsed.content;
        summary = parsed.summary;
        
        // Extract metadata using existing methods
        featuredTeams = this.extractFeaturedTeams(content, request.leagueData.teams);
        featuredPlayers = this.extractFeaturedPlayers(content);
      }

      // Build metadata
      const metadata = {
        week: request.leagueData.currentWeek,
        featuredTeams,
        featuredPlayers,
        tags: this.generateTags(request.contentType, request.persona),
        creditsUsed: contentTemplates[request.contentType].creditCost,
        generationTime: Date.now() - startTime,
        modelUsed: this.modelConfig.primary,
        promptTokens: response.usage?.input_tokens || 0,
        completionTokens: response.usage?.output_tokens || 0,
      };
      
      console.log("Metadata built:", {
        featuredTeams: metadata.featuredTeams.length,
        featuredPlayers: metadata.featuredPlayers.length,
        tags: metadata.tags.length,
        generationTimeMs: metadata.generationTime,
      });

      console.log("=== ContentGenerationService.generateContent SUCCESS ===");
      
      return {
        title,
        content,
        summary,
        metadata,
      };
    } catch (error) {
      console.error("=== ContentGenerationService.generateContent ERROR ===");
      console.error('Content generation failed:', error);
      console.error('Error details:', {
        message: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
      });
      throw new Error('Failed to generate content. Please try again.');
    }
  }

  private async callClaudeStructured(
    anthropic: Anthropic,
    systemPrompt: string,
    userPrompt: string,
    settings: AnthropicSettings
  ): Promise<{ structuredData: z.infer<typeof GeneratedArticle>; response: AnthropicResponse }> {
    console.log("=== callClaudeStructured START ===");
    
    // Add structured output instructions to the prompt
    const structuredUserPrompt = `${userPrompt}

IMPORTANT: Generate your response as a structured JSON object that matches the following schema:
- title: A compelling article title
- summary: A 2-3 sentence summary
- sections: An array of sections, each with:
  * name: A PROPER SECTION TITLE (e.g., "ROUND 1-2 PREDICTIONS - BRACE YOURSELVES FOR STUPIDITY!"), NOT template field names
  * content: The section content in your persona's style
  * wordCount: The number of words in the content
- featuredTeams: Teams mentioned with teamId, teamName, and mention count
- featuredPlayers: Players mentioned with name, position, team, and mention count
- keyStats: Optional array of important statistics with stat name, value, and context
- tone: The overall tone (humorous, analytical, dramatic, casual, or professional)

CRITICAL: The "name" field for each section should be a proper article section heading that readers will see, written in your persona's style. Do NOT use template field names like "rounds_1_2_by_team" - instead create engaging titles like "ROUND 1-2 PREDICTIONS - BRACE YOURSELVES FOR STUPIDITY!" or whatever fits your persona and the section content.

Make sure each section follows the template requirements and word counts.`;

    try {
      // Use tool calling for structured output
      const response = await anthropic.messages.create({
        model: this.modelConfig.primary,
        max_tokens: settings.maxTokens || 4000,
        temperature: settings.temperature || 0.8,
        system: systemPrompt,
        messages: [
          {
            role: 'user',
            content: structuredUserPrompt,
          },
        ],
        tools: [{
          name: "generate_article",
          description: "Generate a structured fantasy football article",
          input_schema: zodToJsonSchema(GeneratedArticle) as any, // eslint-disable-line @typescript-eslint/no-explicit-any
        }],
        tool_choice: { type: "tool", name: "generate_article" },
      });

      console.log("Structured API call successful");

      // Extract the structured data from the tool use
      const toolUse = response.content.find((c: any) => c.type === 'tool_use'); // eslint-disable-line @typescript-eslint/no-explicit-any
      if (!toolUse || toolUse.type !== 'tool_use') {
        throw new Error('No structured output received');
      }

      const structuredData = GeneratedArticle.parse(toolUse.input);
      
      // Transform to match our interface
      const transformedResponse: AnthropicResponse = {
        content: [{ text: JSON.stringify(structuredData) }],
        usage: response.usage ? {
          input_tokens: response.usage.input_tokens,
          output_tokens: response.usage.output_tokens,
        } : undefined,
      };

      return { structuredData, response: transformedResponse };
    } catch (error) {
      console.error("Structured output generation failed:", error);
      throw error;
    }
  }

  private async callClaude(
    anthropic: Anthropic,
    systemPrompt: string,
    userPrompt: string,
    settings: AnthropicSettings
  ): Promise<AnthropicResponse> {
    console.log("=== callClaude START ===");
    console.log("Model:", this.modelConfig.primary);
    console.log("Settings:", {
      maxTokens: settings.maxTokens || 4000,
      temperature: settings.temperature || 0.8,
    });
    
    // Log full prompts for debugging (be careful with this in production)
    console.log("=== FULL SYSTEM PROMPT ===");
    console.log(systemPrompt);
    console.log("=== FULL USER PROMPT ===");
    console.log(userPrompt);
    console.log("=== END PROMPTS ===");
    
    try {
      const response = await anthropic.messages.create({
        model: this.modelConfig.primary,
        max_tokens: settings.maxTokens || 4000,
        temperature: settings.temperature || 0.8,
        system: systemPrompt,
        messages: [
          {
            role: 'user',
            content: userPrompt,
          },
        ],
      });
      
      console.log("Claude API call successful");
      
      // Transform the response to match our interface
      const transformedResponse: AnthropicResponse = {
        content: response.content
          .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
          .map(block => ({ text: block.text })),
        usage: response.usage ? {
          input_tokens: response.usage.input_tokens,
          output_tokens: response.usage.output_tokens,
        } : undefined,
      };
      
      return transformedResponse;
    } catch (error: unknown) {
      // If primary model fails, try fallback
      if (error && typeof error === 'object' && 'status' in error && 
          (error.status === 404 || error.status === 500)) {
        console.warn('Primary model failed, trying fallback...');
        console.warn('Error:', error && typeof error === 'object' && 'message' in error ? error.message : 'Unknown error');
        
        const response = await anthropic.messages.create({
          model: this.modelConfig.fallback,
          max_tokens: Math.min(settings.maxTokens || 4000, 8192), // Fallback has lower limit
          temperature: settings.temperature || 0.8,
          system: systemPrompt,
          messages: [
            {
              role: 'user',
              content: userPrompt,
            },
          ],
        });

        console.log("Fallback model call successful");
        
        // Transform the fallback response to match our interface
        const transformedFallbackResponse: AnthropicResponse = {
          content: response.content
            .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
            .map(block => ({ text: block.text })),
          usage: response.usage ? {
            input_tokens: response.usage.input_tokens,
            output_tokens: response.usage.output_tokens,
          } : undefined,
        };
        
        return transformedFallbackResponse;
      }
      
      console.error("Claude API call failed:", error);
      throw error;
    }
  }

  private parseGeneratedContent(rawContent: string): { title: string; content: string; summary: string } {
    // Claude should return markdown with title as H1
    const lines = rawContent.trim().split('\n');
    let title = '';
    let content = '';
    let summary = '';

    // Extract title (first H1)
    const titleMatch = rawContent.match(/^#\s+(.+)$/m);
    if (titleMatch) {
      title = titleMatch[1];
      // Remove title from content
      content = rawContent.replace(titleMatch[0], '').trim();
    } else {
      // Fallback: use first line as title
      title = lines[0].replace(/^#+\s*/, '');
      content = lines.slice(1).join('\n').trim();
    }

    // Generate summary (first paragraph or first 200 chars)
    const firstParagraph = content.split('\n\n')[0];
    summary = firstParagraph.length > 200 
      ? firstParagraph.substring(0, 197) + '...'
      : firstParagraph;

    return { title, content, summary };
  }

  private extractFeaturedTeams(content: string, teams: Array<{ name: string; id: string }>): string[] {
    const featured: string[] = [];
    const contentLower = content.toLowerCase();

    teams.forEach(team => {
      if (contentLower.includes(team.name.toLowerCase())) {
        featured.push(team.id);
      }
    });

    // Return top 5 most mentioned teams
    return featured.slice(0, 5);
  }

  private extractFeaturedPlayers(content: string): string[] {
    // Simple regex to find player names (capitalized words)
    const playerPattern = /\b[A-Z][a-z]+\s+[A-Z][a-z]+\b/g;
    const matches = content.match(playerPattern) || [];
    
    // Deduplicate and return top 10
    const unique = [...new Set(matches)];
    return unique.slice(0, 10);
  }

  private generateTags(contentType: string, persona: string): string[] {
    const tags = [contentType, persona];
    
    // Add content-specific tags
    const contentTypeTags: Record<string, string[]> = {
      weekly_recap: ['recap', 'weekly', 'matchups'],
      power_rankings: ['rankings', 'power', 'standings'],
      trade_analysis: ['trade', 'analysis', 'transaction'],
      waiver_wire_report: ['waiver', 'pickups', 'free-agents'],
      mock_draft: ['draft', 'mock', 'preseason'],
      rivalry_week_special: ['rivalry', 'matchup', 'hype'],
      championship_manifesto: ['championship', 'finals', 'playoffs'],
    };

    if (contentTypeTags[contentType]) {
      tags.push(...contentTypeTags[contentType]);
    }

    return tags;
  }

  // Validate content for quality and appropriateness
  async validateContent(content: GeneratedContent): Promise<{
    valid: boolean;
    issues: string[];
  }> {
    const issues: string[] = [];

    // Check minimum length
    const wordCount = content.content.split(/\s+/).length;
    const expectedWords = contentTemplates[content.metadata.tags[0]]?.estimatedWords || 1000;
    
    if (wordCount < expectedWords * 0.7) {
      issues.push(`Content too short: ${wordCount} words (expected ~${expectedWords})`);
    }

    // Check for placeholder text
    const placeholders = ['[INSERT', '[TODO', 'PLACEHOLDER', '{INSERT'];
    placeholders.forEach(placeholder => {
      if (content.content.includes(placeholder)) {
        issues.push(`Contains placeholder text: ${placeholder}`);
      }
    });

    // Check title exists
    if (!content.title || content.title.length < 5) {
      issues.push('Invalid or missing title');
    }

    // Basic profanity check (expand this list as needed)
    const profanityList = ['damn', 'hell']; // Keep it light for fantasy football
    const contentLower = content.content.toLowerCase();
    profanityList.forEach(word => {
      if (contentLower.includes(word)) {
        issues.push(`Contains potentially inappropriate language: ${word}`);
      }
    });

    return {
      valid: issues.length === 0,
      issues,
    };
  }
}

// Singleton instance
export const contentGenerationService = new ContentGenerationService();

// Helper function for generating content in Convex actions
export async function generateAIContent(request: GenerationRequest, apiKey: string): Promise<GeneratedContent> {
  return contentGenerationService.generateContent(request, apiKey);
}