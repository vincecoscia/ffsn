import Anthropic from '@anthropic-ai/sdk';
import { generatePrompt, PromptBuilderOptions, LeagueDataContext } from './prompt-builder';
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

      const { systemPrompt, userPrompt, settings } = await generatePrompt(promptOptions);

      // Call Claude API
      const response = await this.callClaude(anthropic, systemPrompt, userPrompt, settings);

      // Parse the response
      const parsed = this.parseGeneratedContent(response.content[0].text);

      // Extract metadata
      const metadata = {
        week: request.leagueData.currentWeek,
        featuredTeams: this.extractFeaturedTeams(parsed.content, request.leagueData.teams),
        featuredPlayers: this.extractFeaturedPlayers(parsed.content),
        tags: this.generateTags(request.contentType, request.persona),
        creditsUsed: contentTemplates[request.contentType].creditCost,
        generationTime: Date.now() - startTime,
        modelUsed: this.modelConfig.primary,
        promptTokens: response.usage?.input_tokens || 0,
        completionTokens: response.usage?.output_tokens || 0,
      };

      return {
        ...parsed,
        metadata,
      };
    } catch (error) {
      console.error('Content generation failed:', error);
      throw new Error('Failed to generate content. Please try again.');
    }
  }

  private async callClaude(
    anthropic: Anthropic,
    systemPrompt: string,
    userPrompt: string,
    settings: any
  ): Promise<any> {
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

      return response;
    } catch (error: any) {
      // If primary model fails, try fallback
      if (error.status === 404 || error.status === 500) {
        console.warn('Primary model failed, trying fallback...');
        
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

        return response;
      }
      
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

  private extractFeaturedTeams(content: string, teams: any[]): string[] {
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