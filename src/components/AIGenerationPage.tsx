"use client";

import React, { useState, useEffect } from "react";
import { useQuery, useMutation } from "convex/react";
import { toast } from "sonner";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import { ContentGenerator } from "@/components/ContentGenerator";
import {
  Sparkles,
  Eye,
  EyeOff,
  Send,
  Trash2,
  XCircle,
  RotateCcw,
  Pencil,
  Save,
  X
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import {
  PageHeader,
  Panel,
  Chip,
  EmptyState,
  Spinner,
  DeskReview,
  contentTypeLabel,
  personaName,
} from "@/components/broadcast";
import { MarkdownPreview, type ArticleQuote } from "@/components/MarkdownPreview";
import { WaitingOnComment } from "@/components/WaitingOnComment";
import { CreditTopUpButton } from "@/components/CreditTopUpButton";
import { cn } from "@/lib/utils";

interface AIGenerationPageProps {
  leagueId: Id<"leagues">;
}

interface Article {
  _id: Id<"aiContent">;
  title: string;
  summary?: string;
  content: string;
  type: string;
  persona: string;
  status: string;
  publishedAt?: number;
  createdAt: number;
  metadata: {
    week?: number;
    featured_teams: Id<"teams">[];
    credits_used: number;
  };
  // Verifier findings and unmet data requests for this draft (spec §4.5).
  reviewFlags?: Array<{
    kind: string;
    detail: string;
    section?: string;
    severity: "block" | "strip" | "warn";
  }>;
  factsMissing?: string[];
  // Verified ledger quotes, so the preview can resolve `:::quote{id=…}` directives
  // the same way the published page does (spec §8.3).
  quotes?: ArticleQuote[];
  // Free-form field the generation pipeline uses for transient data; the
  // Edit form (see editArticle in convex/aiContent.ts) also persists an
  // edited summary here as `{ summary: string }` since aiContent has no
  // dedicated summary column.
  tempGenerationData?: unknown;
}

// aiContent has no persisted summary field (see the comment on
// aiContent.editArticle). Mirrors the same derivation used server-side in
// convex/notifications.ts's deriveArticleSummary: prefer a commissioner-
// edited summary saved in tempGenerationData, otherwise fall back to a
// plain-text excerpt of the content.
function getArticleSummary(article: Article): string {
  if (article.summary && article.summary.trim().length > 0) {
    return article.summary.trim();
  }

  const plain = article.content.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return plain.length > 200 ? `${plain.slice(0, 200).trim()}…` : plain;
}

// Status chip configuration
function getStatusChip(status: string) {
  switch (status) {
    case "generating":
      return { variant: "signal" as const, live: true, label: "Generating", icon: RotateCcw };
    case "draft":
      return { variant: "outline" as const, live: false, label: "Draft", icon: Eye };
    case "review":
      return { variant: "default" as const, live: false, label: "Ready to publish", icon: Send };
    case "published":
      return { variant: "win" as const, live: false, label: "Published", icon: Send };
    case "error":
      return { variant: "red" as const, live: false, label: "Error", icon: XCircle };
    default:
      return { variant: "outline" as const, live: false, label: status, icon: undefined };
  }
}

function StatusChip({ status }: { status: string }) {
  const chip = getStatusChip(status);
  const Icon = chip.icon;
  return (
    <Chip variant={chip.variant} live={chip.live}>
      {Icon && <Icon className={cn("size-3", status === "generating" && "animate-spin")} />}
      {chip.label}
    </Chip>
  );
}

export default function AIGenerationPage({ leagueId }: AIGenerationPageProps) {
  const [selectedArticle, setSelectedArticle] = useState<Article | null>(null);
  const [activeTab, setActiveTab] = useState("generate");
  const [editingArticleId, setEditingArticleId] = useState<Id<"aiContent"> | null>(null);
  const [editForm, setEditForm] = useState({ title: "", summary: "", content: "" });
  const [isSavingEdit, setIsSavingEdit] = useState(false);

  // Get league data
  const league = useQuery(api.leagues.getById, { id: leagueId });

  // Get all articles for this league (for management)
  const articles = useQuery(api.aiContent.getAllByLeague, { leagueId }) || [];

  // Mutations for article management
  const publishArticle = useMutation(api.aiContent.updateContentStatus);
  const deleteArticle = useMutation(api.aiContent.deleteContent);
  const editArticle = useMutation(api.aiContent.editArticle);

  // Handle entering Edit mode for a draft article
  const handleStartEdit = (article: Article) => {
    setSelectedArticle(null);
    setEditingArticleId(article._id);
    setEditForm({
      title: article.title,
      summary: getArticleSummary(article),
      content: article.content,
    });
  };

  const handleCancelEdit = () => {
    setEditingArticleId(null);
  };

  const handleSaveEdit = async (articleId: Id<"aiContent">) => {
    setIsSavingEdit(true);
    try {
      await editArticle({
        articleId,
        title: editForm.title,
        summary: editForm.summary,
        content: editForm.content,
      });
      toast.success("Article updated");
      setEditingArticleId(null);
    } catch (error) {
      console.error("Error saving article edits:", error);
      toast.error(error instanceof Error ? error.message : "Failed to save changes");
    } finally {
      setIsSavingEdit(false);
    }
  };

  // Filter articles by status
  const generatingArticles = articles.filter(a => a.status === "generating");
  // Holding for comment: the desk has asked, and the clock is running (spec §8.2).
  const waitingArticles = articles.filter(a => a.status === "waiting_for_comments");
  const draftArticles = articles.filter(a => a.status === "draft" || a.status === "review");
  const publishedArticles = articles.filter(a => a.status === "published");
  const errorArticles = articles.filter(a => a.status === "error");

  // Handle article publishing
  const handlePublishArticle = async (articleId: Id<"aiContent">) => {
    try {
      await publishArticle({
        articleId,
        status: "published",
      });
    } catch (error) {
      console.error("Error publishing article:", error);
    }
  };

  // Handle article deletion
  const handleDeleteArticle = async (articleId: Id<"aiContent">) => {
    try {
      await deleteArticle({ articleId });
    } catch (error) {
      console.error("Error deleting article:", error);
    }
  };

  // Auto-refresh generating articles
  useEffect(() => {
    const interval = setInterval(() => {
      // This will cause the query to re-run and get fresh data
      if (generatingArticles.length > 0) {
        // The reactive query will automatically update
      }
    }, 3000);

    return () => clearInterval(interval);
  }, [generatingArticles.length]);

  if (!league) {
    return (
      <div className="min-h-screen bg-bc-ground">
        <div className="flex min-h-[60vh] items-center justify-center">
          <Spinner size={20} />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-bc-ground">
      <div className="mx-auto flex max-w-6xl flex-col gap-8 px-4 py-10 sm:px-6 sm:py-12 lg:px-12">
        <PageHeader
          kicker="Production desk"
          title="AI content"
          description={`Create and manage AI-generated content for ${league.name}.`}
          actions={<CreditTopUpButton leagueId={leagueId} variant="glow" size="sm" />}
        />

        {/* Tabs for different sections */}
        <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
          {/* Responsive, scrollable tab list on mobile */}
          <ScrollArea className="w-full">
            <TabsList className="inline-flex w-max gap-2 px-1">
              <TabsTrigger value="generate" className="flex items-center gap-2 whitespace-nowrap px-3 py-2 text-sm sm:text-base">
                <Sparkles className="size-4" />
                Generate
              </TabsTrigger>
              <TabsTrigger value="generating" className="flex items-center gap-2 whitespace-nowrap px-3 py-2 text-sm sm:text-base">
                <RotateCcw className="size-4" />
                In progress ({generatingArticles.length + waitingArticles.length})
              </TabsTrigger>
              <TabsTrigger value="review" className="flex items-center gap-2 whitespace-nowrap px-3 py-2 text-sm sm:text-base">
                <Eye className="size-4" />
                Review ({draftArticles.length})
              </TabsTrigger>
              <TabsTrigger value="published" className="flex items-center gap-2 whitespace-nowrap px-3 py-2 text-sm sm:text-base">
                <Send className="size-4" />
                Published ({publishedArticles.length})
              </TabsTrigger>
            </TabsList>
            <ScrollBar orientation="horizontal" />
          </ScrollArea>

          {/* Generate Content Tab */}
          <TabsContent value="generate" className="mt-6">
            <ContentGenerator
              leagueId={leagueId}
              isCommissioner={league.role === "commissioner"}
            />
          </TabsContent>

          {/* Generating Articles Tab */}
          <TabsContent value="generating" className="mt-6 flex flex-col gap-4">
            {/* Stories holding for comment come first: they're the ones a person can
                still act on, by running the deadline early. */}
            {waitingArticles.map((article) => (
              <WaitingOnComment
                key={article._id}
                articleId={article._id}
                title={article.title}
              />
            ))}

            {generatingArticles.length === 0 && waitingArticles.length === 0 ? (
              <EmptyState
                icon={<RotateCcw className="size-6" strokeWidth={1.8} />}
                title="No articles currently generating"
              />
            ) : (
              generatingArticles.map((article) => (
                <Panel key={article._id} padding="md">
                  <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                    <div>
                      <div className="mb-2 flex items-center gap-2">
                        <h3 className="font-display text-[18px] font-bold uppercase tracking-[0.01em] text-bc-ink">{article.title}</h3>
                        <StatusChip status={article.status} />
                      </div>
                      <p className="text-sm text-bc-text-2">
                        {contentTypeLabel(article.type)} &middot; {personaName(article.persona)} &middot;{" "}
                        {article.metadata.credits_used} credits
                      </p>
                      <p className="text-xs text-bc-text-3">
                        Started {new Date(article.createdAt).toLocaleString()}
                      </p>
                    </div>
                    <Spinner size={22} className="self-start md:self-auto" />
                  </div>
                </Panel>
              ))
            )}
          </TabsContent>

          {/* Review Articles Tab */}
          <TabsContent value="review" className="mt-6 flex flex-col gap-4">
            {draftArticles.length === 0 ? (
              <EmptyState
                icon={<Eye className="size-6" strokeWidth={1.8} />}
                title="No articles ready for review"
              />
            ) : (
              draftArticles.map((article) => {
                const isEditing = editingArticleId === article._id;
                return (
                  <Panel key={article._id} padding="md">
                    <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                      <div>
                        <div className="mb-2 flex items-center gap-2">
                          <h3 className="font-display text-[18px] font-bold uppercase tracking-[0.01em] text-bc-ink">{article.title}</h3>
                          <StatusChip status={article.status} />
                        </div>
                        <p className="text-sm text-bc-text-2">
                          {contentTypeLabel(article.type)} &middot; {personaName(article.persona)} &middot;{" "}
                          {article.metadata.credits_used} credits
                        </p>
                        <p className="text-xs text-bc-text-3">
                          Generated {new Date(article.createdAt).toLocaleString()}
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {isEditing ? (
                          <>
                            <Button
                              size="sm"
                              onClick={() => handleSaveEdit(article._id)}
                              disabled={isSavingEdit}
                            >
                              <Save className="size-4" />
                              Save
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={handleCancelEdit}
                              disabled={isSavingEdit}
                            >
                              <X className="size-4" />
                              Cancel
                            </Button>
                          </>
                        ) : (
                          <>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => setSelectedArticle(selectedArticle?._id === article._id ? null : article)}
                            >
                              {selectedArticle?._id === article._id ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                              {selectedArticle?._id === article._id ? "Hide" : "Preview"}
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => handleStartEdit(article)}
                            >
                              <Pencil className="size-4" />
                              Edit
                            </Button>
                            <Button
                              size="sm"
                              onClick={() => handlePublishArticle(article._id)}
                            >
                              <Send className="size-4" />
                              Publish
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => handleDeleteArticle(article._id)}
                            >
                              <Trash2 className="size-4" />
                            </Button>
                          </>
                        )}
                      </div>
                    </div>

                    <DeskReview
                      className="mb-4"
                      flags={article.reviewFlags}
                      factsMissing={article.factsMissing}
                    />

                    {isEditing ? (
                      <div className="mt-4 flex flex-col gap-4 border border-bc-hairline bg-bc-panel-2 p-4">
                        <div className="flex flex-col gap-1.5">
                          <Label htmlFor={`title-${article._id}`}>Title</Label>
                          <Input
                            id={`title-${article._id}`}
                            value={editForm.title}
                            onChange={(e) => setEditForm((f) => ({ ...f, title: e.target.value }))}
                            disabled={isSavingEdit}
                          />
                        </div>
                        <div className="flex flex-col gap-1.5">
                          <Label htmlFor={`summary-${article._id}`}>Summary</Label>
                          <Textarea
                            id={`summary-${article._id}`}
                            value={editForm.summary}
                            onChange={(e) => setEditForm((f) => ({ ...f, summary: e.target.value }))}
                            rows={3}
                            disabled={isSavingEdit}
                          />
                        </div>
                        <div className="flex flex-col gap-1.5">
                          <Label htmlFor={`content-${article._id}`}>Content</Label>
                          <Textarea
                            id={`content-${article._id}`}
                            value={editForm.content}
                            onChange={(e) => setEditForm((f) => ({ ...f, content: e.target.value }))}
                            rows={16}
                            className="w-full font-mono text-xs"
                            disabled={isSavingEdit}
                          />
                        </div>
                      </div>
                    ) : (
                      selectedArticle?._id === article._id && (
                        <Panel lifted padding="sm" className="mt-4 overflow-x-auto">
                          {/* Rendered exactly as the published page renders it, so a
                              `:::quote{id=…}` directive shows the pull quote the reader
                              will get rather than the raw directive (spec §8.3). */}
                          <MarkdownPreview
                            className="bc-prose"
                            content={article.content}
                            quotes={article.quotes}
                            quoteWeek={article.metadata.week}
                            quotePersona={article.persona}
                          />
                        </Panel>
                      )
                    )}
                  </Panel>
                );
              })
            )}
          </TabsContent>

          {/* Published Articles Tab */}
          <TabsContent value="published" className="mt-6 flex flex-col gap-4">
            {publishedArticles.length === 0 ? (
              <EmptyState
                icon={<Send className="size-6" strokeWidth={1.8} />}
                title="No published articles yet"
              />
            ) : (
              publishedArticles.map((article) => (
                <Panel key={article._id} padding="md">
                  <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                    <div>
                      <div className="mb-2 flex items-center gap-2">
                        <h3 className="font-display text-[18px] font-bold uppercase tracking-[0.01em] text-bc-ink">{article.title}</h3>
                        <StatusChip status={article.status} />
                      </div>
                      <p className="text-sm text-bc-text-2">
                        {contentTypeLabel(article.type)} &middot; {personaName(article.persona)} &middot;{" "}
                        {article.metadata.credits_used} credits
                      </p>
                      <p className="text-xs text-bc-text-3">
                        Published {article.publishedAt ? new Date(article.publishedAt).toLocaleString() : "Unknown"}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setSelectedArticle(selectedArticle?._id === article._id ? null : article)}
                      >
                        {selectedArticle?._id === article._id ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                        {selectedArticle?._id === article._id ? "Hide" : "View"}
                      </Button>
                    </div>
                  </div>

                  {selectedArticle?._id === article._id && (
                    <Panel lifted padding="sm" className="mt-4 overflow-x-auto">
                      <MarkdownPreview
                        className="bc-prose"
                        content={article.content}
                        quotes={article.quotes}
                        quoteWeek={article.metadata.week}
                        quotePersona={article.persona}
                      />
                    </Panel>
                  )}
                </Panel>
              ))
            )}
          </TabsContent>
        </Tabs>

        {/* Error Articles (show if any exist) */}
        {errorArticles.length > 0 && (
          <Panel padding="md" className="border-l-4 border-l-bc-red-deep">
            <div className="flex items-center gap-2 text-bc-red-text">
              <XCircle className="size-5" />
              <h2 className="font-display text-[20px] font-bold uppercase tracking-[0.01em]">
                Failed generations ({errorArticles.length})
              </h2>
            </div>
            <div className="mt-4 flex flex-col gap-3">
              {errorArticles.map((article) => (
                <div key={article._id} className="flex flex-col gap-3 border border-bc-red-deep/30 bg-bc-red-deep/10 p-3 md:flex-row md:items-center md:justify-between">
                  <div>
                    <p className="font-medium text-bc-red-text">{article.title}</p>
                    <p className="text-sm text-bc-text-2">
                      {contentTypeLabel(article.type)} &middot; {personaName(article.persona)}
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleDeleteArticle(article._id)}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              ))}
            </div>
          </Panel>
        )}
      </div>
    </div>
  );
}
