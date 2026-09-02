"use client";

import React, { useState, useRef, useEffect } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../../../../../convex/_generated/api";
import { Id } from "../../../../../../convex/_generated/dataModel";
import { useUser } from "@clerk/nextjs";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  MessageCircle,
  Send,
  Clock,
  AlertCircle,
  ArrowLeft
} from "lucide-react";
import { toast } from "sonner";
import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import { PageHeader, Panel, SectionHeader, Chip, EmptyState, LoadingScreen, PersonaAvatar, Spinner } from "@/components/broadcast";
import { QuoteApproval } from "@/components/QuoteApproval";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

interface CommentRequestPageProps {
  params: Promise<{
    id: string;
    requestId: string;
  }>;
}

type RequestStatus = "pending" | "active" | "completed" | "expired" | "declined" | "cancelled";

const STATUS_CHIP: Record<RequestStatus, { variant: "outline" | "signal" | "win" | "muted"; label: string; live?: boolean }> = {
  pending: { variant: "outline", label: "Pending" },
  active: { variant: "signal", label: "Active", live: true },
  completed: { variant: "win", label: "Answered" },
  expired: { variant: "muted", label: "Went to print" },
  declined: { variant: "muted", label: "No comment" },
  cancelled: { variant: "muted", label: "Cancelled" },
};

/** Sam Ortega conducts every comment-request interview (spec §1.2). */
const INTERVIEWER_SLUG = "sam-ortega";
const INTERVIEWER_NAME = "Sam Ortega";

/** `commentConversations.messageType` for the quote sign-off message (spec §8.1). */
const QUOTE_APPROVAL_MESSAGE = "quote_approval";

