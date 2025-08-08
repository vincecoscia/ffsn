"use client";

import { useEffect, useRef, useCallback } from "react";
import { toast } from "sonner";
import { ExternalLink, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useNotifications } from "./hooks/useNotifications";
import { Doc, Id } from "../../../convex/_generated/dataModel";
import Link from "next/link";

interface NotificationToastProps {
  leagueId?: Id<"leagues">;
  enableSound?: boolean;
  enableDesktopNotifications?: boolean;
}

export function NotificationToastProvider({ 
  leagueId, 
  enableSound = true,
  enableDesktopNotifications = true 
}: NotificationToastProps) {
  const { notifications, getNotificationIcon } = useNotifications({
    leagueId,
    limit: 10
  });
  
  const prevNotificationsRef = useRef<typeof notifications>([]);
  // Audio disabled
  
  // Request desktop notification permission
  useEffect(() => {
    if (enableDesktopNotifications && typeof window !== "undefined" && "Notification" in window) {
      if (Notification.permission === "default") {
        Notification.requestPermission();
      }
    }
  }, [enableDesktopNotifications]);
  
  const showNotificationToast = useCallback((notification: Doc<"userNotifications">) => {
    const icon = getNotificationIcon(notification.type);
    const isUrgent = notification.priority === "urgent";
    
    toast(
      <div className="flex items-start gap-3 w-full">
        <div className="flex-shrink-0 text-lg">
          {icon}
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-medium text-gray-900 text-sm leading-tight">
            {notification.title}
          </div>
          <div className="text-gray-600 text-sm mt-1 leading-relaxed">
            {notification.message.length > 120 
              ? `${notification.message.substring(0, 120)}...` 
              : notification.message
            }
          </div>
          {notification.actionUrl && notification.actionText && (
            <div className="mt-2">
              <Button
                asChild
                size="sm"
                variant={isUrgent ? "default" : "outline"}
                className="text-xs h-7"
              >
                <Link href={notification.actionUrl}>
                  {notification.actionText}
                  <ExternalLink className="ml-1 h-3 w-3" />
                </Link>
              </Button>
            </div>
          )}
        </div>
      </div>,
      {
        duration: isUrgent ? 10000 : 5000,
        position: "top-right",
        className: isUrgent 
          ? "border-red-200 bg-red-50" 
          : notification.priority === "high"
          ? "border-orange-200 bg-orange-50"
          : "border-blue-200 bg-blue-50",
        closeButton: true,
        action: notification.actionUrl ? {
          label: "View",
          onClick: () => {
            if (notification.actionUrl) {
              window.location.href = notification.actionUrl;
            }
          }
        } : undefined,
      }
    );
  }, [getNotificationIcon]);
  
  // Watch for new notifications
  useEffect(() => {
    if (!notifications || notifications.length === 0) {
      prevNotificationsRef.current = notifications || [];
      return;
    }
    
    const prevNotifications = prevNotificationsRef.current || [];
    const newNotifications = notifications.filter(
      notification => !prevNotifications.some(prev => prev._id === notification._id)
    );
    
    // Show toast for new notifications
    newNotifications.forEach(notification => {
      if (notification.status === "unread") {
        showNotificationToast(notification);
        
        // Sound disabled
        
        // Show desktop notification if enabled and permission granted
        if (enableDesktopNotifications && typeof window !== "undefined" && "Notification" in window) {
          if (Notification.permission === "granted") {
            const desktopNotification = new Notification(notification.title, {
              body: notification.message,
              icon: "/ffsn-icon.png",
              badge: "/ffsn-badge.png",
              tag: notification._id,
              requireInteraction: notification.priority === "urgent",
            });
            
            desktopNotification.onclick = () => {
              window.focus();
              if (notification.actionUrl) {
                window.location.href = notification.actionUrl;
              }
              desktopNotification.close();
            };
            
            // Auto-close after 5 seconds for non-urgent notifications
            if (notification.priority !== "urgent") {
              setTimeout(() => desktopNotification.close(), 5000);
            }
          }
        }
      }
    });
    
    prevNotificationsRef.current = notifications;
  }, [notifications, enableSound, enableDesktopNotifications, showNotificationToast]);
  
  return null; // This is a provider component, no UI
}

// Custom toast component for showing notification details
export function showCustomNotificationToast(
  notification: Doc<"userNotifications">,
  options: {
    onAction?: () => void;
    onDismiss?: () => void;
  } = {}
) {
  const isUrgent = notification.priority === "urgent";
  
  return toast.custom(
    (t) => (
      <div 
        className={`w-full max-w-md p-4 rounded-lg shadow-lg border-l-4 bg-white ${
          isUrgent 
            ? "border-l-red-500" 
            : notification.priority === "high"
            ? "border-l-orange-500"
            : "border-l-blue-500"
        }`}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3 flex-1">
            <div className="flex-shrink-0 w-10 h-10 rounded-full bg-gray-100 flex items-center justify-center text-lg">
              💬
            </div>
            <div className="flex-1 min-w-0">
              <div className="font-semibold text-gray-900 text-sm">
                {notification.title}
              </div>
              <div className="text-gray-600 text-sm mt-1">
                {notification.message}
              </div>
              {notification.actionUrl && (
                <div className="mt-3 flex gap-2">
                  <Button
                    size="sm"
                    variant="default"
                    className="text-xs"
                    onClick={() => {
                      options.onAction?.();
                      toast.dismiss(t);
                      if (notification.actionUrl) {
                        window.location.href = notification.actionUrl;
                      }
                    }}
                  >
                    {notification.actionText || "View"}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="text-xs"
                    onClick={() => {
                      options.onDismiss?.();
                      toast.dismiss(t);
                    }}
                  >
                    Dismiss
                  </Button>
                </div>
              )}
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 flex-shrink-0"
            onClick={() => toast.dismiss(t)}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>
    ),
    {
      duration: isUrgent ? 15000 : 8000,
      position: "top-right",
    }
  );
}