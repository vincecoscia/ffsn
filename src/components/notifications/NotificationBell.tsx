"use client";

import { Bell } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useNotifications } from "./hooks/useNotifications";
import { Id } from "../../../convex/_generated/dataModel";

interface NotificationBellProps {
  leagueId?: Id<"leagues">;
  onClick?: () => void;
  className?: string;
  showCount?: boolean;
}

export function NotificationBell({ 
  leagueId, 
  onClick, 
  className = "",
  showCount = true 
}: NotificationBellProps) {
  const { unreadCount, hasUnreadNotifications, isLoading } = useNotifications({ leagueId });

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={onClick}
      className={`relative text-white hover:text-red-200 hover:bg-red-700 ${className}`}
      aria-label={`Notifications${hasUnreadNotifications ? ` (${unreadCount} unread)` : ""}`}
    >
      <Bell className="h-5 w-5" />
      
      {showCount && hasUnreadNotifications && !isLoading && (
        <Badge 
          variant="destructive" 
          className="absolute -top-1 -right-1 h-5 w-5 rounded-full p-0 text-xs font-bold flex items-center justify-center min-w-[20px] bg-red-500 text-white border-2 border-red-600 shadow-lg"
        >
          {unreadCount > 99 ? "99+" : unreadCount}
        </Badge>
      )}
    
    </Button>
  );
}