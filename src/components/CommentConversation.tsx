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
import { cn } from "@/lib/utils";

interface CommentConversationProps {
  commentRequestId: Id<"commentRequests">;
  onClose?: () => void;
}

function titleCase(value?: string) {
  return value?.replace(/_/g, " ").replace(/\b\w/g, (l) => l.toUpperCase());
}

export default function CommentConversation({ commentRequestId, onClose }: CommentConversationProps) {
  const [message, setMessage] = useState("");
  const [isSending, setIsSending] = useState(false);
  const scrollAreaRef = useRef<HTMLDivElement>(null);

  // Get conversation messages
  const messages = useQuery(api.commentConversations.getConversation, {
    commentRequestId,
  });

  // Get request details for the signed-in user. getActiveRequests derives
  // the target user from the caller's own identity server-side.
  const requests = useQuery(api.commentConversations.getActiveRequests, {});

  const currentRequest = requests?.find(r => r._id === commentRequestId);

  // Send message mutation
  const sendResponse = useMutation(api.commentConversations.sendUserResponse);

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

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  if (!messages || !currentRequest) {
    return (
      <Panel padding="lg" className="mx-auto flex w-full max-w-2xl items-center justify-center">
        <Spinner size={22} />
      </Panel>
    );
  }

  const isExpired = currentRequest.status === "expired";
  const isCompleted = currentRequest.status === "completed";

  return (
    <Panel padding="none" className="mx-auto w-full max-w-2xl">
      <div className="flex items-start justify-between gap-4 border-b border-bc-hairline px-4 py-3 sm:px-6 sm:py-4">
        <div>
          <div className="flex items-center gap-2 font-display text-[18px] font-bold uppercase tracking-[0.01em] text-bc-ink sm:text-[20px]">
            <MessageSquare className="size-5" />
            Comment request: {titleCase(currentRequest.articleType)}
          </div>
          <p className="mt-1 text-sm text-bc-text-2">
            {currentRequest.leagueName} &middot; Week {currentRequest.articleContext?.week}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {isExpired && <Chip variant="muted">Expired</Chip>}
          {isCompleted && <Chip variant="win">Answered</Chip>}
          {!isExpired && !isCompleted && <Chip variant="signal" live>Active</Chip>}
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
              <div
                key={msg._id}
                className={cn("flex items-end gap-2", isUser ? "justify-end" : "justify-start")}
              >
                {!isUser && (
                  <PersonaAvatar persona="FFSN AI" size={28} className="flex-none border border-bc-border-strong" />
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
            );
          })}
          {/* AI typing indicator */}
          {(() => {
            const last = messages[messages.length - 1];
            const isAiTyping = last && last.messageType === "user_response" && !isExpired && !isCompleted;
            if (!isAiTyping) return null;
            return (
              <div className="flex items-end gap-2">
                <PersonaAvatar persona="FFSN AI" size={28} className="flex-none border border-bc-border-strong" />
                <div className="max-w-[80%] bg-bc-panel-2 px-4 py-2 text-bc-ink">
                  <div className="flex items-center gap-2 text-bc-text-2">
                    <Spinner size={14} />
                    <span>AI is replying&hellip;</span>
                  </div>
                </div>
              </div>
            );
          })()}
        </div>
      </ScrollArea>

      {!isExpired && !isCompleted && (
        <div className="border-t border-bc-hairline p-3 sm:p-4">
          <Textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyPress={handleKeyPress}
            placeholder="Share your thoughts about this week's games..."
            className="w-full resize-none text-sm sm:text-base"
            rows={3}
            disabled={isSending}
          />
          <div className="mt-2 flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center">
            <p className="text-xs text-bc-text-3">
              Press Enter to send, Shift+Enter for new line
            </p>
            <Button
              onClick={handleSend}
              disabled={!message.trim() || isSending}
              size="sm"
              className="w-full sm:w-auto"
            >
              {isSending ? <Spinner size={14} className="[&>span]:bg-white" /> : <Send className="size-4" />}
              Send
            </Button>
          </div>
        </div>
      )}

      {(isExpired || isCompleted) && (
        <div className="border-t border-bc-hairline p-3 sm:p-4">
          <p className="text-center text-sm text-bc-text-2">
            {isExpired
              ? "This comment request has expired. The article will be generated without your input."
              : "Thank you for your input! Your comments will be included in the article."}
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
