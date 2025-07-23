import { notFound } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import { ArrowLeft, Clock, User } from "lucide-react";
import { MarkdownPreview } from "@/components/MarkdownPreview";
import { ArticleClient } from "./ArticleClient";

interface ArticlePageProps {
  params: Promise<{ id: string }>;
}

export default async function ArticlePage({ params }: ArticlePageProps) {
  const { id } = await params;
  
  return <ArticleClient articleId={id} />;
}