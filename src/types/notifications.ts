import { Doc, Id } from "../../convex/_generated/dataModel";

// Re-export the notification document type from Convex
export type Notification = Doc<"userNotifications">;

// Notification types enum for type safety
export enum NotificationType {
  COMMENT_REQUEST = "comment_request",
  COMMENT_REMINDER = "comment_reminder", 
  COMMENT_FOLLOW_UP = "comment_follow_up",
  COMMENT_THANK_YOU = "comment_thank_you",
  ARTICLE_PUBLISHED = "article_published",
  ARTICLE_GENERATED = "article_generated",
  SYSTEM_ANNOUNCEMENT = "system_announcement",
  LEAGUE_INVITATION = "league_invitation",
  ACCOUNT_UPDATE = "account_update"
}

// Notification status enum
export enum NotificationStatus {
  UNREAD = "unread",
  READ = "read",
  ARCHIVED = "archived",
  DISMISSED = "dismissed"
}

// Notification priority enum
export enum NotificationPriority {
  URGENT = "urgent",
  HIGH = "high",
  MEDIUM = "medium",
  LOW = "low"
}

// Related entity types for deep linking
export enum RelatedEntityType {
  COMMENT_REQUEST = "comment_request",
  SCHEDULED_CONTENT = "scheduled_content",
  AI_CONTENT = "ai_content", 
  LEAGUE = "league",
  USER = "user"
}

// Delivery channels
export enum DeliveryChannel {
  IN_APP = "in_app",
  EMAIL = "email",
  PUSH = "push"
}

// Filter options for notification queries
export interface NotificationFilters {
  leagueId?: Id<"leagues">;
  type?: NotificationType;
  status?: NotificationStatus;
  priority?: NotificationPriority;
  isRead?: boolean;
  limit?: number;
  offset?: number;
}

// Notification creation data
export interface CreateNotificationData {
  userId: Id<"users">;
  leagueId?: Id<"leagues">;
  type: NotificationType;
  title: string;
  message: string;
  actionUrl?: string;
  actionText?: string;
  relatedEntityType?: RelatedEntityType;
  relatedEntityId?: string;
  priority: NotificationPriority;
  deliveryChannels: DeliveryChannel[];
  scheduledFor?: number;
  expiresAt?: number;
}

// Notification update data
export interface UpdateNotificationData {
  id: Id<"userNotifications">;
  status?: NotificationStatus;
  readAt?: number;
  clickedAt?: number;
  dismissedAt?: number;
  archivedAt?: number;
}

// Notification list component props
export interface NotificationListProps {
  leagueId?: Id<"leagues">;
  filters?: NotificationFilters;
  maxHeight?: string;
  showFilters?: boolean;
  compact?: boolean;
  onNotificationClick?: (notification: Notification) => void;
  onNotificationAction?: (notification: Notification) => void;
}

// Notification item component props
export interface NotificationItemProps {
  notification: Notification;
  onClick?: () => void;
  showActions?: boolean;
  compact?: boolean;
  onMarkAsRead?: (id: Id<"userNotifications">) => void;
  onMarkAsUnread?: (id: Id<"userNotifications">) => void;
  onDelete?: (id: Id<"userNotifications">) => void;
}

// Notification bell component props
export interface NotificationBellProps {
  leagueId?: Id<"leagues">;
  onClick?: () => void;
  className?: string;
  showCount?: boolean;
  size?: "sm" | "md" | "lg";
}

// Notification dropdown component props
export interface NotificationDropdownProps {
  leagueId?: Id<"leagues">;
  className?: string;
  align?: "start" | "center" | "end";
  side?: "top" | "right" | "bottom" | "left";
  maxNotifications?: number;
}

// Toast notification options
export interface ToastNotificationOptions {
  duration?: number;
  position?: "top-left" | "top-center" | "top-right" | "bottom-left" | "bottom-center" | "bottom-right";
  enableSound?: boolean;
  enableDesktop?: boolean;
  onAction?: () => void;
  onDismiss?: () => void;
}

