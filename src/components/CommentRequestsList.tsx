"use client";

import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { MessageSquare, Clock, AlertCircle, ChevronRight } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import CommentConversation from "./CommentConversation";
import { cn } from "@/lib/utils";

interface CommentRequestsListProps {
  userId: Id<"users">;
}

export default function CommentRequestsList({ userId }: CommentRequestsListProps) {
  const [selectedRequest, setSelectedRequest] = useState<Id<"commentRequests"> | null>(null);
  
  // Get active comment requests
  const activeRequests = useQuery(api.commentConversations.getActiveRequests, {
    userId,
  });

  if (!activeRequests) {
    return (
      <Card>
        <CardContent className="py-8">
          <div className="text-center text-gray-500">
            Loading comment requests...
          </div>
        </CardContent>
      </Card>
    );
  }

  if (activeRequests.length === 0) {
    return (
      <Card>
        <CardContent className="py-8">
          <div className="text-center">
            <MessageSquare className="h-12 w-12 text-gray-300 mx-auto mb-3" />
            <p className="text-gray-500">No active comment requests</p>
            <p className="text-sm text-gray-400 mt-1">
              You&apos;ll be notified when content creators need your input
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg sm:text-xl">
            <MessageSquare className="h-5 w-5" />
            Active Comment Requests
          </CardTitle>
          <CardDescription>
            Share your thoughts for upcoming articles
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {activeRequests.map((request) => {
              const hasUnread = request.lastMessage && !request.lastMessage.isRead && 
                               request.lastMessage.messageType.startsWith("ai_");
              const timeUntilArticle = request.scheduledTime 
                ? formatDistanceToNow(new Date(request.scheduledTime))
                : null;
              
              return (
                <div
                  key={request._id}
                  className={cn(
                    "border rounded-lg p-3 sm:p-4 hover:bg-gray-50 transition-colors cursor-pointer",
                    hasUnread && "border-blue-200 bg-blue-50/50"
                  )}
                  onClick={() => setSelectedRequest(request._id)}
                >
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <h4 className="font-medium text-gray-900 text-sm sm:text-base">
                          {request.articleType?.replace(/_/g, " ").replace(/\b\w/g, l => l.toUpperCase())}
                        </h4>
                        {hasUnread && (
                          <Badge variant="default" className="text-xs">
                            New Message
                          </Badge>
                        )}
                      </div>
                      <p className="text-xs sm:text-sm text-gray-600 mb-2">
                        {request.leagueName} • Week {request.articleContext?.week}
                      </p>
                      
                      {request.lastMessage && (
                        <div className="text-sm text-gray-500 mb-2">
                          <p className="line-clamp-2 text-sm">
                            {request.lastMessage.messageType.startsWith("ai_") 
                              ? "Q: " 
                              : "You: "}
                            {request.lastMessage.content}
                          </p>
                          <p className="text-xs mt-1">
                            {formatDistanceToNow(new Date(request.lastMessage.createdAt), { addSuffix: true })}
                          </p>
                        </div>
                      )}

                      <div className="flex flex-wrap items-center gap-3 sm:gap-4 text-xs text-gray-500">
                        <div className="flex items-center gap-1">
                          <MessageSquare className="h-3 w-3" />
                          {request.messageCount} messages
                        </div>
                        {timeUntilArticle && (
                          <div className="flex items-center gap-1">
                            <Clock className="h-3 w-3" />
                            Article in {timeUntilArticle}
                          </div>
                        )}
                      </div>
                    </div>
                    <ChevronRight className="h-4 w-4 sm:h-5 sm:w-5 text-gray-400 flex-shrink-0 ml-2 mt-1" />
                  </div>

                  {request.expirationTime && new Date(request.expirationTime) < new Date(Date.now() + 60 * 60 * 1000) && (
                    <div className="mt-3 flex items-center gap-2 text-amber-600 bg-amber-50 rounded px-2 py-1">
                      <AlertCircle className="h-3 w-3" />
                      <span className="text-xs font-medium">
                        Expires {formatDistanceToNow(new Date(request.expirationTime), { addSuffix: true })}
                      </span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      <Dialog 
        open={!!selectedRequest} 
        onOpenChange={(open) => !open && setSelectedRequest(null)}
      >
        <DialogContent className="w-[95vw] max-w-2xl p-0 sm:w-auto">
          {selectedRequest && (
            <CommentConversation
              commentRequestId={selectedRequest}
              onClose={() => setSelectedRequest(null)}
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}