import { ArticleClient } from "./ArticleClient";
import { Metadata } from "next";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../../../convex/_generated/api";
import { Id } from "../../../../convex/_generated/dataModel";

interface ArticlePageProps {
  params: Promise<{ id: string }>;
}

const convex = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);

export async function generateMetadata({ params }: ArticlePageProps): Promise<Metadata> {
  const { id } = await params;
  
  try {
    // Fetch article data server-side
    const article = await convex.query(api.aiContent.getById, {
      articleId: id as Id<"aiContent">
    });

    if (!article) {
      return {
        title: "Article Not Found - FFSN",
        description: "The requested article could not be found.",
      };
    }

    // Fetch league data for additional context
    const league = await convex.query(api.leagues.getPublicInfo, {
      id: article.leagueId
    });

    // Generate description from content (first 160 characters)
    const description = article.content
      .replace(/[#*_`]/g, '') // Remove markdown formatting
      .replace(/\n/g, ' ') // Replace newlines with spaces
      .substring(0, 160)
      .trim() + (article.content.length > 160 ? '...' : '');

    const title = `${article.title} - ${league?.name || 'FFSN'}`;
    
    // Construct the article URL for canonical and og:url
    const articleUrl = `${process.env.NEXT_PUBLIC_SITE_URL || 'https://ffsn.ai'}/articles/${id}`;

    const metadata: Metadata = {
      title,
      description,
      authors: [{ name: article.persona }],
      openGraph: {
        title,
        description,
        type: 'article',
        url: articleUrl,
        siteName: 'FFSN - Fantasy Football Social Network',
        publishedTime: article.publishedAt ? new Date(article.publishedAt).toISOString() : new Date(article.createdAt).toISOString(),
        authors: [article.persona],
        tags: [
          'fantasy football',
          'NFL',
          article.type,
          league?.name || 'fantasy league'
        ].filter(Boolean),
      },
      twitter: {
        card: 'summary_large_image',
        title,
        description,
        creator: '@ffsn_ai',
        site: '@ffsn_ai',
      },
      alternates: {
        canonical: articleUrl,
      },
    };

    // Add banner image if available
    if (article.bannerImageUrl) {
      metadata.openGraph!.images = [
        {
          url: article.bannerImageUrl,
          width: 1200,
          height: 630,
          alt: article.title,
        }
      ];
      metadata.twitter!.images = [article.bannerImageUrl];
    } else {
      // Fallback to FFSN logo
      const fallbackImage = `${process.env.NEXT_PUBLIC_SITE_URL || 'https://ffsn.ai'}/FFSN.png`;
      metadata.openGraph!.images = [
        {
          url: fallbackImage,
          width: 512,
          height: 512,
          alt: 'FFSN Logo',
        }
      ];
      metadata.twitter!.images = [fallbackImage];
    }

    return metadata;
  } catch (error) {
    console.error('Error generating metadata:', error);
    return {
      title: "FFSN Article",
      description: "AI-powered fantasy football content for your league",
    };
  }
}

export default async function ArticlePage({ params }: ArticlePageProps) {
  const { id } = await params;
  
  return <ArticleClient articleId={id} />;
}