// Notification context type for providers
export interface NotificationContextType {
  notifications: Notification[];
  unreadCount: number;
  isLoading: boolean;
  filters: NotificationFilters;
  setFilters: (filters: NotificationFilters) => void;
  markAsRead: (id: Id<"userNotifications">) => Promise<void>;
  markAsUnread: (id: Id<"userNotifications">) => Promise<void>;
  markAllAsRead: (leagueId?: Id<"leagues">) => Promise<void>;
  deleteNotification: (id: Id<"userNotifications">) => Promise<void>;
  refresh: () => void;
}

// Notification settings/preferences
export interface NotificationPreferences {
  enableInApp: boolean;
  enableEmail: boolean;
  enablePush: boolean;
  enableSound: boolean;
  enableDesktop: boolean;
  
  // Per-type preferences
  commentRequests: {
    enabled: boolean;
    priority: NotificationPriority;
    deliveryChannels: DeliveryChannel[];
  };
  
  commentFollowUps: {
    enabled: boolean;
    priority: NotificationPriority;
    deliveryChannels: DeliveryChannel[];
  };
  
  articlePublished: {
    enabled: boolean;
    priority: NotificationPriority;
    deliveryChannels: DeliveryChannel[];
  };
  
  systemAnnouncements: {
    enabled: boolean;
    priority: NotificationPriority;
    deliveryChannels: DeliveryChannel[];
  };
  
  // Timing preferences
  quietHours: {
    enabled: boolean;
    startTime: string; // "22:00"
    endTime: string;   // "08:00"
    timezone: string;
  };
  
  // Batching preferences
  batchSimilarNotifications: boolean;
  maxNotificationsPerBatch: number;
}

// Utility types for better type safety
export type NotificationIcon = "💬" | "⏰" | "🔄" | "🎉" | "📰" | "✨" | "📢" | "🏆" | "⚙️" | "🔔";

export type NotificationColor = 
  | "text-red-600 bg-red-50 border-red-200"      // urgent
  | "text-orange-600 bg-orange-50 border-orange-200" // high
  | "text-blue-600 bg-blue-50 border-blue-200"       // medium
  | "text-gray-600 bg-gray-50 border-gray-200";      // low

// Notification analytics/metrics
export interface NotificationMetrics {
  totalSent: number;
  totalDelivered: number;
  totalRead: number;
  totalClicked: number;
  totalDismissed: number;
  averageReadTime: number;
  clickThroughRate: number;
  
  // Per-type metrics
  byType: Record<NotificationType, {
    sent: number;
    delivered: number;
    read: number;
    clicked: number;
    averageReadTime: number;
  }>;
  
  // Per-priority metrics
  byPriority: Record<NotificationPriority, {
    sent: number;
    delivered: number;
    read: number;
    clicked: number;
  }>;
}

// Error types for notification operations
export class NotificationError extends Error {
  constructor(
    message: string,
    public code: "PERMISSION_DENIED" | "NOT_FOUND" | "INVALID_DATA" | "DELIVERY_FAILED",
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "NotificationError";
  }
}

// Event types for notification system
export interface NotificationEvents {
  created: (notification: Notification) => void;
  updated: (notification: Notification) => void;
  deleted: (notificationId: Id<"userNotifications">) => void;
  read: (notification: Notification) => void;
  clicked: (notification: Notification) => void;
  delivered: (notification: Notification, channel: DeliveryChannel) => void;
  failed: (notification: Notification, channel: DeliveryChannel, error: Error) => void;
}

// Hook return types
export interface UseNotificationsReturn {
  notifications: Notification[];
  unreadCount: number;
  hasUnreadNotifications: boolean;
  isLoading: boolean;
  error?: Error;
  
  // Actions
  markAsRead: (id: Id<"userNotifications">) => Promise<void>;
  markAsUnread: (id: Id<"userNotifications">) => Promise<void>;
  markAllAsRead: (leagueId?: Id<"leagues">) => Promise<void>;
  deleteNotification: (id: Id<"userNotifications">) => Promise<void>;
  
  // Utilities
  getNotificationIcon: (type: NotificationType) => NotificationIcon;
  getPriorityColor: (priority: NotificationPriority) => NotificationColor;
  refresh: () => void;
}

export interface UseNotificationReturn {
  notification?: Notification;
  isLoading: boolean;
  error?: Error;
}