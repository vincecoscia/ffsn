import OpenAI from 'openai';
import type { ContentTemplate } from './content-templates';

interface ImageGenerationParams {
  title: string;
  contentType: string;
  template?: ContentTemplate;
  metadata?: {
    week?: number;
    featuredTeams?: string[];
    featuredPlayers?: string[];
  };
  persona?: string;
}

// Determine image quality based on content type
function getImageQuality(contentType: string): 'low' | 'medium' | 'high' | 'auto' {
  // Use medium quality for all images
  // TODO: Implement quality selection based on contentType
  void contentType; // Suppress unused variable warning
  return 'medium';
}

// Generate a context-aware prompt for the image
function generateImagePrompt(params: ImageGenerationParams): string {
  const { contentType, metadata, persona } = params;
  
  // Base prompt structure for fantasy football theme
  let prompt = "Create a dynamic, professional banner image for a fantasy football article. ";
  prompt += "Style: Modern sports graphics with bold colors, dramatic lighting. ";
  prompt += "No text or words in the image. ";
  prompt += "No NFL logos or team logos. ";
  
  // Add content-specific elements
  switch (contentType) {
    case 'weekly_recap':
      prompt += "Show an epic football stadium at night with bright lights, ";
      prompt += "dramatic action shots of players in motion, scoreboard displays. ";
      if (metadata?.week) {
        prompt += `Emphasize Week ${metadata.week} energy. `;
      }
      break;
      
    case 'weekly_preview':
      prompt += "Show a pre-game atmosphere with anticipation, ";
      prompt += "players in formation, stadium filling with fans, dramatic sky. ";
      if (metadata?.week) {
        prompt += `Build excitement for Week ${metadata.week}. `;
      }
      break;
      
    case 'power_rankings':
      prompt += "Show a podium or ranking visualization, ";
      prompt += "multiple team helmets arranged hierarchically, ";
      prompt += "dramatic lighting emphasizing competition and hierarchy. ";
      break;
      
    case 'championship_preview':
      prompt += "Show an epic championship atmosphere, ";
      prompt += "golden trophy prominently displayed, ";
      prompt += "two teams facing off, confetti, dramatic lighting. ";
      break;
      
    case 'season_finale':
      prompt += "Show a celebratory end-of-season scene, ";
      prompt += "trophy presentation, fireworks, champions celebrating. ";
      break;
      
    case 'season_welcome':
      prompt += "Show an exciting season kickoff scene, ";
      prompt += "fresh field, sunrise over stadium, ";
      prompt += "sense of new beginnings and possibilities. ";
      break;
      
    case 'trade_analysis':
      prompt += "Show a dynamic trading floor or negotiation scene, ";
      prompt += "player silhouettes being exchanged, ";
      prompt += "arrows indicating movement, business-like atmosphere. ";
      break;
      
    case 'injury_report':
      prompt += "Show a medical/recovery theme, ";
      prompt += "training room atmosphere, athletic tape, ";
      prompt += "recovery and rehabilitation focus. ";
      break;
      
    default:
      prompt += "Show general fantasy football excitement, ";
      prompt += "mix of players, strategy elements, and competition. ";
  }
  
  // Add featured teams if specified and they look like actual team names (not IDs)
  if (metadata?.featuredTeams && metadata.featuredTeams.length > 0) {
    const teams = metadata.featuredTeams.slice(0, 2);
    // Only add team names if they don't look like random IDs
    const hasRealTeamNames = teams.every(team => !team.match(/^[a-z0-9]{20,}$/));
    if (hasRealTeamNames) {
      prompt += `Feature elements suggesting ${teams.join(' vs ')}. `;
    }
  }
  
  // Add persona flavor if applicable
  if (persona) {
    switch (persona) {
      case 'mel-diaper':
        prompt += "Angry, dramatic visuals with explosive energy, dark storm clouds, intense contrast. ";
        break;
      case 'stan-deviation':
        prompt += "Include data visualization elements, charts, graphs, analytics overlay, technical feel. ";
        break;
      case 'vinny-marinara':
        prompt += "Mysterious, noir atmosphere, shadows and secrets, Italian restaurant aesthetic. ";
        break;
      case 'chad-thunderhype':
        prompt += "Ultra high energy, explosions, lightning, maximum intensity, gym and protein shake vibes. ";
        break;
      case 'rick-two-beers':
        prompt += "Slightly blurry, sports bar atmosphere, vintage 80s elements, nostalgic feel. ";
        break;
    }
  }
  
  // Technical specifications
  prompt += "Aspect ratio 16:9 for banner format. ";
  prompt += "High contrast, vibrant colors, professional sports photography style.";
  
  return prompt;
}

export async function generateArticleImage(
  params: ImageGenerationParams,
  apiKey: string
): Promise<Blob> {
  const client = new OpenAI({ apiKey });
  
  const prompt = generateImagePrompt(params);
  const quality = getImageQuality(params.contentType);
  
  console.log('Generating image with prompt:', prompt);
  console.log('Quality setting:', quality);
  
  try {
    const response = await client.images.generate({
      model: "gpt-image-1",
      prompt,
      n: 1,
      size: "1536x1024", // Wide aspect ratio for banner
      quality
    });
    
    console.log('OpenAI image generation response received');
    console.log('Response structure:', JSON.stringify(response, null, 2));
    
    // Check for both URL and base64 formats
    const imageData = response.data?.[0];
    if (!imageData) {
      throw new Error('No image data returned from OpenAI');
    }
    
    let imageBlob: Blob;
    
    if (imageData.b64_json) {
      // Handle base64 response
      console.log('Processing base64 image data');
      // Convert base64 to binary without using Buffer (not available in Convex runtime)
      const binaryString = atob(imageData.b64_json);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      imageBlob = new Blob([bytes], { type: 'image/png' });
    } else if (imageData.url) {
      // Handle URL response
      console.log('Processing image URL:', imageData.url);
      const imageResponse = await fetch(imageData.url);
      if (!imageResponse.ok) {
        throw new Error(`Failed to fetch generated image: ${imageResponse.statusText}`);
      }
      imageBlob = await imageResponse.blob();
    } else {
      throw new Error('No recognized image format in OpenAI response');
    }
    
    console.log('Image generated successfully, size:', imageBlob.size);
    
    return imageBlob;
  } catch (error) {
    console.error('Image generation failed:', error);
    throw error;
  }
}

// Determine if an article type should have an image
export function shouldGenerateImage(contentType: string): boolean {
  const imageEnabledTypes = [
    // 'weekly_recap',
    // 'weekly_preview',
    // 'power_rankings',
    'championship_preview',
    'playoff_preview',
    'season_finale',
    'season_welcome',
    'trade_deadline',
    'midseason_awards'
  ];
  
  return imageEnabledTypes.includes(contentType);
}