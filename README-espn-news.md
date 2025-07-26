# ESPN News Integration

This document describes the ESPN news fetching and storage functionality added to FFSN.

## Overview

The ESPN news integration fetches NFL news articles from ESPN's public API and stores them in the Convex database for future use.

## Components

### 1. Database Schema (`convex/schema.ts`)
- **espnNews** table stores news articles with:
  - Article metadata (id, headline, description, dates)
  - Links (web, mobile, API)
  - Images array with metadata
  - Categorized data (teams, athletes, leagues)
  - Timestamps for tracking

### 2. API Integration (`convex/espnNews.ts`)
- `fetchESPNNews`: Fetches raw news from ESPN API
- `fetchESPNNewsPaginated`: Provides pagination support
- `syncESPNNews`: Combines fetching and storing in one action
- `scheduledNewsSync`: Internal action for cron jobs

### 3. Database Operations (`convex/news.ts`)
- `storeNewsArticles`: Upserts articles (insert or update)
- `getLatestNews`: Query with pagination and filtering
- `getNewsArticle`: Get single article by ID
- `getNewsByTeam`: Filter news by team ID
- `getNewsByAthlete`: Filter news by athlete ID
- `getNewsStats`: Get statistics about stored news
- `deleteOldArticles`: Cleanup old articles

### 4. Scheduled Sync (`convex/crons.ts`)
- Automatically syncs news every hour
- Fetches up to 100 latest articles
- Cleans up articles older than 30 days

## Usage Examples

### Manual News Sync
```typescript
// In your React component or server action
import { api } from "@/convex/_generated/api";
import { useAction } from "convex/react";

const syncNews = useAction(api.espnNews.syncESPNNews);

// Sync latest 50 NFL news articles
const result = await syncNews({ limit: 50 });
console.log(`Synced ${result.inserted} new articles`);

// Sync news for a specific team (e.g., team ID 14 for Rams)
const ramsNews = await syncNews({ limit: 20, teamId: 14 });
```

### Fetching Stored News
```typescript
import { api } from "@/convex/_generated/api";
import { useQuery } from "convex/react";

// Get latest news with pagination
const newsData = useQuery(api.news.getLatestNews, {
  limit: 10,
  offset: 0,
  onlyNonPremium: true, // Filter out premium content
});

// Get news for a specific team
const teamNews = useQuery(api.news.getNewsByTeam, {
  teamId: 14, // Rams
  limit: 5,
});

// Get news about a specific player
const playerNews = useQuery(api.news.getNewsByAthlete, {
  athleteId: 4430737, // Example: Kyren Williams
  limit: 5,
});
```

### Display News in Component
```typescript
function NewsSection() {
  const news = useQuery(api.news.getLatestNews, { limit: 5 });
  
  if (!news) return <div>Loading news...</div>;
  
  return (
    <div className="space-y-4">
      <h2>Latest NFL News</h2>
      {news.articles.map((article) => (
        <div key={article._id} className="border p-4 rounded">
          <h3 className="font-bold">{article.headline}</h3>
          <p className="text-sm text-gray-600">{article.description}</p>
          <div className="flex gap-2 mt-2">
            {article.categories.teams.map((team) => (
              <span key={team.id} className="text-xs bg-blue-100 px-2 py-1 rounded">
                {team.name}
              </span>
            ))}
          </div>
          <a 
            href={article.links.web} 
            target="_blank" 
            rel="noopener noreferrer"
            className="text-blue-500 text-sm mt-2 inline-block"
          >
            Read more on ESPN →
          </a>
        </div>
      ))}
    </div>
  );
}
```

## Data Structure

### Article Object
```typescript
{
  espnId: "45704274",
  type: "Story",
  headline: "2025 Los Angeles Rams training camp: Latest intel, updates",
  description: "Follow our daily updates from Rams training camp...",
  published: "2025-07-25T21:18:00Z",
  lastModified: "2025-07-25T21:19:00Z",
  byline: "Sarah Barshop",
  premium: false,
  links: {
    web: "https://www.espn.com/nfl/story/_/id/45704274/...",
    mobile: "http://m.espn.go.com/nfl/story?storyId=45704274",
    api: "https://content.core.api.espn.com/v1/sports/news/45704274"
  },
  images: [
    {
      url: "https://example.com/image.jpg",
      alt: "Rams training camp",
      width: 1200,
      height: 675
    }
  ],
  categories: {
    teams: [
      { id: 14, name: "Los Angeles Rams", abbreviation: "LAR" }
    ],
    athletes: [
      { id: 4430737, name: "Kyren Williams", position: "RB" }
    ],
    leagues: [
      { id: 28, name: "NFL", abbreviation: "NFL" }
    ]
  },
  createdAt: 1737820800000,
  updatedAt: 1737820800000
}
```

## Future Integration Ideas

1. **League News Feed**: Display relevant news on league homepage
2. **Team News Widget**: Show team-specific news on team pages
3. **Player News**: Include news in player profiles
4. **AI Summaries**: Use AI to summarize news for weekly recaps
5. **News Notifications**: Alert users about breaking news
6. **Fantasy Insights**: Extract fantasy-relevant information from news

## API Limits & Considerations

- ESPN's API is public but undocumented
- No official rate limits, but we add delays to be respectful
- Scheduled sync runs hourly to keep data fresh
- Old articles are automatically cleaned up after 30 days
- Premium content is marked but full content may not be available

## Testing

To test the integration:

1. Manual sync: Run `syncESPNNews` action from Convex dashboard
2. Check stored articles: Query `getLatestNews` 
3. Verify scheduled sync: Check logs for hourly sync
4. Test filtering: Try team/athlete specific queries