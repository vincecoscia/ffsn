"use client";

import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Panel, SectionHeader } from "@/components/broadcast";
import { Skeleton } from "@/components/ui/skeleton";
import { ChevronRight } from "lucide-react";

interface ESPNNewsWidgetProps {
  limit?: number;
  teamId?: number;
  athleteId?: number;
}

export function ESPNNewsWidget({
  limit = 5,
  teamId,
  athleteId,
}: ESPNNewsWidgetProps) {
  const newsData = useQuery(api.news.getLatestNews, {
    limit,
    teamId,
    athleteId,
    onlyNonPremium: true, // Filter out premium content
    type: "HeadlineNews", // Only show HeadlineNews type articles
  });

  return (
    <Panel padding="none" className="flex flex-col px-5 pt-5 pb-2 sm:px-[22px]">
      <SectionHeader
        size="sm"
        title="Around the NFL"
        actions={<span className="bc-label-sm text-bc-text-3">ESPN headlines</span>}
        className="pb-3"
      />

      {newsData === undefined && (
        <div className="flex flex-col">
          {[1, 2, 3].map((i) => (
            <div key={i} className="flex items-center gap-3 border-t border-bc-hairline py-3">
              <Skeleton className="h-4 w-5 flex-none" />
              <Skeleton className="h-4 flex-1" />
            </div>
          ))}
        </div>
      )}

      {newsData && (!newsData.articles || newsData.articles.length === 0) && (
        <p className="py-6 text-center text-[14px] text-bc-text-2">
          No news available at the moment.
        </p>
      )}

      {newsData && newsData.articles && newsData.articles.length > 0 && (
        <div className="flex flex-col">
          {newsData.articles.map((article, index) => (
            <a
              key={article._id}
              href={article.links.web || article.links.mobile || "#"}
              target="_blank"
              rel="noopener noreferrer"
              className="group flex items-center gap-3 border-t border-bc-hairline py-3"
            >
              <span className="bc-label-sm w-5 flex-none text-bc-text-3">
                {String(index + 1).padStart(2, "0")}
              </span>
              <span className="line-clamp-2 flex-1 text-[15px] leading-snug text-bc-ink group-hover:text-bc-red-text">
                {article.headline}
              </span>
              <ChevronRight
                className="hidden size-4 flex-none text-bc-text-3 sm:block"
                strokeWidth={2}
              />
            </a>
          ))}
        </div>
      )}
    </Panel>
  );
}
