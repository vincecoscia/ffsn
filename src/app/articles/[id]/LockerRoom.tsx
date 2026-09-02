"use client";

import { useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import { Id } from "../../../../convex/_generated/dataModel";
import { Panel, SectionHeader, LowerThird } from "@/components/broadcast";
import { MessageSquareQuote } from "lucide-react";

interface LockerRoomProps {
  articleId: string;
}

/**
 * Manager quotes collected by the AI comment-request pipeline for this
 * article. Renders nothing when there are none - not every article requests
 * comments, and not every request gets a usable response.
 */
export function LockerRoom({ articleId }: LockerRoomProps) {
  const quotes = useQuery(api.articleEngagement.getArticleQuotes, {
    articleId: articleId as Id<"aiContent">,
  });

  if (!quotes || quotes.length === 0) {
    return null;
  }

  return (
    <section className="flex w-full flex-col gap-5">
      <SectionHeader
        title={
          <span className="inline-flex items-center gap-3">
            <MessageSquareQuote className="size-6" strokeWidth={1.8} />
            Locker room
          </span>
        }
        actions={
          <span className="bc-label-sm hidden text-bc-text-3 sm:inline">Manager quotes</span>
        }
      />
      <div className="grid gap-4 sm:grid-cols-2">
        {quotes.map((quote, index) => (
          <Panel key={index} padding="md" className="relative flex flex-col gap-4 overflow-hidden">
            <span
              aria-hidden="true"
              className="pointer-events-none absolute -top-6 right-3 font-display text-[100px] leading-none font-extrabold text-bc-red/15"
            >
              &rdquo;
            </span>
            <p className="relative font-sans text-[20px] leading-relaxed text-bc-body italic">
              &ldquo;{quote.quote}&rdquo;
            </p>
            <LowerThird compact name={quote.userName} role={quote.teamName ?? undefined} />
          </Panel>
        ))}
      </div>
    </section>
  );
}
