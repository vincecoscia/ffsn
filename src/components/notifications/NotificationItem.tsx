"use client";

import {
  MessageSquare,
  Clock,
  RotateCw,
  PartyPopper,
  Newspaper,
  Sparkles,
  Megaphone,
  Trophy,
  Settings,
  Bell,
  type LucideIcon,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { useNotifications } from "./hooks/useNotifications";
import { Doc } from "../../../convex/_generated/dataModel";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

interface NotificationItemProps {
  notification: Doc<"userNotifications">;
  onClick?: () => void;
  compact?: boolean;
}

// Icon per notification type — no emoji in the UI, per the design system.
const TYPE_ICONS: Record<string, LucideIcon> = {
  comment_request: MessageSquare,
  comment_reminder: Clock,
  comment_follow_up: RotateCw,
  comment_thank_you: PartyPopper,
  article_published: Newspaper,
  article_generated: Sparkles,
  system_announcement: Megaphone,
  league_invitation: Trophy,
  account_update: Settings,
};

function typeLabel(type: string): string {
  return type.replace(/_/g, " ");
}

export function NotificationItem({
  notification,
  onClick,
  compact = false
}: NotificationItemProps) {
  const { markAsRead } = useNotifications();
  const isUnread = notification.status === "unread";
  const timeAgo = formatDistanceToNow(new Date(notification.createdAt), { addSuffix: true });
  const Icon = TYPE_ICONS[notification.type] ?? Bell;

  const handleItemClick = () => {
    // Mark as read when clicked
    if (isUnread) {
      markAsRead(notification._id);
    }

    // Navigate to the conversation if actionUrl exists
    if (notification.actionUrl) {
      window.location.href = notification.actionUrl;
    }

    onClick?.();
  };

  return (
    <div
      className={cn(
        "flex cursor-pointer items-start gap-3 border-t border-bc-hairline px-4 py-3.5 transition-colors hover:bg-bc-panel-2",
        isUnread && "bg-bc-panel-2"
      )}
      onClick={handleItemClick}
    >
      <span className="mt-0.5 inline-flex size-8 flex-none items-center justify-center border border-bc-hairline bg-bc-ground text-bc-text-2">
        <Icon className="size-4" strokeWidth={1.8} aria-hidden="true" />
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={cn(
              "truncate font-display text-[15px] font-bold tracking-[0.01em] uppercase",
              isUnread ? "text-bc-ink" : "text-bc-text-2"
            )}
          >
            {notification.title}
          </span>
          <Badge variant="secondary" className="text-[10px]">
            {typeLabel(notification.type)}
          </Badge>
        </div>

        {notification.message && (
          <p className={cn("mt-1 text-[13px] text-bc-text-2", compact ? "truncate" : "line-clamp-2")}>
            {notification.message}
          </p>
        )}

        <span className="bc-label-sm mt-1.5 block text-bc-text-3">{timeAgo}</span>
      </div>

      {isUnread && <span className="mt-1.5 size-2 flex-none bg-bc-red" aria-hidden="true" />}
    </div>
  );
}

// Skeleton component for loading states
export function NotificationItemSkeleton({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex items-start gap-3 border-t border-bc-hairline px-4 py-3.5">
      <Skeleton className="size-8 flex-none" />
      <div className="flex-1 space-y-2">
        <Skeleton className="h-4 w-3/4" />
        {!compact && (
          <>
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-2/3" />
          </>
        )}
        <Skeleton className="h-3 w-20" />
      </div>
    </div>
  );
}
