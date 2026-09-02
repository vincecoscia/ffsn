"use client";

import { useQuery, useConvexAuth } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import { Id } from "../../../../convex/_generated/dataModel";
import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, ArrowRight } from "lucide-react";
import {
  TopBar,
  ThemeToggle,
  Panel,
  LowerThird,
  PersonaAvatar,
  BannerPlaceholder,
  LoadingScreen,
} from "@/components/broadcast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { MarkdownPreview } from "@/components/MarkdownPreview";
import { EngagementBar } from "./EngagementBar";
import { LockerRoom } from "./LockerRoom";

interface ArticleClientProps {
  articleId: string;
}

// The five FFSN on-air personas and their broadcast roles. Any other byline
// (e.g. a commissioner-edited article) falls back to a generic credit.
const PERSONA_ROLES: { test: RegExp; role: string }[] = [
  { test: /mel/i, role: "The Draft Disaster" },
  { test: /stan/i, role: "The Analytics Overlord" },
  { test: /vinny/i, role: "Trade Rumor Mogul" },
  { test: /chad/i, role: "The Glaze God" },
  { test: /rick/i, role: "The Drunk Uncle" },
];

function personaRole(persona: string): string {
  return PERSONA_ROLES.find(({ test }) => test.test(persona))?.role ?? "FFSN correspondent";
}

const WORDS_PER_MINUTE = 225;

