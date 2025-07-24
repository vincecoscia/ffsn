import { ArticleClient } from "./ArticleClient";

interface ArticlePageProps {
  params: Promise<{ id: string }>;
}

export default async function ArticlePage({ params }: ArticlePageProps) {
  const { id } = await params;
  
  return <ArticleClient articleId={id} />;
}