"use client";

import { formatDistanceToNow } from "date-fns";
import { useNotifications } from "./hooks/useNotifications";
import { Doc } from "../../../convex/_generated/dataModel";

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
  const { markAsRead } = useNotifications();
  const isUnread = notification.status === "unread";
  const timeAgo = formatDistanceToNow(new Date(notification.createdAt), { addSuffix: true });
  
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

  const NotificationContent = () => (
    <div 
      className={`px-4 py-3 transition-colors cursor-pointer border-b border-gray-100 hover:bg-gray-50 ${
        isUnread ? "bg-blue-50/30" : ""
      }`}
      onClick={handleItemClick}
    >
      <div className="flex items-center justify-between">
        <div className="flex-1 min-w-0">
          <h4 className={`text-sm font-medium truncate ${
            isUnread ? "text-gray-900" : "text-gray-700"
          }`}>
            {notification.title}
          </h4>
        </div>
        
        <div className="flex items-center gap-2 ml-3">
          <span className="text-xs text-gray-500 whitespace-nowrap">{timeAgo}</span>
          {isUnread && <span className="w-2 h-2 bg-blue-500 rounded-full flex-shrink-0" />}
        </div>
      </div>
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