"use client";

import { useState } from "react";
import { Filter, CheckCheck, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
  DropdownMenuLabel
} from "@/components/ui/dropdown-menu";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { NotificationItem, NotificationItemSkeleton } from "./NotificationItem";
import { useNotifications } from "./hooks/useNotifications";
import { Id } from "../../../convex/_generated/dataModel";

interface NotificationListProps {
  leagueId?: Id<"leagues">;
  maxHeight?: string;
  showFilters?: boolean;
  compact?: boolean;
}

export function NotificationList({
  leagueId,
  maxHeight = "400px",
  showFilters = true,
  compact = false,
}: NotificationListProps) {
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [sortBy, setSortBy] = useState<"newest" | "oldest" | "priority">("newest");

  const {
    notifications,
    unreadCount,
    isLoading,
    markAllAsRead
  } = useNotifications({
    leagueId,
    limit: 100
  });

  // Filter and sort notifications
  const filteredNotifications = notifications
    .filter(notification => {
      if (typeFilter === "all") return true;
      if (typeFilter === "unread") return notification.status === "unread";
      if (typeFilter === "read") return notification.status === "read";
      return notification.type === typeFilter;
    })
    .sort((a, b) => {
      switch (sortBy) {
        case "newest":
          return b.createdAt - a.createdAt;
        case "oldest":
          return a.createdAt - b.createdAt;
        case "priority": {
          const priorityOrder = { urgent: 4, high: 3, medium: 2, low: 1 };
          const aPriority = priorityOrder[a.priority as keyof typeof priorityOrder] || 1;
          const bPriority = priorityOrder[b.priority as keyof typeof priorityOrder] || 1;
          return bPriority - aPriority;
        }
        default:
          return b.createdAt - a.createdAt;
      }
    });

  const handleMarkAllAsRead = () => {
    markAllAsRead(leagueId);
  };

  if (isLoading) {
    return (
      <div className="flex flex-col">
        {Array.from({ length: 5 }).map((_, i) => (
          <NotificationItemSkeleton key={i} compact={compact} />
        ))}
      </div>
    );
  }

  return (
    <div className="w-full">
      {/* Header with filters and actions */}
      {showFilters && (
        <div className="flex items-center justify-between gap-3 border-b border-bc-hairline px-4 py-3">
          <div className="flex items-center gap-2.5">
            <span className="bc-label text-bc-ink">Notifications</span>
            {unreadCount > 0 && <Badge variant="destructive">{unreadCount} unread</Badge>}
          </div>

          <div className="flex items-center gap-2">
            {/* Filter dropdown */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm">
                  <Filter className="size-3.5" strokeWidth={1.8} />
                  Filter
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48 rounded-none">
                <DropdownMenuLabel>Filter by</DropdownMenuLabel>
                <DropdownMenuItem onClick={() => setTypeFilter("all")}>
                  All notifications
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setTypeFilter("unread")}>
                  Unread only
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setTypeFilter("read")}>
                  Read only
                </DropdownMenuItem>

                <DropdownMenuSeparator />
                <DropdownMenuLabel>By type</DropdownMenuLabel>
                <DropdownMenuItem onClick={() => setTypeFilter("comment_request")}>
                  Comment requests
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setTypeFilter("comment_follow_up")}>
                  Follow-ups
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setTypeFilter("article_published")}>
                  Articles
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            {/* Sort dropdown */}
            <Select value={sortBy} onValueChange={(value: "newest" | "oldest" | "priority") => setSortBy(value)}>
              <SelectTrigger size="sm" className="w-28 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="newest">Newest</SelectItem>
                <SelectItem value="oldest">Oldest</SelectItem>
                <SelectItem value="priority">Priority</SelectItem>
              </SelectContent>
            </Select>

            {/* Mark all as read */}
            {unreadCount > 0 && (
              <Button
                variant="outline"
                size="sm"
                onClick={handleMarkAllAsRead}
              >
                <CheckCheck className="size-3.5" strokeWidth={1.8} />
                Mark all read
              </Button>
            )}
          </div>
        </div>
      )}

      {/* Notification list */}
      <div
        className="overflow-y-auto"
        style={{ maxHeight }}
      >
        {filteredNotifications.length === 0 ? (
          <div className="flex flex-col items-center gap-4 px-6 py-12 text-center">
            <span className="inline-flex size-14 items-center justify-center border border-bc-hairline bg-bc-panel-2 text-bc-text-2">
              <RefreshCw className="size-6" strokeWidth={1.8} />
            </span>
            <div className="flex flex-col gap-2">
              <span className="font-display text-[18px] font-extrabold text-bc-ink uppercase">
                {typeFilter === "unread" ? "No unread notifications" : "No notifications"}
              </span>
              <p className="max-w-sm text-[14px] text-bc-text-2">
                {typeFilter === "unread"
                  ? "You're all caught up! Check back later for new notifications."
                  : "When you receive notifications, they'll appear here."
                }
              </p>
            </div>
          </div>
        ) : (
          <div className="flex flex-col">
            {filteredNotifications.map((notification) => (
              <NotificationItem
                key={notification._id}
                notification={notification}
                compact={compact}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// Tabbed notification list for different categories
export function TabbedNotificationList({ leagueId }: { leagueId?: Id<"leagues"> }) {
  const { notifications, isLoading } = useNotifications({ leagueId });

  if (isLoading) {
    return (
      <div className="flex flex-col">
        {Array.from({ length: 5 }).map((_, i) => (
          <NotificationItemSkeleton key={i} />
        ))}
      </div>
    );
  }

  const commentNotifications = notifications.filter(n =>
    n.type.startsWith("comment_")
  );

  const articleNotifications = notifications.filter(n =>
    n.type.includes("article_")
  );

  const systemNotifications = notifications.filter(n =>
    ["system_announcement", "league_invitation", "account_update"].includes(n.type)
  );

  return (
    <Tabs defaultValue="all" className="w-full">
      <TabsList className="grid w-full grid-cols-4">
        <TabsTrigger value="all">
          All ({notifications.length})
        </TabsTrigger>
        <TabsTrigger value="comments">
          Comments ({commentNotifications.length})
        </TabsTrigger>
        <TabsTrigger value="articles">
          Articles ({articleNotifications.length})
        </TabsTrigger>
        <TabsTrigger value="system">
          System ({systemNotifications.length})
        </TabsTrigger>
      </TabsList>

      <TabsContent value="all" className="mt-4">
        <NotificationList leagueId={leagueId} showFilters={false} />
      </TabsContent>

      <TabsContent value="comments" className="mt-4">
        <div className="flex flex-col">
          {commentNotifications.map((notification) => (
            <NotificationItem key={notification._id} notification={notification} />
          ))}
        </div>
      </TabsContent>

      <TabsContent value="articles" className="mt-4">
        <div className="flex flex-col">
          {articleNotifications.map((notification) => (
            <NotificationItem key={notification._id} notification={notification} />
          ))}
        </div>
      </TabsContent>

      <TabsContent value="system" className="mt-4">
        <div className="flex flex-col">
          {systemNotifications.map((notification) => (
            <NotificationItem key={notification._id} notification={notification} />
          ))}
        </div>
      </TabsContent>
    </Tabs>
  );
}
