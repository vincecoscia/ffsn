"use client";

import React, { useState, useRef, useEffect } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../../../../../convex/_generated/api";
import { Id } from "../../../../../../convex/_generated/dataModel";
import { useUser } from "@clerk/nextjs";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  MessageCircle,
  Send,
  Clock,
  User,
  Bot,
  Loader2,
  AlertCircle,
  ArrowLeft
} from "lucide-react";
import { toast } from "sonner";
import Link from "next/link";
import { formatDistanceToNow } from "date-fns";

interface CommentRequestPageProps {
  params: Promise<{ 
    id: string;
    requestId: string;
  }>;
}

export default function CommentRequestPage({ params }: CommentRequestPageProps) {
  const resolvedParams = React.use(params);
  const leagueId = resolvedParams.id as Id<"leagues">;
  const requestId = resolvedParams.requestId as Id<"commentRequests">;
  
  const { user } = useUser();
  const [response, setResponse] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Get current user's Convex user ID first
  const currentUser = useQuery(api.users.getCurrentUser);
  
  // Get comment request details and context - only if we have current user
  const requestDetails = useQuery(api.commentConversations.getActiveRequests, 
    currentUser ? { userId: currentUser._id } : "skip"
  );
  
  // Also fetch the request directly by ID regardless of status for view-only scenarios
  const requestById = useQuery(api.commentRequests.getRequestById, {
    commentRequestId: requestId,
  });
  
  // Removed unused requestContext query

  // Get conversation messages with real-time updates
  const messages = useQuery(api.commentConversations.getConversation, {
    commentRequestId: requestId,
  });

  // Send user response mutation
  const sendResponse = useMutation(api.commentConversations.sendUserResponse);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Handle form submission
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!response.trim() || isSubmitting) return;

    setIsSubmitting(true);
    try {
      await sendResponse({
        commentRequestId: requestId,
        content: response.trim(),
      });
      setResponse("");
      toast.success("Response sent successfully!");
    } catch (error) {
      console.error("Error sending response:", error);
      toast.error("Failed to send response. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  };

  // Handle textarea keyboard shortcuts
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  // Loading state: only show spinner while queries are loading (undefined)
  const isLoading =
    currentUser === undefined ||
    messages === undefined ||
    requestById === undefined ||
    (!!currentUser && requestDetails === undefined);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[400px] px-4">
        <div className="flex items-center gap-3 text-gray-600">
          <Loader2 className="h-6 w-6 animate-spin" />
          <span className="text-lg">Loading conversation...</span>
        </div>
      </div>
    );
  }

  // Find the specific request from active requests
  const currentRequest = (requestDetails ?? []).find(req => req._id === requestId) || requestById || null;
  
  // Check authorization - only target user can respond
  if (!user || !currentRequest || !currentUser || currentUser._id !== currentRequest.targetUserId) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <Card className="w-full max-w-md">
          <CardContent className="pt-6">
            <div className="flex flex-col items-center gap-4 text-center">
              <AlertCircle className="h-12 w-12 text-red-500" />
              <div>
                <h3 className="text-lg font-semibold text-gray-900">Access Denied</h3>
                <p className="text-gray-600 mt-2">
                  You don&apos;t have permission to respond to this comment request.
                </p>
              </div>
              <Link href={`/leagues/${leagueId}`}>
                <Button variant="outline">
                  <ArrowLeft className="h-4 w-4 mr-2" />
                  Back to League
                </Button>
              </Link>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Get content type display name
  const getContentTypeDisplay = (type: string) => {
    switch (type) {
      case "power_rankings": return "Power Rankings";
      case "weekly_recap": return "Weekly Recap";
      case "waiver_analysis": return "Waiver Analysis";
      case "trade_analysis": return "Trade Analysis";
      case "playoff_preview": return "Playoff Preview";
      default: return type.replace(/_/g, " ").replace(/\b\w/g, l => l.toUpperCase());
    }
  };


  return (
    <div className="max-w-6xl mx-auto space-y-6 px-3 sm:px-4">
      {/* Header */}
      <div className="rounded-xl border bg-gradient-to-r from-white to-red-50 p-4 sm:p-6">
        <div className="flex flex-col gap-3 sm:gap-4">
          <div className="flex items-center justify-between">
            <Link href={`/leagues/${leagueId}`}>
              <Button variant="ghost" size="sm" className="-ml-2">
                <ArrowLeft className="h-4 w-4 mr-2" />
                Back to League
              </Button>
            </Link>
            <Badge variant={currentRequest.status === "active" ? "default" : "secondary"}>
              {currentRequest.status}
            </Badge>
          </div>
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold text-gray-900 flex items-center gap-3">
              <MessageCircle className="h-7 w-7 text-red-600" />
              Comment Request
            </h1>
            <p className="text-gray-700 mt-1 text-sm sm:text-base">
              Share your insights for upcoming content
            </p>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Request Details */}
        <Card className="lg:col-span-1 self-start">
          <CardHeader>
            <CardTitle>Request Details</CardTitle>
            <CardDescription>Context for the requested content</CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="rounded-lg border p-3 bg-white">
                <h4 className="font-medium text-gray-900 text-sm">Content Type</h4>
                <p className="text-gray-700 mt-1 text-sm">
                  {getContentTypeDisplay(currentRequest.contentType)}
                </p>
              </div>
              <div className="rounded-lg border p-3 bg-white">
                <h4 className="font-medium text-gray-900 text-sm">Scheduled For</h4>
                <p className="text-gray-700 mt-1 text-sm flex items-center gap-1">
                  <Clock className="h-4 w-4" />
                  {currentRequest.scheduledTime
                    ? formatDistanceToNow(new Date(currentRequest.scheduledTime), { addSuffix: true })
                    : "Not scheduled"}
                </p>
              </div>
            </div>

            {currentRequest.articleContext?.topic && (
              <div className="rounded-lg border p-3 bg-white">
                <h4 className="font-medium text-gray-900 text-sm mb-1">Topic</h4>
                <p className="text-gray-700 text-sm">
                  {currentRequest.articleContext.topic}
                </p>
              </div>
            )}

            {currentRequest.articleContext?.focusAreas && currentRequest.articleContext.focusAreas.length > 0 && (
              <div className="rounded-lg border p-3 bg-white">
                <h4 className="font-medium text-gray-900 text-sm mb-2">Focus Areas</h4>
                <div className="flex flex-wrap gap-2">
                  {currentRequest.articleContext.focusAreas.map((area, index) => (
                    <Badge key={index} variant="outline" className="px-2 py-0.5 text-xs">
                      {area}
                    </Badge>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Conversation */}
        <Card className="lg:col-span-2 flex flex-col">
          <CardHeader className="border-b">
            <CardTitle className="flex items-center gap-2">
              <MessageCircle className="h-5 w-5" />
              Conversation ({messages.length} messages)
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0 flex flex-col">
            <ScrollArea className="h-[55vh] sm:h-[60vh] px-3 sm:px-4 py-3">
              <div className="space-y-4">
                {messages.length === 0 ? (
                  <div className="text-center py-10 text-gray-500">
                    <MessageCircle className="h-12 w-12 mx-auto mb-3 text-gray-300" />
                    <p>No messages yet. Start the conversation by sending a response!</p>
                  </div>
                ) : (
                  <>
                    {messages.map((message) => (
                      <div
                        key={message._id}
                        className={`flex gap-3 ${
                          message.messageType === "user_response" ? "flex-row-reverse" : ""
                        }`}
                      >
                        <Avatar className="h-8 w-8 flex-shrink-0">
                          <AvatarFallback className={
                            message.messageType === "user_response"
                              ? "bg-blue-100 text-blue-600"
                              : "bg-purple-100 text-purple-600"
                          }>
                            {message.messageType === "user_response" ? (
                              <User className="h-4 w-4" />
                            ) : (
                              <Bot className="h-4 w-4" />
                            )}
                          </AvatarFallback>
                        </Avatar>

                        <div className={`flex-1 ${
                          message.messageType === "user_response" ? "text-right" : ""
                        }`}>
                          <div className={`inline-block max-w-[80%] px-4 py-2 rounded-2xl text-sm sm:text-base shadow-sm ${
                            message.messageType === "user_response"
                              ? "bg-blue-500 text-white"
                              : "bg-gray-100 text-gray-900"
                          }`}>
                            <p className="whitespace-pre-wrap leading-relaxed">{message.content}</p>
                          </div>
                          <p className="text-xs text-gray-500 mt-1">
                            {formatDistanceToNow(new Date(message.createdAt), { addSuffix: true })}
                          </p>
                        </div>
                      </div>
                    ))}
                    {/* AI typing indicator */}
                    {(() => {
                      const last = messages[messages.length - 1];
                      const isAiTyping = last && last.messageType === "user_response" && currentRequest.status === "active";
                      if (!isAiTyping) return null;
                      return (
                        <div className="flex gap-3">
                          <Avatar className="h-8 w-8 flex-shrink-0">
                            <AvatarFallback className="bg-purple-100 text-purple-600">
                              <Bot className="h-4 w-4" />
                            </AvatarFallback>
                          </Avatar>
                          <div className="flex-1">
                            <div className="inline-block max-w-[80%] px-4 py-2 rounded-2xl bg-gray-100 text-gray-900 shadow-sm">
                              <div className="flex items-center gap-2 text-gray-600">
                                <Loader2 className="h-4 w-4 animate-spin" />
                                <span>AI is replying...</span>
                              </div>
                            </div>
                          </div>
                        </div>
                      );
                    })()}
                    <div ref={messagesEndRef} />
                  </>
                )}
              </div>
            </ScrollArea>

            <div className="border-t p-3 sm:p-4 bg-background/60 backdrop-blur supports-[backdrop-filter]:bg-background/60">
              {/* Response Form */}
              <form onSubmit={handleSubmit} className="space-y-3">
                <div>
                  <label htmlFor="response" className="sr-only">Your Response</label>
                  <Textarea
                    id="response"
                    value={response}
                    onChange={(e) => setResponse(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder="Share your thoughts, insights, or answer the AI's questions..."
                    rows={3}
                    className="w-full resize-none text-sm sm:text-base"
                    disabled={isSubmitting || currentRequest.status !== "active"}
                  />
                </div>

                <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
                  <div className="w-full sm:w-auto">
                    <div className="flex items-center justify-between text-xs text-gray-600 mb-1">
                      <span>Character limit</span>
                      <span>{Math.min(response.length, 1000)}/1000</span>
                    </div>
                    <Progress value={Math.min((response.length / 1000) * 100, 100)} className="h-1.5" />
                  </div>
                  <Button
                    type="submit"
                    disabled={!response.trim() || isSubmitting || response.length > 1000 || currentRequest.status !== "active"}
                    className="min-w-[120px] w-full sm:w-auto"
                  >
                    {isSubmitting ? (
                      <>
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        Sending...
                      </>
                    ) : (
                      <>
                        <Send className="h-4 w-4 mr-2" />
                        Send Response
                      </>
                    )}
                  </Button>
                </div>

                {currentRequest.status !== "active" && (
                  <div className="p-3 bg-yellow-50 border border-yellow-200 rounded-md">
                    <p className="text-sm text-yellow-800">
                      This comment request is no longer active. You cannot send new responses.
                    </p>
                  </div>
                )}
              </form>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}