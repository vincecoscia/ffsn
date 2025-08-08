"use client";

import { useState, useRef, useEffect } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Loader2, Send, MessageSquare, Clock, CheckCircle2 } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { cn } from "@/lib/utils";

interface CommentConversationProps {
  commentRequestId: Id<"commentRequests">;
  onClose?: () => void;
}

export default function CommentConversation({ commentRequestId, onClose }: CommentConversationProps) {
  const [message, setMessage] = useState("");
  const [isSending, setIsSending] = useState(false);
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  
  // Get conversation messages
  const messages = useQuery(api.commentConversations.getConversation, {
    commentRequestId,
  });

  // Get request details
  const requests = useQuery(api.commentConversations.getActiveRequests, {
    userId: "" as Id<"users">, // This will be fixed by the component that uses this
  });

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
      <Card className="w-full max-w-2xl mx-auto">
        <CardContent className="flex items-center justify-center py-8">
          <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
        </CardContent>
      </Card>
    );
  }

  const isExpired = currentRequest.status === "expired";
  const isCompleted = currentRequest.status === "completed";

  return (
    <Card className="w-full max-w-2xl mx-auto">
      <CardHeader className="border-b px-4 py-3 sm:px-6 sm:py-4">
        <div className="flex items-start justify-between">
          <div>
            <CardTitle className="text-lg sm:text-xl font-semibold flex items-center gap-2">
              <MessageSquare className="h-5 w-5" />
              Comment Request: {currentRequest.articleType?.replace(/_/g, " ").replace(/\b\w/g, l => l.toUpperCase())}
            </CardTitle>
            <CardDescription className="mt-1 text-sm">
              {currentRequest.leagueName} • Week {currentRequest.articleContext?.week}
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            {isExpired && (
              <Badge variant="secondary" className="bg-gray-100">
                Expired
              </Badge>
            )}
            {isCompleted && (
              <Badge variant="secondary" className="bg-green-100 text-green-800">
                <CheckCircle2 className="h-3 w-3 mr-1" />
                Completed
              </Badge>
            )}
            {!isExpired && !isCompleted && (
              <Badge variant="secondary" className="bg-blue-100 text-blue-800">
                <Clock className="h-3 w-3 mr-1" />
                Active
              </Badge>
            )}
          </div>
        </div>
      </CardHeader>

      <CardContent className="p-0">
        <ScrollArea 
          ref={scrollAreaRef}
          className="h-[60vh] sm:h-[400px] p-3 sm:p-4"
        >
          <div className="space-y-4">
            {messages.map((msg) => (
              <div
                key={msg._id}
                className={cn(
                  "flex",
                  msg.messageType === "user_response" ? "justify-end" : "justify-start"
                )}
              >
                <div
                  className={cn(
                    "max-w-[85%] sm:max-w-[80%] rounded-lg px-3 py-2 sm:px-4",
                    msg.messageType === "user_response"
                      ? "bg-blue-500 text-white"
                      : msg.messageType === "system_message"
                      ? "bg-gray-100 text-gray-600 italic"
                      : "bg-gray-200 text-gray-900"
                  )}
                >
                  <p className="whitespace-pre-wrap text-sm sm:text-base">{msg.content}</p>
                  <p className={cn(
                    "text-xs mt-1",
                    msg.messageType === "user_response" 
                      ? "text-blue-100" 
                      : "text-gray-500"
                  )}>
                    {formatDistanceToNow(new Date(msg.createdAt), { addSuffix: true })}
                  </p>
                </div>
              </div>
            ))}
            {/* AI typing indicator */}
            {(() => {
              const last = messages[messages.length - 1];
              const isAiTyping = last && last.messageType === "user_response" && !isExpired && !isCompleted;
              if (!isAiTyping) return null;
              return (
                <div className="flex justify-start">
                  <div className={cn("max-w-[80%] rounded-lg px-4 py-2 bg-gray-200 text-gray-900")}
                  >
                    <div className="flex items-center gap-2 text-gray-600">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      <span>AI is replying...</span>
                    </div>
                  </div>
                </div>
              );
            })()}
          </div>
        </ScrollArea>

        {!isExpired && !isCompleted && (
          <div className="border-t p-3 sm:p-4">
            <div className="flex gap-2">
              <Textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                onKeyPress={handleKeyPress}
                placeholder="Share your thoughts about this week's games..."
                className="flex-1 resize-none text-sm sm:text-base"
                rows={3}
                disabled={isSending}
              />
            </div>
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 mt-2">
              <p className="text-xs text-gray-500">
                Press Enter to send, Shift+Enter for new line
              </p>
              <Button
                onClick={handleSend}
                disabled={!message.trim() || isSending}
                size="sm"
                className="w-full sm:w-auto"
              >
                {isSending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Send className="h-4 w-4" />
                )}
                <span className="ml-2">Send</span>
              </Button>
            </div>
          </div>
        )}

        {(isExpired || isCompleted) && (
          <div className="border-t p-3 sm:p-4">
            <p className="text-center text-gray-500 text-sm">
              {isExpired 
                ? "This comment request has expired. The article will be generated without your input."
                : "Thank you for your input! Your comments will be included in the article."}
            </p>
            {onClose && (
              <Button
                variant="outline"
                onClick={onClose}
                className="w-full mt-2"
              >
                Close
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}