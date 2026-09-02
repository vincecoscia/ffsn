"use client";

import Link from "next/link";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import {
  Panel,
  Chip,
  BannerPlaceholder,
  PersonaAvatar,
  EmptyState,
  contentTypeLabel,
  personaName,
} from "@/components/broadcast";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Skeleton } from "./ui/skeleton";
import { cn } from "@/lib/utils";
import { FileText, ChevronRight } from "lucide-react";

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

// aiContent.persona is stored as a slug (e.g. "mel-diaper"); `personaName`
// resolves it through getPersonaDisplay so retired writers on archived stories
// still get their real byline instead of a de-slugged guess.

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
      <Panel className="flex flex-col">
        {[1, 2, 3].map((i) => (
          <div
            key={i}
            className={cn(
              "grid grid-cols-[72px_1fr] gap-4 p-4 sm:grid-cols-[88px_1fr_auto] sm:gap-5 sm:p-5",
              i > 1 && "border-t border-bc-hairline"
            )}
          >
            <Skeleton className="size-[72px] sm:size-[88px]" />
            <div className="flex flex-col justify-center gap-3">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-5 w-3/4" />
              <Skeleton className="h-4 w-1/2" />
            </div>
          </div>
        ))}
      </Panel>
    );
  }

  if (!aiContent || aiContent.length === 0) {
    return (
      <EmptyState
        icon={<FileText className="size-6" strokeWidth={1.8} />}
        title="No stories yet"
        description="Generate AI-powered stories about your league including weekly recaps, trade analysis, and player breakdowns."
        action={
          isCommissioner ? (
            <Button onClick={onShowContentGenerator}>Generate a story</Button>
          ) : undefined
        }
      />
    );
  }

  return (
    <Panel className="flex flex-col">
      {aiContent.map((article, index) => {
        const publishDate = new Date(article.publishedAt || article.createdAt);
        const isRecent = Date.now() - publishDate.getTime() < 1 * 24 * 60 * 60 * 1000; // Within 1 day

        return (
          <Link
            key={article._id}
            href={`/articles/${article._id}`}
            className={cn(
              "grid grid-cols-[72px_1fr] items-center gap-4 p-4 transition-colors hover:bg-bc-panel-2 sm:grid-cols-[88px_1fr_auto] sm:gap-5 sm:p-5",
              index > 0 && "border-t border-bc-hairline"
            )}
          >
            <div className="relative size-[72px] flex-none overflow-hidden border border-bc-hairline bg-bc-panel-2 sm:size-[88px]">
              {article.bannerImageUrl ? (
                <img
                  src={article.bannerImageUrl}
                  alt=""
                  className="h-full w-full object-cover"
                />
              ) : (
                <>
                  <BannerPlaceholder gradientId={article._id} />
                  <div className="absolute inset-0 flex items-center justify-center">
                    <PersonaAvatar persona={article.persona} size={40} />
                  </div>
                </>
              )}
            </div>

            <div className="flex min-w-0 flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2.5">
                {isRecent && <Chip live>New</Chip>}
                <Badge variant="secondary">{contentTypeLabel(article.type)}</Badge>
              </div>

              <span className="line-clamp-2 font-display text-[20px] leading-tight font-bold text-bc-ink uppercase sm:text-[22px]">
                {article.title}
              </span>

              <span className="truncate text-[14px] text-bc-text-2">
                {personaName(article.persona)}
                <span className="mx-2 text-bc-text-3">&middot;</span>
                {publishDate.toLocaleDateString('en-US', {
                  month: 'short',
                  day: 'numeric',
                  year: 'numeric'
                })}
                <span className="mx-2 text-bc-text-3">&middot;</span>
                {calculateReadingTime(article.content)} min read
              </span>
            </div>

            <ChevronRight className="hidden size-5 flex-none text-bc-text-3 sm:block" strokeWidth={2} />
          </Link>
        );
      })}
    </Panel>
  );
}
