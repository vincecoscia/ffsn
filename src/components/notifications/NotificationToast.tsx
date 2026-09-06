"use client";

import { useEffect, useRef, useCallback } from "react";
import { toast } from "sonner";
import {
  ExternalLink,
  X,
  MessageSquare,
  Clock,
  RotateCw,
  PartyPopper,
  Newspaper,
  Sparkles,
  Megaphone,
  Trophy,
  Settings,
  Bell,
  type LucideIcon, Radio } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useNotifications } from "./hooks/useNotifications";
import { Doc, Id } from "../../../convex/_generated/dataModel";
import Link from "next/link";

interface NotificationToastProps {
  leagueId?: Id<"leagues">;
  enableSound?: boolean;
  enableDesktopNotifications?: boolean;
}

// Icon per notification type — no emoji in the UI, per the design system.
const TYPE_ICONS: Record<string, LucideIcon> = {
  comment_request: MessageSquare,
  comment_reminder: Clock,
  comment_follow_up: RotateCw,
  comment_thank_you: PartyPopper,
  article_published: Newspaper,
  article_generated: Sparkles,
  system_announcement: Megaphone,
  league_invitation: Trophy,
  account_update: Settings,
  wire_alert: Radio,
};

function iconFor(type: string): LucideIcon {
  return TYPE_ICONS[type] ?? Bell;
}

export function NotificationToastProvider({
  leagueId,
  enableSound = true,
  enableDesktopNotifications = true
}: NotificationToastProps) {
  const { notifications } = useNotifications({
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
    const Icon = iconFor(notification.type);
    const isUrgent = notification.priority === "urgent";

    toast(
      <div className="flex w-full items-start gap-3">
        <span className="mt-0.5 inline-flex size-8 flex-none items-center justify-center border border-bc-hairline bg-bc-panel-2 text-bc-text-2">
          <Icon className="size-4" strokeWidth={1.8} aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="font-display text-[14px] leading-tight font-bold text-bc-ink uppercase">
            {notification.title}
          </div>
          <div className="mt-1 text-[13px] leading-relaxed text-bc-text-2">
            {notification.message.length > 120
              ? `${notification.message.substring(0, 120)}...`
              : notification.message
            }
          </div>
          {notification.actionUrl && notification.actionText && (
            <div className="mt-2.5">
              <Button
                asChild
                size="xs"
                variant={isUrgent ? "default" : "outline"}
              >
                <Link href={notification.actionUrl}>
                  {notification.actionText}
                  <ExternalLink className="size-3" strokeWidth={2} />
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
          ? "border-bc-red bg-bc-panel"
          : notification.priority === "high"
          ? "border-bc-red-deep bg-bc-panel"
          : "border-bc-signal bg-bc-panel",
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
  }, []);

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
  const Icon = iconFor(notification.type);

  return toast.custom(
    (t) => (
      <div
        className={`w-full max-w-md border-l-4 bg-bc-panel p-4 ${
          isUrgent
            ? "border-l-bc-red"
            : notification.priority === "high"
            ? "border-l-bc-red-deep"
            : "border-l-bc-signal"
        }`}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex flex-1 items-start gap-3">
            <span className="inline-flex size-9 flex-none items-center justify-center border border-bc-hairline bg-bc-panel-2 text-bc-text-2">
              <Icon className="size-4" strokeWidth={1.8} aria-hidden="true" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="font-display text-[14px] font-bold text-bc-ink uppercase">
                {notification.title}
              </div>
              <div className="mt-1 text-[13px] text-bc-text-2">
                {notification.message}
              </div>
              {notification.actionUrl && (
                <div className="mt-3 flex gap-2">
                  <Button
                    size="xs"
                    variant="default"
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
                    size="xs"
                    variant="outline"
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
            size="icon-sm"
            onClick={() => toast.dismiss(t)}
          >
            <X className="size-4" strokeWidth={1.8} />
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
