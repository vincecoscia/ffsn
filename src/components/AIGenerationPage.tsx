"use client";

import React, { useState, useEffect } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import { ContentGenerator } from "@/components/ContentGenerator";
import { 
  Sparkles, 
  Eye,
  EyeOff,
  Send,
  Trash2,
  CheckCircle,
  XCircle,
  RotateCcw
} from "lucide-react";

import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

interface AIGenerationPageProps {
  leagueId: Id<"leagues">;
}

interface Article {
  _id: Id<"aiContent">;
  title: string;
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
}

// Status badges configuration
const getStatusBadge = (status: string) => {
  switch (status) {
    case "generating":
      return <Badge variant="secondary" className="flex items-center gap-1">
        <RotateCcw className="h-3 w-3 animate-spin" />
        Generating
      </Badge>;
    case "draft":
      return <Badge variant="outline" className="flex items-center gap-1">
        <Eye className="h-3 w-3" />
        Draft
      </Badge>;
    case "review":
      return <Badge variant="default" className="flex items-center gap-1">
        <CheckCircle className="h-3 w-3" />
        Ready to Publish
      </Badge>;
    case "published":
      return <Badge variant="default" className="flex items-center gap-1 bg-green-600">
        <Send className="h-3 w-3" />
        Published
      </Badge>;
    case "error":
      return <Badge variant="destructive" className="flex items-center gap-1">
        <XCircle className="h-3 w-3" />
        Error
      </Badge>;
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
};

export default function AIGenerationPage({ leagueId }: AIGenerationPageProps) {
  const [selectedArticle, setSelectedArticle] = useState<Article | null>(null);
  const [activeTab, setActiveTab] = useState("generate");

  // Get league data
  const league = useQuery(api.leagues.getById, { id: leagueId });
  
  // Get all articles for this league (for management)
  const articles = useQuery(api.aiContent.getAllByLeague, { leagueId }) || [];

  // Debug logging
  console.log("Articles Query Result:", articles);
  console.log("Articles with generating status:", articles.filter(a => a.status === "generating"));

  // Mutations for article management
  const publishArticle = useMutation(api.aiContent.updateContentStatus);
  const deleteArticle = useMutation(api.aiContent.deleteContent);

  // Filter articles by status
  const generatingArticles = articles.filter(a => a.status === "generating");
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
    return <div>Loading...</div>;
  }

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <div className="p-2 bg-red-100 rounded-lg">
          <Sparkles className="h-6 w-6 text-red-600" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-gray-900">AI Content Generation</h1>
          <p className="text-gray-600">Create and manage AI-generated content for {league.name}</p>
        </div>
      </div>

      {/* Tabs for different sections */}
      <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
        <TabsList className="grid w-full grid-cols-4">
          <TabsTrigger value="generate" className="flex items-center gap-2">
            <Sparkles className="h-4 w-4" />
            Generate
          </TabsTrigger>
          <TabsTrigger value="generating" className="flex items-center gap-2">
            <RotateCcw className="h-4 w-4" />
            In Progress ({generatingArticles.length})
          </TabsTrigger>
          <TabsTrigger value="review" className="flex items-center gap-2">
            <Eye className="h-4 w-4" />
            Review ({draftArticles.length})
          </TabsTrigger>
          <TabsTrigger value="published" className="flex items-center gap-2">
            <Send className="h-4 w-4" />
            Published ({publishedArticles.length})
          </TabsTrigger>
        </TabsList>

        {/* Generate Content Tab */}
        <TabsContent value="generate" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Generate New Content</CardTitle>
              <CardDescription>
                Create AI-generated fantasy football content for your league
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ContentGenerator 
                leagueId={leagueId} 
                isCommissioner={league.role === "commissioner"} 
              />
            </CardContent>
          </Card>
        </TabsContent>

        {/* Generating Articles Tab */}
        <TabsContent value="generating" className="space-y-4">
          {generatingArticles.length === 0 ? (
            <Card>
              <CardContent className="flex items-center justify-center py-12 text-center">
                <div>
                  <RotateCcw className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
                  <p className="text-muted-foreground">No articles currently generating</p>
                </div>
              </CardContent>
            </Card>
          ) : (
            generatingArticles.map((article) => (
              <Card key={article._id}>
                <CardContent className="p-6">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="flex items-center gap-2 mb-2">
                        <h3 className="font-semibold">{article.title}</h3>
                        {getStatusBadge(article.status)}
                      </div>
                      <p className="text-sm text-muted-foreground">
                        {article.type} • {article.persona} • {article.metadata.credits_used} credits
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Started {new Date(article.createdAt).toLocaleString()}
                      </p>
                    </div>
                    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-red-600" />
                  </div>
                </CardContent>
              </Card>
            ))
          )}
        </TabsContent>

        {/* Review Articles Tab */}
        <TabsContent value="review" className="space-y-4">
          {draftArticles.length === 0 ? (
            <Card>
              <CardContent className="flex items-center justify-center py-12 text-center">
                <div>
                  <Eye className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
                  <p className="text-muted-foreground">No articles ready for review</p>
                </div>
              </CardContent>
            </Card>
          ) : (
            draftArticles.map((article) => (
              <Card key={article._id}>
                <CardContent className="p-6">
                  <div className="flex items-center justify-between mb-4">
                    <div>
                      <div className="flex items-center gap-2 mb-2">
                        <h3 className="font-semibold">{article.title}</h3>
                        {getStatusBadge(article.status)}
                      </div>
                      <p className="text-sm text-muted-foreground">
                        {article.type} • {article.persona} • {article.metadata.credits_used} credits
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Generated {new Date(article.createdAt).toLocaleString()}
                      </p>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setSelectedArticle(selectedArticle?._id === article._id ? null : article)}
                      >
                        {selectedArticle?._id === article._id ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                        {selectedArticle?._id === article._id ? "Hide" : "Preview"}
                      </Button>
                      <Button
                        size="sm"
                        onClick={() => handlePublishArticle(article._id)}
                      >
                        <Send className="h-4 w-4 mr-2" />
                        Publish
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleDeleteArticle(article._id)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                  
                  {selectedArticle?._id === article._id && (
                    <div className="mt-4 p-4 bg-gray-50 rounded-lg">
                      <div className="prose prose-sm max-w-none">
                        <div dangerouslySetInnerHTML={{ __html: article.content.replace(/\n/g, '<br>') }} />
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            ))
          )}
        </TabsContent>

        {/* Published Articles Tab */}
        <TabsContent value="published" className="space-y-4">
          {publishedArticles.length === 0 ? (
            <Card>
              <CardContent className="flex items-center justify-center py-12 text-center">
                <div>
                  <Send className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
                  <p className="text-muted-foreground">No published articles yet</p>
                </div>
              </CardContent>
            </Card>
          ) : (
            publishedArticles.map((article) => (
              <Card key={article._id}>
                <CardContent className="p-6">
                  <div className="flex items-center justify-between mb-4">
                    <div>
                      <div className="flex items-center gap-2 mb-2">
                        <h3 className="font-semibold">{article.title}</h3>
                        {getStatusBadge(article.status)}
                      </div>
                      <p className="text-sm text-muted-foreground">
                        {article.type} • {article.persona} • {article.metadata.credits_used} credits
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Published {article.publishedAt ? new Date(article.publishedAt).toLocaleString() : "Unknown"}
                      </p>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setSelectedArticle(selectedArticle?._id === article._id ? null : article)}
                      >
                        {selectedArticle?._id === article._id ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                        {selectedArticle?._id === article._id ? "Hide" : "View"}
                      </Button>
                    </div>
                  </div>
                  
                  {selectedArticle?._id === article._id && (
                    <div className="mt-4 p-4 bg-gray-50 rounded-lg">
                      <div className="prose prose-sm max-w-none">
                        <div dangerouslySetInnerHTML={{ __html: article.content.replace(/\n/g, '<br>') }} />
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            ))
          )}
        </TabsContent>
      </Tabs>

      {/* Error Articles (show if any exist) */}
      {errorArticles.length > 0 && (
        <Card className="border-red-200">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-red-700">
              <XCircle className="h-5 w-5" />
              Failed Generations ({errorArticles.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {errorArticles.map((article) => (
                <div key={article._id} className="flex items-center justify-between p-3 bg-red-50 rounded-lg">
                  <div>
                    <p className="font-medium text-red-900">{article.title}</p>
                    <p className="text-sm text-red-700">
                      {article.type} • {article.persona}
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleDeleteArticle(article._id)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}