function deadlineLabel(timestamp?: number) {
  if (!timestamp) return null;
  return new Date(timestamp).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
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

  // Resolve the request by id, not through the active-only list: a completed,
  // declined or expired request still has to render its own state.
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
  const declineRequest = useMutation(api.commentConversations.declineCommentRequest);

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

  // "No comment" - honored immediately and permanently.
  const handleDecline = async () => {
    if (isSubmitting) return;
    setIsSubmitting(true);
    try {
      await declineRequest({ commentRequestId: requestId });
      toast.success("Noted - you declined to comment.");
    } catch (error) {
      console.error("Error declining comment request:", error);
      toast.error("Could not record that. Please try again.");
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
    requestById === undefined;

  if (isLoading) {
    return (
      <div className="min-h-screen bg-bc-ground">
        <LoadingScreen message="Loading conversation" />
      </div>
    );
  }

  const currentRequest = requestById;

  // Check authorization - only target user can respond
  if (!user || !currentRequest || !currentUser || currentUser._id !== currentRequest.targetUserId) {
    return (
      <div className="min-h-screen bg-bc-ground">
        <div className="mx-auto max-w-md px-4 py-16 sm:px-6">
          <EmptyState
            icon={<AlertCircle className="size-6" strokeWidth={1.8} />}
            title="Access denied"
            description="You don't have permission to respond to this comment request."
            action={
              <Link href={`/leagues/${leagueId}`}>
                <Button variant="outline">
                  <ArrowLeft className="size-4" />
                  Back to league
                </Button>
              </Link>
            }
          />
        </div>
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

  const statusChip = STATUS_CHIP[currentRequest.status as RequestStatus] ?? STATUS_CHIP.pending;

  return (
    <div className="min-h-screen bg-bc-ground">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-10 sm:px-6 sm:py-12 lg:px-12">
        {/* Header */}
        <div className="flex items-center justify-between">
          <Link href={`/leagues/${leagueId}`}>
            <Button variant="ghost" size="sm">
              <ArrowLeft className="size-4" />
              Back to league
            </Button>
          </Link>
          <Chip variant={statusChip.variant} live={statusChip.live}>{statusChip.label}</Chip>
        </div>

        <PageHeader
          kicker={`${INTERVIEWER_NAME} · FFSN sideline`}
          title="Reaching out for comment"
          description="On the record. You'll be quoted with your name and team, in your own words."
        />

        {/* Deadline */}
        {currentRequest.articleGenerationTime && (
          (() => {
            const timeUntilGeneration = currentRequest.articleGenerationTime - Date.now();
            const hoursUntilGeneration = timeUntilGeneration / (1000 * 60 * 60);
            const printTime = deadlineLabel(currentRequest.articleGenerationTime);

            if (hoursUntilGeneration <= 24 && hoursUntilGeneration > 0) {
              return (
                <div className="border-l-4 border-l-bc-signal bg-bc-panel-2 p-4">
                  <div className="flex items-center gap-3">
                    <Clock className="size-5 flex-none text-bc-signal" />
                    <div>
                      <h3 className="font-display text-[15px] font-bold uppercase tracking-[0.02em] text-bc-ink">
                        Deadline {printTime}
                      </h3>
                      <p className="mt-1 text-sm text-bc-text-2">
                        We go to print {formatDistanceToNow(new Date(currentRequest.articleGenerationTime), { addSuffix: true })}.
                        {hoursUntilGeneration <= 1
                          ? " After that the story runs with what we have."
                          : " Anything you send before then can run in it."}
                      </p>
                    </div>
                  </div>
                </div>
              );
            }
            return null;
          })()
        )}

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          {/* Request Details */}
          <Panel padding="md" className="self-start lg:col-span-1">
            <SectionHeader size="sm" title="Request details" kicker="Context for the requested content" />
            <div className="mt-5 flex flex-col gap-4">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="border border-bc-hairline bg-bc-panel-2 p-3">
                  <h4 className="bc-label-sm text-bc-text-3">Content type</h4>
                  <p className="mt-1 text-sm text-bc-ink">
                    {getContentTypeDisplay(currentRequest.contentType)}
                  </p>
                </div>
                <div className="border border-bc-hairline bg-bc-panel-2 p-3">
                  <h4 className="bc-label-sm text-bc-text-3">Deadline</h4>
                  <p className="mt-1 flex items-center gap-1.5 text-sm text-bc-ink">
                    <Clock className="size-3.5 text-bc-text-3" />
                    {currentRequest.articleGenerationTime
                      ? `${deadlineLabel(currentRequest.articleGenerationTime)} · ${formatDistanceToNow(new Date(currentRequest.articleGenerationTime), { addSuffix: true })}`
                      : "Not scheduled"}
                  </p>
                </div>
              </div>

              {currentRequest.articleContext?.topic && (
                <div className="border border-bc-hairline bg-bc-panel-2 p-3">
                  <h4 className="bc-label-sm mb-1 text-bc-text-3">Topic</h4>
                  <p className="text-sm text-bc-ink">
                    {currentRequest.articleContext.topic}
                  </p>
                </div>
              )}

              {currentRequest.articleContext?.focusAreas && currentRequest.articleContext.focusAreas.length > 0 && (
                <div className="border border-bc-hairline bg-bc-panel-2 p-3">
                  <h4 className="bc-label-sm mb-2 text-bc-text-3">Focus areas</h4>
                  <div className="flex flex-wrap gap-2">
                    {currentRequest.articleContext.focusAreas.map((area, index) => (
                      <Badge key={index} variant="outline">
                        {area}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </Panel>

          {/* Conversation */}
          <Panel padding="none" className="flex flex-col lg:col-span-2">
            <div className="border-b border-bc-hairline px-4 py-4 sm:px-6">
              <div className="flex items-center gap-2 font-display text-[18px] font-bold uppercase tracking-[0.01em] text-bc-ink">
                <MessageCircle className="size-5" />
                {INTERVIEWER_NAME} ({messages.length} messages)
              </div>
            </div>
            <div className="flex flex-1 flex-col">
              <ScrollArea className="h-[55vh] px-3 py-3 sm:h-[60vh] sm:px-4">
                <div className="flex flex-col gap-4">
                  {messages.length === 0 ? (
                    <EmptyState
                      icon={<MessageCircle className="size-6" strokeWidth={1.8} />}
                      title="No messages yet"
                      description="Start the conversation by sending a response."
                    />
                  ) : (
                    <>
                      {messages.map((message) => {
                        const isUser = message.messageType === "user_response";
                        // Sam's "here's what we'll quote you saying" message carries the
                        // sign-off cards (spec §8.1). Compared as a string so this file
                        // doesn't depend on codegen ordering.
                        const isQuoteApproval =
                          (message.messageType as string) === QUOTE_APPROVAL_MESSAGE;
                        return (
                          <div key={message._id} className="flex flex-col gap-3">
                            <div
                              className={cn("flex items-end gap-3", isUser && "flex-row-reverse")}
                            >
                              {!isUser && (
                                <PersonaAvatar persona={INTERVIEWER_SLUG} size={32} className="flex-none border border-bc-border-strong" />
                              )}

                              <div className={cn("flex-1", isUser && "text-right")}>
                                <div
                                  className={cn(
                                    "inline-block max-w-[80%] px-4 py-2 text-sm sm:text-base",
                                    isUser ? "bc-cut-sm bg-bc-plate text-bc-plate-fg" : "bg-bc-panel-2 text-bc-ink"
                                  )}
                                >
                                  <p className="whitespace-pre-wrap text-left leading-relaxed">{message.content}</p>
                                </div>
                                <p className="mt-1 text-xs text-bc-text-3">
                                  {formatDistanceToNow(new Date(message.createdAt), { addSuffix: true })}
                                </p>
                              </div>
                            </div>

                            {isQuoteApproval && (
                              <QuoteApproval commentRequestId={requestId} className="sm:ml-11" />
                            )}
                          </div>
                        );
                      })}
                      {/* AI typing indicator */}
                      {(() => {
                        const last = messages[messages.length - 1];
                        const isAiTyping = last && last.messageType === "user_response" && currentRequest.status === "active";
                        if (!isAiTyping) return null;
                        return (
                          <div className="flex items-end gap-3">
                            <PersonaAvatar persona={INTERVIEWER_SLUG} size={32} className="flex-none border border-bc-border-strong" />
                            <div className="flex-1">
                              <div className="inline-block max-w-[80%] bg-bc-panel-2 px-4 py-2 text-bc-ink">
                                <div className="flex items-center gap-2 text-bc-text-2">
                                  <Spinner size={14} />
                                  <span>{INTERVIEWER_NAME} is typing&hellip;</span>
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

              <div className="border-t border-bc-hairline p-3 sm:p-4">
                {/* Response Form */}
                <form onSubmit={handleSubmit} className="flex flex-col gap-3">
                  <div>
                    <label htmlFor="response" className="sr-only">Your Response</label>
                    <Textarea
                      id="response"
                      value={response}
                      onChange={(e) => setResponse(e.target.value)}
                      onKeyDown={handleKeyDown}
                      placeholder="Anything you want on the record?"
                      rows={3}
                      className="w-full resize-none text-sm sm:text-base"
                      disabled={isSubmitting || currentRequest.status !== "active"}
                    />
                  </div>

                  <div className="flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center">
                    <div className="w-full sm:w-auto">
                      <div className="mb-1 flex items-center justify-between text-xs text-bc-text-3">
                        <span>Character limit</span>
                        <span className="bc-num">{Math.min(response.length, 1000)}/1000</span>
                      </div>
                      <Progress value={Math.min((response.length / 1000) * 100, 100)} className="h-1.5 w-full sm:w-48" />
                    </div>
                    <div className="flex w-full items-center gap-2 sm:w-auto">
                      <Button
                        type="button"
                        variant="outline"
                        onClick={handleDecline}
                        disabled={isSubmitting || currentRequest.status !== "active"}
                        className="flex-1 sm:flex-none"
                      >
                        No comment
                      </Button>
                      <Button
                        type="submit"
                        disabled={!response.trim() || isSubmitting || response.length > 1000 || currentRequest.status !== "active"}
                        className="min-w-[120px] flex-1 sm:flex-none"
                      >
                        {isSubmitting ? <Spinner size={14} className="[&>span]:bg-white" /> : <Send className="size-4" />}
                        {isSubmitting ? "Sending" : "Send response"}
                      </Button>
                    </div>
                  </div>

                  {currentRequest.status !== "active" && (
                    <div className="border-l-2 border-l-bc-red-deep bg-bc-panel-2 p-3">
                      <p className="text-sm text-bc-text-2">
                        {currentRequest.status === "declined"
                          ? "You declined to comment. Nothing here will be quoted."
                          : currentRequest.status === "completed"
                          ? "Thanks. Your words go to the desk exactly as you typed them."
                          : "This one has gone to print. You can still read the thread."}
                      </p>
                    </div>
                  )}
                </form>
              </div>
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}
