"use client";

import { useState, useRef, useEffect } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Send, MessageSquare } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { Panel, Chip, PersonaAvatar, Spinner } from "@/components/broadcast";
import { QuoteApproval } from "@/components/QuoteApproval";
import { cn } from "@/lib/utils";

interface CommentConversationProps {
  commentRequestId: Id<"commentRequests">;
  onClose?: () => void;
}

/** Sam Ortega conducts every comment-request interview (spec §1.2). */
const INTERVIEWER_SLUG = "sam-ortega";
const INTERVIEWER_NAME = "Sam Ortega";

/** `commentConversations.messageType` for the quote sign-off message (spec §8.1). */
const QUOTE_APPROVAL_MESSAGE = "quote_approval";

function titleCase(value?: string) {
  return value?.replace(/_/g, " ").replace(/\b\w/g, (l) => l.toUpperCase());
}

function deadlineLabel(timestamp?: number) {
  if (!timestamp) return null;
  return new Date(timestamp).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function CommentConversation({ commentRequestId, onClose }: CommentConversationProps) {
  const [message, setMessage] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [isDeclining, setIsDeclining] = useState(false);
  const scrollAreaRef = useRef<HTMLDivElement>(null);

  // Get conversation messages
  const messages = useQuery(api.commentConversations.getConversation, {
    commentRequestId,
  });

  // Resolve the request by id rather than through the active-only list: a completed,
  // declined or expired request must still render its own state instead of spinning
  // forever behind a filter that no longer matches it.
  const currentRequest = useQuery(api.commentRequests.getRequestById, {
    commentRequestId,
  });

  const sendResponse = useMutation(api.commentConversations.sendUserResponse);
  const declineRequest = useMutation(api.commentConversations.declineCommentRequest);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    if (scrollAreaRef.current) {
      scrollAreaRef.current.scrollTop = scrollAreaRef.current.scrollHeight;
    }
  }, [messages]);

  const handleSend = async () => {
    if (!message.trim() || isSending) return;

    setIsSending(true);
    try {
      await sendResponse({
        commentRequestId,
        content: message.trim(),
      });
      setMessage("");
    } catch (error) {
      console.error("Failed to send message:", error);
    } finally {
      setIsSending(false);
    }
  };

  const handleDecline = async () => {
    if (isDeclining) return;
    setIsDeclining(true);
    try {
      await declineRequest({ commentRequestId });
    } catch (error) {
      console.error("Failed to decline comment request:", error);
    } finally {
      setIsDeclining(false);
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  if (messages === undefined || currentRequest === undefined) {
    return (
      <Panel padding="lg" className="mx-auto flex w-full max-w-2xl items-center justify-center">
        <Spinner size={22} />
      </Panel>
    );
  }

  if (currentRequest === null) {
    return (
      <Panel padding="lg" className="mx-auto w-full max-w-2xl">
        <p className="text-center text-sm text-bc-text-2">
          This comment request is no longer available.
        </p>
      </Panel>
    );
  }

  const isExpired = currentRequest.status === "expired";
  const isCompleted = currentRequest.status === "completed";
  const isDeclined = currentRequest.status === "declined";
  const isOpen = !isExpired && !isCompleted && !isDeclined;
  const printTime = deadlineLabel(currentRequest.articleGenerationTime);

  // The disclosure sits under Sam's opener, where the manager reads it before typing.
  const firstInterviewerMessageId = messages.find((m) => m.messageType === "ai_question")?._id;

  return (
    <Panel padding="none" className="mx-auto w-full max-w-2xl">
      <div className="flex items-start justify-between gap-4 border-b border-bc-hairline px-4 py-3 sm:px-6 sm:py-4">
        <div className="flex items-start gap-3">
          <PersonaAvatar
            persona={INTERVIEWER_SLUG}
            size={36}
            className="mt-0.5 flex-none border border-bc-border-strong"
          />
          <div>
            <div className="flex items-center gap-2 font-display text-[18px] font-bold uppercase tracking-[0.01em] text-bc-ink sm:text-[20px]">
              <MessageSquare className="size-5" />
              {INTERVIEWER_NAME}
            </div>
            <p className="mt-1 text-sm text-bc-text-2">
              FFSN sideline &middot; {titleCase(currentRequest.contentType)}
              {currentRequest.articleContext?.week
                ? ` · Week ${currentRequest.articleContext.week}`
                : ""}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {isExpired && <Chip variant="muted">Expired</Chip>}
          {isCompleted && <Chip variant="win">Answered</Chip>}
          {isDeclined && <Chip variant="muted">No comment</Chip>}
          {isOpen && <Chip variant="signal" live>Active</Chip>}
        </div>
      </div>

      <ScrollArea
        ref={scrollAreaRef}
        className="h-[60vh] p-3 sm:h-[400px] sm:p-4"
      >
        <div className="flex flex-col gap-4">
          {messages.map((msg) => {
            const isUser = msg.messageType === "user_response";
            return (
              <div key={msg._id} className="flex flex-col gap-2">
                <div className={cn("flex items-end gap-2", isUser ? "justify-end" : "justify-start")}>
                  {!isUser && (
                    <PersonaAvatar
                      persona={INTERVIEWER_SLUG}
                      size={28}
                      className="flex-none border border-bc-border-strong"
                    />
                  )}
                  <div
                    className={cn(
                      "max-w-[85%] px-3 py-2 text-sm sm:max-w-[80%] sm:px-4 sm:text-base",
                      isUser
                        ? "bc-cut-sm bg-bc-plate text-bc-plate-fg"
                        : msg.messageType === "system_message"
                        ? "bg-bc-panel-2 italic text-bc-text-2"
                        : "bg-bc-panel-2 text-bc-ink"
                    )}
                  >
                    <p className="whitespace-pre-wrap">{msg.content}</p>
                    <p className={cn("mt-1 text-xs", isUser ? "text-bc-plate-fg/70" : "text-bc-text-3")}>
                      {formatDistanceToNow(new Date(msg.createdAt), { addSuffix: true })}
                    </p>
                  </div>
                </div>

                {msg._id === firstInterviewerMessageId && (
                  <p className="pl-9 text-xs uppercase tracking-[0.06em] text-bc-text-3">
                    On the record &middot; quoted with your name and team
                    {printTime ? ` · we go to print at ${printTime}` : ""}
                  </p>
                )}

                {/* Sam's "here's what we'll quote you saying" message carries the
                    sign-off cards (spec §8.1). The literal is compared as a string
                    so this file doesn't depend on codegen ordering. */}
                {(msg.messageType as string) === QUOTE_APPROVAL_MESSAGE && (
                  <QuoteApproval commentRequestId={commentRequestId} className="sm:ml-9" />
                )}
              </div>
            );
          })}
          {/* Interviewer typing indicator */}
          {(() => {
            const last = messages[messages.length - 1];
            const isTyping = last && last.messageType === "user_response" && isOpen;
            if (!isTyping) return null;
            return (
              <div className="flex items-end gap-2">
                <PersonaAvatar
                  persona={INTERVIEWER_SLUG}
                  size={28}
                  className="flex-none border border-bc-border-strong"
                />
                <div className="max-w-[80%] bg-bc-panel-2 px-4 py-2 text-bc-ink">
                  <div className="flex items-center gap-2 text-bc-text-2">
                    <Spinner size={14} />
                    <span>{INTERVIEWER_NAME} is typing&hellip;</span>
                  </div>
                </div>
              </div>
            );
          })()}
        </div>
      </ScrollArea>

      {isOpen && (
        <div className="border-t border-bc-hairline p-3 sm:p-4">
          <Textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyPress={handleKeyPress}
            placeholder="Anything you want on the record?"
            className="w-full resize-none text-sm sm:text-base"
            rows={3}
            disabled={isSending || isDeclining}
          />
          <div className="mt-2 flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center">
            <p className="text-xs text-bc-text-3">
              Press Enter to send, Shift+Enter for new line
            </p>
            <div className="flex w-full items-center gap-2 sm:w-auto">
              <Button
                variant="outline"
                onClick={handleDecline}
                disabled={isSending || isDeclining}
                size="sm"
                className="flex-1 sm:flex-none"
              >
                {isDeclining ? <Spinner size={14} /> : null}
                No comment
              </Button>
              <Button
                onClick={handleSend}
                disabled={!message.trim() || isSending || isDeclining}
                size="sm"
                className="flex-1 sm:flex-none"
              >
                {isSending ? <Spinner size={14} className="[&>span]:bg-white" /> : <Send className="size-4" />}
                Send
              </Button>
            </div>
          </div>
        </div>
      )}

      {!isOpen && (
        <div className="border-t border-bc-hairline p-3 sm:p-4">
          <p className="text-center text-sm text-bc-text-2">
            {isExpired
              ? "This one went to print without you. Nothing here will be quoted."
              : isDeclined
              ? "You declined to comment. The story may say so, and nothing here will be quoted."
              : "Thanks. Your words go to the desk exactly as you typed them."}
          </p>
          {onClose && (
            <Button
              variant="outline"
              onClick={onClose}
              className="mt-2 w-full"
            >
              Close
            </Button>
          )}
        </div>
      )}
    </Panel>
  );
}
