"use client";

import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { formatDistanceToNow } from "date-fns";

interface ESPNNewsWidgetProps {
  limit?: number;
  teamId?: number;
  athleteId?: number;
}

export function ESPNNewsWidget({ 
  limit = 5, 
  teamId, 
  athleteId 
}: ESPNNewsWidgetProps) {
  const newsData = useQuery(api.news.getLatestNews, {
    limit,
    teamId,
    athleteId,
    onlyNonPremium: true, // Filter out premium content
  });

  if (!newsData) {
    return (
      <div className="bg-white rounded-lg shadow-sm">
        <div className="border-b border-gray-200 p-4">
          <h3 className="text-lg font-bold text-gray-900">🔥 Top Headlines</h3>
        </div>
        <div className="p-4 space-y-4">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="border-b border-gray-100 pb-3 last:border-0 animate-pulse">
              <div className="h-4 bg-gray-200 rounded w-3/4 mb-2"></div>
              <div className="h-3 bg-gray-200 rounded w-1/2"></div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (!newsData.articles || newsData.articles.length === 0) {
    return (
      <div className="bg-white rounded-lg shadow-sm">
        <div className="border-b border-gray-200 p-4">
          <h3 className="text-lg font-bold text-gray-900">🔥 Top Headlines</h3>
        </div>
        <div className="p-4">
          <p className="text-sm text-gray-500">No news available at the moment.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-lg shadow-sm">
      <div className="border-b border-gray-200 p-4">
        <h3 className="text-lg font-bold text-gray-900">🔥 Top Headlines</h3>
      </div>
      <div className="p-4 space-y-4">
        {newsData.articles.map((article) => (
          <div key={article._id} className="border-b border-gray-100 pb-3 last:border-0">
            <a
              href={article.links.web || article.links.mobile || "#"}
              target="_blank"
              rel="noopener noreferrer"
              className="block group"
            >
              <h4 className="font-bold text-sm text-gray-900 group-hover:text-red-600 mb-1 line-clamp-2">
                {article.headline}
              </h4>
              {article.description && (
                <p className="text-xs text-gray-600 line-clamp-2 mb-2">
                  {article.description}
                </p>
              )}
              <div className="flex items-center justify-between">
                <p className="text-xs text-gray-500">
                  {formatDistanceToNow(new Date(article.published), { addSuffix: true })}
                </p>
                {article.premium && (
                  <span className="text-xs bg-yellow-100 text-yellow-800 px-2 py-0.5 rounded">
                    Premium
                  </span>
                )}
              </div>
              {/* Show team/athlete tags if available */}
              {(article.categories.teams.length > 0 || article.categories.athletes.length > 0) && (
                <div className="flex flex-wrap gap-1 mt-2">
                  {article.categories.teams.slice(0, 2).map((team) => (
                    <span
                      key={team.id}
                      className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded"
                    >
                      {team.abbreviation || team.name}
                    </span>
                  ))}
                  {article.categories.athletes.slice(0, 1).map((athlete) => (
                    <span
                      key={athlete.id}
                      className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded"
                    >
                      {athlete.name}
                    </span>
                  ))}
                </div>
              )}
            </a>
          </div>
        ))}
      </div>
    </div>
  );
}