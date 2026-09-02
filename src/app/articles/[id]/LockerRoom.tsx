"use client";

import { useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import { Id } from "../../../../convex/_generated/dataModel";
import { Card } from "@/components/ui/card";
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
    <section className="mt-6 sm:mt-8 pt-6 sm:pt-8 border-t border-gray-200">
      <h2 className="flex items-center gap-2 text-lg sm:text-xl font-bold text-gray-900 mb-4">
        <MessageSquareQuote className="size-5 text-red-600" />
        Locker Room
      </h2>
      <div className="grid gap-3 sm:gap-4">
        {quotes.map((quote, index) => (
          <Card key={index} className="gap-2 p-4 sm:p-5">
            <p className="text-gray-800 italic leading-relaxed">&ldquo;{quote.quote}&rdquo;</p>
            <p className="text-sm text-gray-500">
              &mdash; {quote.userName}
              {quote.teamName ? `, ${quote.teamName}` : ""}
            </p>
          </Card>
        ))}
      </div>
    </section>
  );
}
