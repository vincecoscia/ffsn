"use client";

import { use } from "react";
import Link from "next/link";
import { Button } from "@radix-ui/themes";
import { MarkdownPreview } from "./MarkdownPreview";
import { useConvex } from "convex/react";
import { fetchArticles } from "../lib/suspense-data";
import type { Id } from "../../convex/_generated/dataModel";

interface ArticleListProps {
  leagueId: Id<"leagues">;
  cursor: string | null;
  isCommissioner: boolean;
  onShowContentGenerator: () => void;
}

export function ArticleList({ leagueId, cursor, isCommissioner, onShowContentGenerator }: ArticleListProps) {
  // Get the convex client
  const convex = useConvex();
  
  // Use the use() hook to fetch data with Suspense
  const aiContentResult = use(fetchArticles(convex, leagueId, {
    numItems: 3,
    cursor: cursor
  })) as { page: Array<{
    _id: string;
    title: string;
    content: string;
    publishedAt?: number;
    createdAt: number;
    type: string;
    persona: string;
  }>; isDone: boolean; continueCursor: string | null } | null;

  // Extract the page data
  const aiContent = aiContentResult?.page || [];

  if (!aiContent || aiContent.length === 0) {
    return (
      <div className="text-center py-12">
        <div className="text-gray-400 mb-6">
          <svg className="w-20 h-20 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
        </div>
        <h3 className="text-xl font-bold text-gray-900 mb-3">No Stories Yet</h3>
        <p className="text-gray-600 mb-6 max-w-md mx-auto">
          Generate AI-powered stories about your league including weekly recaps, trade analysis, and player breakdowns.
        </p>
        {isCommissioner && (
          <Button
            onClick={onShowContentGenerator}
            color="red"
            size="3"
            className="cursor-pointer"
          >
            Create Your First Story
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="grid gap-6">
      {aiContent.map((article) => (
        <article key={article._id} className="border-b border-gray-200 pb-6 last:border-0">
          <Link href={`/articles/${article._id}`} className="block hover:bg-gray-50 transition-colors rounded-lg p-2 -m-2">
            <div className="flex gap-4">
              <div className="flex-1">
                <h3 className="font-bold text-xl text-gray-900 mb-2 hover:text-red-600 cursor-pointer transition-colors">
                  {article.title}
                </h3>
                <div className="text-gray-600 text-sm mb-3">
                  {new Date(article.publishedAt || article.createdAt).toLocaleDateString('en-US', {
                    weekday: 'long',
                    year: 'numeric',
                    month: 'long',
                    day: 'numeric'
                  })}
                </div>
                <MarkdownPreview 
                  content={article.content} 
                  preview={true} 
                  maxLines={3} 
                />
              </div>
              <div className="w-32 h-24 bg-gray-200 rounded flex-shrink-0"></div>
            </div>
          </Link>
        </article>
      ))}
    </div>
  );
}