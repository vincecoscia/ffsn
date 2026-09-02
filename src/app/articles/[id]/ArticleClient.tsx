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
  PullQuote,
  BannerPlaceholder,
  LoadingScreen,
  SectionHeader,
  contentTypeLabel,
  personaName,
  personaRole,
} from "@/components/broadcast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { MarkdownPreview, placedQuoteIds } from "@/components/MarkdownPreview";
import { EngagementBar } from "./EngagementBar";
import { LockerRoom } from "./LockerRoom";

interface ArticleClientProps {
  articleId: string;
}

// Bylines resolve through `getPersonaDisplay` (re-exported from the broadcast kit
// as personaName / personaRole), so an archived story by a retired writer keeps
// the name and role it was published under.

const WORDS_PER_MINUTE = 225;

function estimateReadMinutes(content: string): number {
  const words = content
    .replace(/[#*_`>]/g, " ")
    .split(/\s+/)
    .filter(Boolean).length;
  return Math.max(1, Math.round(words / WORDS_PER_MINUTE));
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

  // Only needed to put a team name on a sideline quote; league members only.
  const leagueTeams = useQuery(
    api.teams.getTeamsByLeague,
    article && isAuthenticated ? { leagueId: article.leagueId } : "skip"
  );

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
  const storyType = contentTypeLabel(article.type);
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

  // `quotes[].teamId` is a FACTS id ("T" + ESPN externalId) or a Convex team id,
  // depending on how the article was built — accept either.
  const teamNameById = new Map<string, string>();
  for (const team of leagueTeams ?? []) {
    teamNameById.set(team._id, team.name);
    if (team.externalId) {
      teamNameById.set(team.externalId, team.name);
      teamNameById.set(`T${team.externalId}`, team.name);
    }
  }

  const teamNameFor = (teamId: string) => teamNameById.get(teamId);

  const allQuotes = article.quotes ?? [];

  const bodyContent = (() => {
    const lines = article.content.split('\n');
    // Skip the first line if it's a markdown header (starts with #)
    if (lines.length > 0 && lines[0].trim().startsWith('#')) {
      return lines.slice(1).join('\n').trim();
    }
    return article.content;
  })();

  // A quote the writer placed in the body with a `:::quote{id=…}` directive (spec §8.3)
  // is already printed in the prose, so "From the sideline" below carries only the ones
  // that were left out — never the same words twice on one page.
  const placedInBody = placedQuoteIds(bodyContent);
  const sidelineQuotes = allQuotes.filter((quote) => !placedInBody.has(quote.quoteId));

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
            name={personaName(article.persona)}
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
            <MarkdownPreview
              content={bodyContent}
              quotes={allQuotes}
              quoteWeek={typeof week === "number" ? week : undefined}
              quotePersona={article.persona}
              resolveTeamName={teamNameFor}
            />
          </div>
        </Panel>

        {sidelineQuotes.length > 0 && (
          <div className="flex w-full max-w-[880px] flex-col gap-6">
            <SectionHeader title="From the sideline" kicker="On the record" />
            <div className="flex flex-col gap-8">
              {sidelineQuotes.map((quote, index) => (
                <PullQuote
                  key={quote.quoteId || `${quote.speaker}-${index}`}
                  quote={quote.text}
                  speaker={quote.speaker}
                  team={teamNameFor(quote.teamId)}
                  week={typeof week === "number" ? week : undefined}
                  writerResponse={quote.writerResponse}
                  writerPersona={article.persona}
                />
              ))}
            </div>
          </div>
        )}

        <div className="w-full max-w-[880px]">
          <EngagementBar articleId={articleId} title={article.title} summary={articleSummary} />
        </div>

        {/* Locker Room lists every quote the pipeline collected. When the article
            carries verified quotes, the body and "From the sideline" above already
            print them with the writer's reply, so showing both would repeat the
            same lines. */}
        {allQuotes.length === 0 && (
          <div className="w-full max-w-[880px]">
            <LockerRoom articleId={articleId} />
          </div>
        )}

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
