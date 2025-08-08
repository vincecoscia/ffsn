import { useQuery, useMutation } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import { Id } from "../../../../convex/_generated/dataModel";
import { toast } from "sonner";

export interface NotificationFilters {
  leagueId?: Id<"leagues">;
  type?: "comment_request" | "comment_reminder" | "comment_follow_up" | "comment_thank_you" | "article_published" | "article_generated" | "system_announcement" | "league_invitation" | "account_update";
  isRead?: boolean;
  limit?: number;
}

export function useNotifications(filters: NotificationFilters = {}) {
  // Get notifications with real-time updates
  const notifications = useQuery(api.notifications.getUserNotifications, filters);
  
  // Get unread count
  const unreadCount = useQuery(api.notifications.getUnreadCount, {
    leagueId: filters.leagueId,
  });
  
  // Mutations
  const markAsRead = useMutation(api.notifications.markAsRead);
  const markAsUnread = useMutation(api.notifications.markAsUnread);
  const markAllAsRead = useMutation(api.notifications.markAllAsRead);
  const deleteNotification = useMutation(api.notifications.deleteNotification);
  
  // Helper functions with error handling
  const handleMarkAsRead = async (id: Id<"userNotifications">) => {
    try {
      await markAsRead({ id });
    } catch (error) {
      console.error("Failed to mark notification as read:", error);
      toast.error("Failed to mark notification as read");
    }
  };
  
  const handleMarkAsUnread = async (id: Id<"userNotifications">) => {
    try {
      await markAsUnread({ id });
    } catch (error) {
      console.error("Failed to mark notification as unread:", error);
      toast.error("Failed to mark notification as unread");
    }
  };
  
  const handleMarkAllAsRead = async (leagueId?: Id<"leagues">) => {
    try {
      const result = await markAllAsRead({ leagueId });
      if (result.markedCount > 0) {
        toast.success(`Marked ${result.markedCount} notifications as read`);
      }
    } catch (error) {
      console.error("Failed to mark all notifications as read:", error);
      toast.error("Failed to mark all notifications as read");
    }
  };
  
  const handleDeleteNotification = async (id: Id<"userNotifications">) => {
    try {
      await deleteNotification({ id });
      toast.success("Notification deleted");
    } catch (error) {
      console.error("Failed to delete notification:", error);
      toast.error("Failed to delete notification");
    }
  };
  
  // Computed values
  const isLoading = notifications === undefined || unreadCount === undefined;
  const hasUnreadNotifications = (unreadCount ?? 0) > 0;
  
  // Filter notifications by read status if needed
  const filteredNotifications = notifications?.filter(notification => {
    if (filters.isRead === undefined) return true;
    const isUnread = notification.status === "unread";
    return filters.isRead ? !isUnread : isUnread;
  }) ?? [];
  
  return {
    // Data
    notifications: filteredNotifications,
    unreadCount: unreadCount ?? 0,
    hasUnreadNotifications,
    isLoading,
    
    // Actions
    markAsRead: handleMarkAsRead,
    markAsUnread: handleMarkAsUnread,
    markAllAsRead: handleMarkAllAsRead,
    deleteNotification: handleDeleteNotification,
    
    // Utils
    getNotificationIcon: (type: string) => {
      switch (type) {
        case "comment_request": return "💬";
        case "comment_reminder": return "⏰";
        case "comment_follow_up": return "🔄";
        case "comment_thank_you": return "🎉";
        case "article_published": return "📰";
        case "article_generated": return "✨";
        case "system_announcement": return "📢";
        case "league_invitation": return "🏆";
        case "account_update": return "⚙️";
        default: return "🔔";
      }
    },
    
    getPriorityColor: (priority: string) => {
      switch (priority) {
        case "urgent": return "text-red-600 bg-red-50 border-red-200";
        case "high": return "text-orange-600 bg-orange-50 border-orange-200";
        case "medium": return "text-blue-600 bg-blue-50 border-blue-200";
        case "low": return "text-gray-600 bg-gray-50 border-gray-200";
        default: return "text-gray-600 bg-gray-50 border-gray-200";
      }
    },
  };
}

// Hook for getting a single notification by ID
export function useNotification(id: Id<"userNotifications">) {
  const notification = useQuery(api.notifications.getNotificationById, { id });
  
  return {
    notification,
    isLoading: notification === undefined,
  };
}