function estimateReadMinutes(content: string): number {
  const words = content
    .replace(/[#*_`>]/g, " ")
    .split(/\s+/)
    .filter(Boolean).length;
  return Math.max(1, Math.round(words / WORDS_PER_MINUTE));
}

function formatStoryType(type: string): string {
  return type.replace(/_/g, " ");
}

export function ArticleClient({ articleId }: ArticleClientProps) {
  const { isLoading: isAuthLoading, isAuthenticated } = useConvexAuth();

  // Get the article
  const article = useQuery(api.aiContent.getById, {
    articleId: articleId as Id<"aiContent">
  });

  // Get the league information using different queries based on auth status
  const publicLeague = useQuery(
    api.leagues.getPublicInfo,
    article && !isAuthenticated ? { id: article.leagueId } : "skip"
  );

  const authenticatedLeague = useQuery(
    api.leagues.getById,
    article && isAuthenticated ? { id: article.leagueId } : "skip"
  );

  const league = isAuthenticated ? authenticatedLeague : publicLeague;

  // Loading state
  if (isAuthLoading || article === undefined || (article && league === undefined)) {
    return (
      <div className="min-h-screen bg-bc-ground">
        <LoadingScreen message="Loading article" />
      </div>
    );
  }

  // Not found state
  if (!article || !league) {
    notFound();
  }

  const publishedDate = new Date(article.publishedAt || article.createdAt).toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });

  // Short plain-text summary for the native share sheet (navigator.share text).
  const articleSummary = article.content
    .replace(/[#*_`]/g, '')
    .replace(/\n/g, ' ')
    .trim()
    .substring(0, 160);

  const isMember = isAuthenticated && !!authenticatedLeague;
  const storyType = formatStoryType(article.type);
  const readMinutes = estimateReadMinutes(article.content);
  const week = article.metadata.week;

  const leagueMeta =
    isAuthenticated && authenticatedLeague
      ? [
          authenticatedLeague.espnData ? `${authenticatedLeague.espnData.size} teams` : null,
          authenticatedLeague.settings.scoringType,
          authenticatedLeague.platform.toUpperCase(),
        ]
          .filter((item): item is string => Boolean(item))
          .join(" · ")
      : undefined;

  const metaItems = [
    typeof week === "number" ? `Week ${week}` : null,
    publishedDate,
    `${readMinutes} min read`,
  ].filter((item): item is string => Boolean(item));

  const bodyContent = (() => {
    const lines = article.content.split('\n');
    // Skip the first line if it's a markdown header (starts with #)
    if (lines.length > 0 && lines[0].trim().startsWith('#')) {
      return lines.slice(1).join('\n').trim();
    }
    return article.content;
  })();

  return (
    <div className="min-h-screen bg-bc-ground">
      <TopBar title={league.name} subtitle={leagueMeta} logoSize="md">
        {isMember && (
          <>
            <Button asChild variant="outline" size="sm" className="hidden sm:inline-flex">
              <Link href={`/leagues/${league._id}`}>
                <ArrowLeft className="size-4" strokeWidth={2} />
                Back to league
              </Link>
            </Button>
            <Button
              asChild
              variant="outline"
              size="icon-sm"
              className="sm:hidden"
              aria-label="Back to league"
            >
              <Link href={`/leagues/${league._id}`}>
                <ArrowLeft className="size-4" strokeWidth={2} />
              </Link>
            </Button>
          </>
        )}
        <ThemeToggle />
      </TopBar>

      {/* Banner */}
      <div className="relative h-[220px] w-full overflow-hidden border-b border-bc-hairline bg-bc-panel sm:h-[320px] lg:h-[480px]">
        {article.bannerImageUrl ? (
          <>
            <img
              src={article.bannerImageUrl}
              alt={article.title}
              className="absolute inset-0 h-full w-full object-cover"
            />
            <div className="absolute inset-0 bg-gradient-to-t from-bc-ground via-bc-ground/10 to-transparent" />
          </>
        ) : (
          <BannerPlaceholder text={typeof week === "number" ? `WK ${week}` : undefined} />
        )}
      </div>

      {/* Title block */}
      <div className="flex flex-col items-center px-4 pt-10 sm:px-6 lg:px-12">
        <div className="flex w-full max-w-[880px] flex-col gap-6">
          <div className="flex flex-wrap items-center gap-3">
            <Badge>{storyType}</Badge>
            {metaItems.map((item) => (
              <span key={item} className="flex items-center gap-3">
                <span className="bc-sep bc-sep-muted" aria-hidden="true" />
                <span className="bc-label text-bc-text-2">{item}</span>
              </span>
            ))}
          </div>

          <h1 className="bc-display text-bc-ink text-[32px] sm:text-[42px] lg:text-[52px] xl:text-[56px]">
            {article.title}
          </h1>

          <LowerThird
            className="bc-shadow self-start"
            name={article.persona}
            role={personaRole(article.persona)}
            avatar={<PersonaAvatar persona={article.persona} size={56} variant="bust" />}
            tag={storyType}
          />
        </div>
      </div>

      {/* Body */}
      <div className="flex flex-col items-center gap-8 px-4 py-10 sm:px-6 lg:px-12">
        <Panel
          lifted
          cut="tr"
          className="w-full max-w-[880px] px-6 py-10 sm:px-14 sm:py-14 lg:px-24"
        >
          <div className="bc-prose">
            <MarkdownPreview content={bodyContent} />
          </div>
        </Panel>

        <div className="w-full max-w-[880px]">
          <EngagementBar articleId={articleId} title={article.title} summary={articleSummary} />
        </div>

        <div className="w-full max-w-[880px]">
          <LockerRoom articleId={articleId} />
        </div>

        <div className="flex w-full max-w-[880px] flex-col gap-4 border-t-2 border-bc-hairline pt-5 sm:flex-row sm:items-center sm:justify-between">
          <span className="bc-label flex items-center gap-3 text-bc-text-2">
            <span className="bc-sep" aria-hidden="true" />
            Published in {league.name}
          </span>
          {isMember && (
            <Link
              href={`/leagues/${league._id}`}
              className="inline-flex items-center gap-2.5 font-display text-[18px] font-bold tracking-[0.08em] text-bc-red-text uppercase hover:underline"
            >
              More league stories
              <ArrowRight className="size-[18px]" strokeWidth={2} />
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}
