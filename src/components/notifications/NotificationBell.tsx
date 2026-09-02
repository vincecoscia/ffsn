"use client";

import { Bell } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useNotifications } from "./hooks/useNotifications";
import { Id } from "../../../convex/_generated/dataModel";
import { cn } from "@/lib/utils";

interface NotificationBellProps {
  leagueId?: Id<"leagues">;
  onClick?: () => void;
  className?: string;
  showCount?: boolean;
}

export function NotificationBell({
  leagueId,
  onClick,
  className,
  showCount = true
}: NotificationBellProps) {
  const { unreadCount, hasUnreadNotifications, isLoading } = useNotifications({ leagueId });

  return (
    <Button
      type="button"
      variant="outline"
      size="icon"
      onClick={onClick}
      className={cn("relative", className)}
      aria-label={`Notifications${hasUnreadNotifications ? ` (${unreadCount} unread)` : ""}`}
    >
      <Bell className="size-5" strokeWidth={1.8} />

      {showCount && hasUnreadNotifications && !isLoading && (
        <span
          aria-hidden="true"
          className="absolute -top-1.5 -right-1.5 flex h-5 min-w-5 items-center justify-center bg-bc-red px-1 font-display text-[11px] leading-none font-extrabold text-white"
        >
          {unreadCount > 99 ? "99+" : unreadCount}
        </span>
      )}
    </Button>
  );
}
