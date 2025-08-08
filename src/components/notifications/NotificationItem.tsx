"use client";

import { formatDistanceToNow } from "date-fns";
import { MoreHorizontal, ExternalLink, Trash2, Mail, MailOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useNotifications } from "./hooks/useNotifications";
import { Doc } from "../../../convex/_generated/dataModel";
import Link from "next/link";

interface NotificationItemProps {
  notification: Doc<"userNotifications">;
  onClick?: () => void;
  showActions?: boolean;
  compact?: boolean;
}

export function NotificationItem({ 
  notification, 
  onClick, 
  showActions = true,
  compact = false 
}: NotificationItemProps) {
  const { 
    markAsRead, 
    markAsUnread, 
    deleteNotification, 
    getNotificationIcon, 
    getPriorityColor 
  } = useNotifications();

  const isUnread = notification.status === "unread";
  const timeAgo = formatDistanceToNow(new Date(notification.createdAt), { addSuffix: true });
  
  const handleMarkToggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isUnread) {
      markAsRead(notification._id);
    } else {
      markAsUnread(notification._id);
    }
  };
  
  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    deleteNotification(notification._id);
  };
  
  const handleItemClick = () => {
    // Mark as read when clicked
    if (isUnread) {
      markAsRead(notification._id);
    }
    onClick?.();
  };

  const NotificationContent = () => (
    <div 
      className={`group relative px-3 py-3 sm:px-4 sm:py-3 transition-colors cursor-pointer ${
        isUnread ? "bg-blue-50/60 hover:bg-blue-50" : "hover:bg-gray-50"
      }`}
      onClick={handleItemClick}
    >
      {/* Priority indicator */}
      {notification.priority === "urgent" && (
        <div className="absolute top-2 left-2 w-2 h-2 bg-red-500 rounded-full animate-pulse"></div>
      )}
      
      <div className="flex items-start gap-3">
        {/* Icon */}
        <div className={`flex-shrink-0 w-9 h-9 rounded-full flex items-center justify-center text-base ${
          isUnread ? "bg-blue-100" : "bg-gray-100"
        }`}>
          <span role="img" aria-label={notification.type}>
            {getNotificationIcon(notification.type)}
          </span>
        </div>
        
        {/* Content */}
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <h4 className={`font-medium truncate ${
                  isUnread ? "text-gray-900" : "text-gray-800"
                }`}>
                  {notification.title}
                </h4>
                {notification.priority !== "medium" && (
                  <Badge 
                    variant="outline" 
                    className={`text-[10px] px-1.5 py-0 ${getPriorityColor(notification.priority)}`}
                  >
                    {notification.priority}
                  </Badge>
                )}
              </div>

              {!compact && notification.message && (
                <p className="mt-0.5 text-sm text-gray-600 line-clamp-2">
                  {notification.message}
                </p>
              )}
              
              {/* Metadata */}
              <div className="mt-1 flex items-center gap-2 text-xs text-gray-500">
                <span>{timeAgo}</span>
                {isUnread && <span className="w-1.5 h-1.5 bg-blue-500 rounded-full" />}
              </div>
            </div>
            
            {/* Actions */}
            {showActions && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 opacity-0 group-hover:opacity-100 transition-opacity"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <MoreHorizontal className="h-4 w-4" />
                    <span className="sr-only">Notification actions</span>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-48">
                  <DropdownMenuItem onClick={handleMarkToggle}>
                    {isUnread ? (
                      <>
                        <MailOpen className="mr-2 h-4 w-4" />
                        Mark as read
                      </>
                    ) : (
                      <>
                        <Mail className="mr-2 h-4 w-4" />
                        Mark as unread
                      </>
                    )}
                  </DropdownMenuItem>
                  
                  {notification.actionUrl && (
                    <DropdownMenuItem asChild>
                      <Link href={notification.actionUrl}>
                        <ExternalLink className="mr-2 h-4 w-4" />
                        {notification.actionText || "View"}
                      </Link>
                    </DropdownMenuItem>
                  )}
                  
                  <DropdownMenuSeparator />
                  
                  <DropdownMenuItem 
                    onClick={handleDelete}
                    className="text-red-600 focus:text-red-600"
                  >
                    <Trash2 className="mr-2 h-4 w-4" />
                    Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </div>
      </div>
      
      {/* Primary action inline */}
      {notification.actionUrl && notification.actionText && (
        <div className="mt-2 ml-[3.25rem]">
          <Link href={notification.actionUrl}>
            <Button 
              size="sm" 
              variant="outline"
              className="text-xs"
              onClick={(e) => e.stopPropagation()}
            >
              {notification.actionText}
              <ExternalLink className="ml-1 h-3 w-3" />
            </Button>
          </Link>
        </div>
      )}
    </div>
  );

  return <NotificationContent />;
}

// Skeleton component for loading states
export function NotificationItemSkeleton({ compact = false }: { compact?: boolean }) {
  return (
    <div className="p-3 sm:p-4 rounded-lg border bg-white">
      <div className="flex items-start gap-3">
        <div className="flex-shrink-0 w-10 h-10 rounded-full bg-gray-200 animate-pulse"></div>
        <div className="flex-1 space-y-2">
          <div className="h-4 bg-gray-200 rounded animate-pulse w-3/4"></div>
          {!compact && (
            <>
              <div className="h-3 bg-gray-200 rounded animate-pulse w-full"></div>
              <div className="h-3 bg-gray-200 rounded animate-pulse w-2/3"></div>
            </>
          )}
          <div className="flex items-center gap-2">
            <div className="h-3 bg-gray-200 rounded animate-pulse w-20"></div>
            <div className="h-3 bg-gray-200 rounded animate-pulse w-16"></div>
          </div>
        </div>
      </div>
    </div>
  );
}