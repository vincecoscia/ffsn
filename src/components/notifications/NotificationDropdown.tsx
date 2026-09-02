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
        className="w-[420px] max-w-[90vw] rounded-none border-bc-hairline bg-bc-panel p-0"
        sideOffset={8}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-bc-hairline px-4 py-3">
          <div className="flex items-center gap-2.5">
            <span className="bc-label text-bc-ink">Notifications</span>
            {hasUnreadNotifications && <Badge variant="default">{unreadCount} unread</Badge>}
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
                <CheckCheck className="size-3.5" strokeWidth={1.8} />
                Mark all
              </Button>
            )}
            <Button variant="ghost" size="icon-sm" asChild>
              <Link href="/settings/notifications">
                <Settings className="size-4" strokeWidth={1.8} />
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
        <div className="flex items-center justify-center border-t border-bc-hairline px-3 py-2.5">
          <Link
            href={leagueId ? `/leagues/${leagueId}/notifications` : "/notifications"}
            className="bc-label-sm text-bc-text-2 hover:text-bc-red-text"
          >
            View all
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
        className="w-80 max-w-[95vw] rounded-none border-bc-hairline bg-bc-panel p-0"
        sideOffset={8}
      >
        <div className="border-b border-bc-hairline px-3 py-3">
          <span className="bc-label text-bc-ink">Notifications</span>
        </div>
        <div className="p-3">
          <NotificationList
            leagueId={leagueId}
            maxHeight="300px"
            showFilters={false}
            compact={true}
          />
        </div>

        <div className="flex items-center justify-center gap-2 border-t border-bc-hairline px-3 py-2.5">
          <Link
            href={leagueId ? `/leagues/${leagueId}/notifications` : "/notifications"}
            className="bc-label-sm inline-flex items-center gap-2 text-bc-text-2 hover:text-bc-red-text"
          >
            <span>View all</span>
            <ExternalLink className="size-4" strokeWidth={1.8} />
          </Link>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
