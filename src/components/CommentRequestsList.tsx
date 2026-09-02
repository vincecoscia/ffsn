"use client";

import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { MessageSquare, Clock, ChevronRight } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import CommentConversation from "./CommentConversation";
import { Panel, SectionHeader, Chip, EmptyState, LoadingScreen, PersonaAvatar } from "@/components/broadcast";
import { cn } from "@/lib/utils";

interface CommentRequestsListProps {
  userId: Id<"users">;
}

/** Sam Ortega conducts every comment-request interview (spec §1.2). */
const INTERVIEWER_SLUG = "sam-ortega";

type RequestStatus = "pending" | "active" | "completed" | "expired" | "declined" | "cancelled";

const STATUS_CHIP: Record<
  RequestStatus,
  { variant: "outline" | "signal" | "win" | "muted"; label: string; live?: boolean }
> = {
  pending: { variant: "outline", label: "Pending" },
  active: { variant: "signal", label: "Open", live: true },
  completed: { variant: "win", label: "Answered" },
  expired: { variant: "muted", label: "Went to print" },
  declined: { variant: "muted", label: "No comment" },
  cancelled: { variant: "muted", label: "Cancelled" },
};

function titleCase(value?: string) {
  return value?.replace(/_/g, " ").replace(/\b\w/g, (l) => l.toUpperCase());
}

export default function CommentRequestsList({ userId: _userId }: CommentRequestsListProps) {
  const [selectedRequest, setSelectedRequest] = useState<Id<"commentRequests"> | null>(null);

  // Every request, open or closed. The target user is derived from the caller's own
  // identity server-side, so no userId is passed here (the prop is kept for backwards
  // compatibility with existing callers of this component).
  const requests = useQuery(api.commentConversations.getMyRequests, {});

  if (!requests) {
    return <LoadingScreen message="Loading comment requests" />;
  }

  if (requests.length === 0) {
    return (
      <EmptyState
        icon={<MessageSquare className="size-6" strokeWidth={1.8} />}
        title="No comment requests yet"
        description="Sam Ortega gets in touch when a story needs your side of it."
      />
    );
  }

  const openCount = requests.filter(
    (request) => request.status === "active" || request.status === "pending"
  ).length;

  return (
    <>
      <Panel padding="md">
        <SectionHeader
          title={
            <span className="flex items-center gap-2">
              <MessageSquare className="size-5" />
              Comment requests
            </span>
          }
          kicker={
            openCount > 0
              ? `${openCount} still open for comment`
              : "Everything you've been asked for"
          }
        />

        <div className="mt-5 flex flex-col gap-3">
          {requests.map((request) => {
            const status = (request.status as RequestStatus) ?? "pending";
            const statusChip = STATUS_CHIP[status] ?? STATUS_CHIP.pending;
            const isOpen = status === "active" || status === "pending";
            const hasUnread =
              isOpen &&
              request.lastMessage &&
              !request.lastMessage.isRead &&
              request.lastMessage.messageType.startsWith("ai_");
            const timeUntilArticle =
              isOpen && request.articleGenerationTime
                ? formatDistanceToNow(new Date(request.articleGenerationTime))
                : null;
            const generatingSoon =
              isOpen &&
              !!request.articleGenerationTime &&
              new Date(request.articleGenerationTime) < new Date(Date.now() + 60 * 60 * 1000);

            return (
              <button
                type="button"
                key={request._id}
                className={cn(
                  "flex items-start gap-4 border p-4 text-left transition-colors",
                  hasUnread
                    ? "border-bc-signal bg-bc-signal/5"
                    : isOpen
                    ? "border-bc-hairline bg-bc-panel-2 hover:border-bc-border-strong"
                    : "border-bc-hairline bg-bc-panel-2/60 hover:border-bc-border-strong"
                )}
                onClick={() => setSelectedRequest(request._id)}
              >
                <PersonaAvatar
                  persona={INTERVIEWER_SLUG}
                  size={40}
                  className={cn(
                    "flex-none border border-bc-border-strong",
                    !isOpen && "opacity-70"
                  )}
                />

                <div className="min-w-0 flex-1">
                  <div className="mb-1 flex flex-wrap items-center gap-2">
                    <h4 className="font-display text-[16px] font-bold uppercase tracking-[0.01em] text-bc-ink">
                      {titleCase(request.articleType)}
                    </h4>
                    <Chip variant={statusChip.variant} live={statusChip.live}>
                      {statusChip.label}
                    </Chip>
                    {hasUnread && <Chip variant="signal" live>New message</Chip>}
                  </div>
                  <p className="mb-2 text-sm text-bc-text-2">
                    {request.leagueName} &middot; Week {request.articleContext?.week}
                  </p>

                  {request.lastMessage && (
                    <div className="mb-2 text-sm text-bc-text-2">
                      <p className="line-clamp-2">
                        {request.lastMessage.messageType.startsWith("ai_") ? "Sam: " : "You: "}
                        {request.lastMessage.content}
                      </p>
                      <p className="mt-1 text-xs text-bc-text-3">
                        {formatDistanceToNow(new Date(request.lastMessage.createdAt), { addSuffix: true })}
                      </p>
                    </div>
                  )}

                  <div className="flex flex-wrap items-center gap-4 text-xs text-bc-text-3">
                    <div className="flex items-center gap-1.5">
                      <MessageSquare className="size-3" />
                      {request.messageCount} messages
                    </div>
                    {timeUntilArticle && (
                      <div className="flex items-center gap-1.5">
                        <Clock className="size-3" />
                        Prints in {timeUntilArticle}
                      </div>
                    )}
                  </div>

                  {generatingSoon && request.articleGenerationTime && (
                    <div className="mt-3 flex items-center gap-2 border-l-2 border-l-bc-signal bg-bc-signal/10 px-2.5 py-1.5 text-bc-signal">
                      <Clock className="size-3.5" />
                      <span className="text-xs font-medium">
                        Goes to print {formatDistanceToNow(new Date(request.articleGenerationTime), { addSuffix: true })}
                      </span>
                    </div>
                  )}
                </div>

                <ChevronRight className="mt-1 size-5 flex-none text-bc-text-3" />
              </button>
            );
          })}
        </div>
      </Panel>

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
