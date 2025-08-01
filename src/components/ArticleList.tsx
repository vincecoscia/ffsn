"use client";

import Link from "next/link";
import { Button } from "@radix-ui/themes";
import { MarkdownPreview } from "./MarkdownPreview";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { Card, CardContent, CardTitle } from "./ui/card";
import { Badge } from "./ui/badge";
import { Skeleton } from "./ui/skeleton";
import { Calendar, Clock, ArrowRight } from "lucide-react";

interface ArticleListProps {
  leagueId: Id<"leagues">;
  cursor: string | null;
  isCommissioner: boolean;
  onShowContentGenerator: () => void;
}

// Calculate reading time based on word count
// Average reading speed: 200-250 words per minute (using 225 as middle ground)
const calculateReadingTime = (content: string | undefined): number => {
  if (!content) return 1;
  
  // Count words by splitting on whitespace and filtering empty strings
  const wordCount = content.trim().split(/\s+/).filter(word => word.length > 0).length;
  
  // Calculate reading time in minutes (225 words per minute)
  const readingTime = Math.ceil(wordCount / 225);
  
  // Minimum 1 minute read
  return Math.max(1, readingTime);
};

export function ArticleList({ leagueId, cursor, isCommissioner, onShowContentGenerator }: ArticleListProps) {
  // Use useQuery for real-time updates
  const aiContentResult = useQuery(api.aiContent.getByLeague, {
    leagueId,
    paginationOpts: {
      numItems: 3,
      cursor: cursor
    }
  });

  // Extract the page data
  const aiContent = aiContentResult?.page || [];

  // Show loading state if data is still loading
  if (aiContentResult === undefined) {
    return (
      <div className="grid gap-4 sm:gap-6">
        {/* Loading skeletons */}
        {[1, 2, 3].map((i) => (
          <Card key={i} className="group hover:shadow-lg transition-all duration-300 p-0">
            <div className="flex flex-col md:flex-row">
              {/* Image Section Skeleton */}
              <div className="relative w-full md:w-40 flex-shrink-0">
                {/* Mobile: Full width image skeleton on top */}
                <div className="block md:hidden">
                  <Skeleton className="h-48 w-full" />
                </div>
                
                {/* Desktop: Side image skeleton */}
                <div className="hidden md:block p-6 pr-0">
                  <Skeleton className="h-28 w-full rounded-lg" />
                </div>
              </div>
              
              {/* Content Section Skeleton */}
              <div className="flex-1 p-4 md:p-6 space-y-4">
                <div className="flex flex-wrap gap-2 items-center">
                  <Skeleton className="h-4 w-20" />
                  <Skeleton className="h-4 w-16" />
                  <Skeleton className="h-5 w-12" />
                </div>
                <Skeleton className="h-6 w-3/4" />
                <div className="space-y-2">
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-5/6" />
                </div>
                <div className="flex justify-end items-center">
                  <Skeleton className="h-4 w-20" />
                </div>
              </div>
            </div>
          </Card>
        ))}
      </div>
    );
  }

  if (!aiContent || aiContent.length === 0) {
    return (
      <Card className="text-center py-8 sm:py-12 p-0">
        <CardContent className="space-y-4 sm:space-y-6 p-6 sm:p-12">
          <div className="text-muted-foreground mb-4 sm:mb-6">
            <svg className="w-16 h-16 sm:w-20 sm:h-20 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
          </div>
          <div className="space-y-2 sm:space-y-3">
            <h3 className="text-xl sm:text-2xl font-bold text-foreground">No Stories Yet</h3>
            <p className="text-muted-foreground max-w-md mx-auto text-sm sm:text-base">
              Generate AI-powered stories about your league including weekly recaps, trade analysis, and player breakdowns.
            </p>
          </div>
          {isCommissioner && (
            <div className="pt-4">
              <Button
                onClick={onShowContentGenerator}
                color="red"
                size="3"
                className="cursor-pointer"
              >
                Create Your First Story ✨
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="grid gap-4 sm:gap-6">
      {aiContent.map((article) => {
        const publishDate = new Date(article.publishedAt || article.createdAt);
        const isRecent = Date.now() - publishDate.getTime() < 1 * 24 * 60 * 60 * 1000; // Within 1 day
        
        return (
          <Card key={article._id} className="group hover:shadow-lg transition-all duration-300 hover:-translate-y-1 overflow-hidden p-0">
            <Link href={`/articles/${article._id}`} className="block">
              <div className="flex flex-col md:flex-row">
                {/* Image Section */}
                {article.bannerImageUrl && (
                  <div className="relative w-full md:w-40 flex-shrink-0">
                    {/* Mobile: Full width image on top */}
                    <div className="block md:hidden">
                      <div className="relative h-48 w-full overflow-hidden">
                        <img 
                          src={article.bannerImageUrl} 
                          alt={article.title}
                          className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                        />
                        {isRecent && (
                          <Badge className="absolute top-4 right-4 bg-red-500 text-white text-xs">
                            New
                          </Badge>
                        )}
                      </div>
                    </div>
                    
                    {/* Desktop: Side image */}
                    <div className="hidden md:block p-6 pr-0">
                      <div className="relative h-28 w-full overflow-hidden rounded-lg">
                        <img 
                          src={article.bannerImageUrl} 
                          alt={article.title}
                          className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                        />
                      </div>
                    </div>
                  </div>
                )}

                {/* Content Section */}
                <div className="flex-1 p-4 md:p-6">
                  <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground mb-3">
                    <div className="flex items-center gap-1">
                      <Calendar className="w-4 h-4" />
                      <span>
                        {publishDate.toLocaleDateString('en-US', {
                          month: 'short',
                          day: 'numeric',
                          year: 'numeric'
                        })}
                      </span>
                    </div>
                    <div className="flex items-center gap-1">
                      <Clock className="w-4 h-4" />
                      <span>{calculateReadingTime(article.content)} min read</span>
                    </div>
                    {isRecent && !article.bannerImageUrl && (
                      <Badge className="bg-red-500 text-white text-xs">
                        New
                      </Badge>
                    )}
                    {isRecent && article.bannerImageUrl && (
                      <Badge className="md:inline-block hidden bg-red-500 text-white text-xs">
                        New
                      </Badge>
                    )}
                  </div>
                  
                  <CardTitle className="text-xl group-hover:text-red-600 transition-colors duration-200 leading-tight mb-3 line-clamp-2">
                    {article.title}
                  </CardTitle>

                  <div className="text-muted-foreground mb-4 line-clamp-2">
                    <MarkdownPreview 
                      content={article.content} 
                      preview={true} 
                      maxLines={2} 
                    />
                  </div>
                  
                  <div className="flex items-center justify-end">
                    <div className="flex items-center gap-1 text-sm text-red-600 font-medium group-hover:gap-2 transition-all duration-200">
                      <span>Read more</span>
                      <ArrowRight className="w-4 h-4" />
                    </div>
                  </div>
                </div>
              </div>
            </Link>
          </Card>
        );
      })}
    </div>
  );
}