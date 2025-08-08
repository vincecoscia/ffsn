"use client";

import { useState } from "react";
import { Settings, ExternalLink, CheckCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { NotificationBell } from "./NotificationBell";
import { NotificationList } from "./NotificationList";
import { useNotifications } from "./hooks/useNotifications";
import { Id } from "../../../convex/_generated/dataModel";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";

interface NotificationDropdownProps {
  leagueId?: Id<"leagues">;
  className?: string;
}

export function NotificationDropdown({ leagueId, className = "" }: NotificationDropdownProps) {
  const [isOpen, setIsOpen] = useState(false);
  const { unreadCount, hasUnreadNotifications, markAllAsRead, isLoading } = useNotifications({ leagueId });

  return (
    <DropdownMenu open={isOpen} onOpenChange={setIsOpen}>
      <DropdownMenuTrigger asChild>
        <div>
          <NotificationBell 
            leagueId={leagueId}
            className={className}
            onClick={() => setIsOpen(!isOpen)}
          />
        </div>
      </DropdownMenuTrigger>
      
      <DropdownMenuContent
        align="end"
        className="w-[420px] max-w-[90vw] p-0 rounded-lg shadow-md border"
        sideOffset={8}
      >
        {/* Header */}
        <div className="sticky top-0 z-10 flex items-center justify-between px-4 py-3 border-b bg-white/80 backdrop-blur supports-[backdrop-filter]:bg-white/60">
          <div className="flex items-center gap-2">
            <h3 className="font-semibold text-gray-900">Notifications</h3>
            {hasUnreadNotifications && (
              <Badge variant="secondary" className="text-xs">
                {unreadCount} unread
              </Badge>
            )}
          </div>

          <div className="flex items-center gap-1">
            {hasUnreadNotifications && (
              <Button
                variant="ghost"
                size="sm"
                className="h-8 text-xs"
                disabled={isLoading}
                onClick={() => markAllAsRead(leagueId)}
              >
                <CheckCheck className="h-3.5 w-3.5 mr-1" />
                Mark all
              </Button>
            )}
            <Button variant="ghost" size="icon" className="h-8 w-8" asChild>
              <Link href="/settings/notifications">
                <Settings className="h-4 w-4" />
                <span className="sr-only">Notification settings</span>
              </Link>
            </Button>
          </div>
        </div>

        {/* List */}
        <div className="max-h-96 overflow-hidden">
          <NotificationList
            leagueId={leagueId}
            maxHeight="22rem"
            showFilters={false}
            compact={true}
          />
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-3 py-2 border-t bg-white/70">
          <Link
            href={leagueId ? `/leagues/${leagueId}/notifications` : "/notifications"}
            className="inline-flex items-center gap-2 text-sm text-gray-700 hover:text-gray-900"
          >
            <span>View all</span>
            <ExternalLink className="h-4 w-4" />
          </Link>
          <Link
            href="/settings/notifications"
            className="text-sm text-gray-500 hover:text-gray-700"
          >
            Settings
          </Link>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// Simplified notification dropdown for mobile
export function MobileNotificationDropdown({ leagueId }: { leagueId?: Id<"leagues"> }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <NotificationBell leagueId={leagueId} />
      </DropdownMenuTrigger>

      <DropdownMenuContent
        align="end"
        className="w-80 max-w-[95vw] p-0 rounded-lg shadow-md border"
        sideOffset={8}
      >
        <div className="px-3 py-3 border-b bg-white/80 backdrop-blur supports-[backdrop-filter]:bg-white/60">
          <h3 className="font-semibold">Notifications</h3>
        </div>
        <div className="p-3">
          <NotificationList
            leagueId={leagueId}
            maxHeight="300px"
            showFilters={false}
            compact={true}
          />
        </div>

        <div className="flex items-center justify-center gap-2 px-3 py-2 border-t bg-white/70">
          <Link
            href={leagueId ? `/leagues/${leagueId}/notifications` : "/notifications"}
            className="inline-flex items-center gap-2 text-sm text-gray-700 hover:text-gray-900"
          >
            <span>View all</span>
            <ExternalLink className="h-4 w-4" />
          </Link>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}