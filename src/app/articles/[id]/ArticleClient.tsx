"use client";

import { useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import { Id } from "../../../../convex/_generated/dataModel";
import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Clock, User } from "lucide-react";
import { MarkdownPreview } from "@/components/MarkdownPreview";

interface ArticleClientProps {
  articleId: string;
}

export function ArticleClient({ articleId }: ArticleClientProps) {
  // Get the article
  const article = useQuery(api.aiContent.getById, {
    articleId: articleId as Id<"aiContent">
  });

  // Get the league information if we have the article
  const league = useQuery(
    api.leagues.getById,
    article ? { id: article.leagueId } : "skip"
  );

  // Loading state
  if (article === undefined || league === undefined) {
    return (
      <div className="min-h-screen bg-gray-100 flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-red-600 mx-auto mb-4"></div>
          <p className="text-gray-600">Loading article...</p>
        </div>
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

  return (
    <div className="min-h-screen bg-gray-100">
      {/* ESPN-style Header */}
      <header className="bg-red-600 shadow-lg">
        <div className="container mx-auto px-4">
          <div className="flex items-center justify-between h-16">
            <div className="flex items-center gap-6">
              <Link href="/" className="flex items-center cursor-pointer">
                <img
                  src="/FFSN.png"
                  alt="FFSN Logo"
                  className="h-12 w-auto"
                />
              </Link>
              <span className="text-red-200">|</span>
              <Link 
                href={`/leagues/${league._id}`}
                className="text-white hover:text-red-200 transition-colors font-semibold"
              >
                {league.name}
              </Link>
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <div className="container mx-auto px-4 py-8">
        <div className="max-w-4xl mx-auto">
          {/* Back Button */}
          <Link 
            href={`/leagues/${league._id}`}
            className="inline-flex items-center gap-2 text-red-600 hover:text-red-800 mb-6 transition-colors"
          >
            <ArrowLeft size={16} />
            Back to League Home
          </Link>

          {/* Article Header */}
          <article className="bg-white rounded-lg shadow-sm overflow-hidden">
            {/* Banner Image */}
            {article.bannerImageUrl && (
              <div className="relative w-full h-[400px] overflow-hidden">
                <img 
                  src={article.bannerImageUrl} 
                  alt={article.title}
                  className="w-full h-full object-cover"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-black/50 to-transparent"></div>
              </div>
            )}
            
            <div className="p-8">
              <header className="mb-8">
                <h1 className="text-4xl font-bold text-gray-900 mb-4 leading-tight">
                  {article.title}
                </h1>
                
                <div className="flex items-center gap-6 text-gray-600 text-sm">
                  <div className="flex items-center gap-2">
                    <User size={16} />
                    <span>By {article.persona}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Clock size={16} />
                    <span>{publishedDate}</span>
                  </div>
                  <div className="px-3 py-1 bg-red-100 text-red-800 text-xs font-medium rounded-full">
                    {article.type.charAt(0).toUpperCase() + article.type.slice(1)}
                  </div>
                </div>
              </header>

              {/* Article Content */}
              <div className="prose prose-lg max-w-none">
                <MarkdownPreview 
                  content={article.content}
                  className="text-gray-800 leading-relaxed"
                />
              </div>

              {/* Article Footer */}
              <footer className="mt-8 pt-8 border-t border-gray-200">
                <div className="flex items-center justify-between">
                  <div className="text-sm text-gray-500">
                    Published in <strong>{league.name}</strong>
                  </div>
                  <Link 
                    href={`/leagues/${league._id}`}
                    className="text-red-600 hover:text-red-800 text-sm font-medium transition-colors"
                  >
                    View more league stories →
                  </Link>
                </div>
              </footer>
            </div>
          </article>
        </div>
      </div>
    </div>
  );
}