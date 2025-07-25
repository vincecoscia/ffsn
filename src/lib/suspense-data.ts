// Data fetching utility that works with React Suspense
// Based on React 19 patterns from the official documentation

import { ConvexReactClient } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";

// Simple in-memory cache for our data fetching
const cache = new Map<string, Promise<unknown>>();

export interface PaginationOpts {
  numItems: number;
  cursor: string | null;
}

// Create a function that returns a Promise for use with React's `use()` hook
export function fetchArticles(
  convex: ConvexReactClient,
  leagueId: Id<"leagues">,
  paginationOpts: PaginationOpts
): Promise<unknown> {
  // Create a unique cache key based on the query parameters
  const cacheKey = `articles:${leagueId}:${paginationOpts.cursor}:${paginationOpts.numItems}`;
  
  if (!cache.has(cacheKey)) {
    // Create the promise and cache it
    const promise = convex.query(api.aiContent.getByLeague, {
      leagueId,
      paginationOpts
    });
    
    cache.set(cacheKey, promise);
  }
  
  return cache.get(cacheKey)!;
}

// Clear cache function for when data changes (e.g., new articles created)
export function clearArticlesCache(leagueId?: Id<"leagues">) {
  if (leagueId) {
    // Clear only cache entries for this league
    for (const key of cache.keys()) {
      if (key.startsWith(`articles:${leagueId}:`)) {
        cache.delete(key);
      }
    }
  } else {
    // Clear all cache
    cache.clear();
  }
}