"use client";

import { useState, useEffect } from "react";
import { useUser } from "@clerk/nextjs";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../../../../convex/_generated/api";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { toast } from "sonner";
import { Bell, Mail, Settings, Shield } from "lucide-react";

export default function NotificationSettingsPage() {
  const { user } = useUser();
  const [isLoading, setIsLoading] = useState(false);

  // Get user preferences
  const userPreferences = useQuery(api.users.getUserPreferences, 
    user ? { clerkId: user.id } : "skip"
  );

  // Update user preferences mutation
  const updatePreferences = useMutation(api.users.updateUserPreferences);

  const [emailNotifications, setEmailNotifications] = useState(true);

  // Sync with fetched preferences
  useEffect(() => {
    if (userPreferences?.preferences) {
      setEmailNotifications(userPreferences.preferences.emailNotifications ?? true);
    }
  }, [userPreferences]);

  const handleEmailNotificationChange = async (enabled: boolean) => {
    if (!user) return;

    setIsLoading(true);
    try {
      await updatePreferences({
        clerkId: user.id,
        preferences: {
          emailNotifications: enabled,
        },
      });

      setEmailNotifications(enabled);
      toast.success(
        enabled 
          ? "Email notifications enabled successfully" 
          : "Email notifications disabled successfully"
      );
    } catch (error) {
      console.error("Failed to update email preferences:", error);
      toast.error("Failed to update email preferences. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };

  if (!user) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center">
          <h2 className="text-xl font-semibold mb-2">Please sign in</h2>
          <p className="text-muted-foreground">You need to be signed in to access notification settings.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="container max-w-4xl mx-auto px-4 sm:px-6 py-6">
      <div className="space-y-6">
        {/* Header */}
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Settings className="h-6 w-6" />
            <h1 className="text-3xl font-bold">Notification Settings</h1>
          </div>
          <p className="text-muted-foreground">
            Manage how you receive notifications from FFSN. You can control both in-app and email notifications.
          </p>
        </div>

        {/* Email Notifications Card */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Mail className="h-5 w-5" />
              <CardTitle>Email Notifications</CardTitle>
            </div>
            <CardDescription>
              Control when FFSN sends you email notifications. You&apos;ll still receive in-app notifications regardless of this setting.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="space-y-1">
                <Label htmlFor="email-notifications" className="text-base font-medium">
                  Send email notifications
                </Label>
                <p className="text-sm text-muted-foreground">
                  Receive email notifications for comment requests, article updates, and other important activities.
                </p>
              </div>
              <Switch
                id="email-notifications"
                checked={emailNotifications}
                onCheckedChange={handleEmailNotificationChange}
                disabled={isLoading}
              />
            </div>

            <Separator />

            <div className="space-y-3">
              <h4 className="font-medium flex items-center gap-2">
                <Bell className="h-4 w-4" />
                What you&apos;ll receive emails for:
              </h4>
              <ul className="space-y-2 text-sm text-muted-foreground ml-6">
                <li>• Comment requests for articles</li>
                <li>• Follow-up questions in conversations</li>
                <li>• Reminders for pending comment requests</li>
                <li>• Thank you messages when articles are published</li>
                <li>• Important league updates and announcements</li>
              </ul>
            </div>

            <div className="mt-4 p-4 bg-muted/50 rounded-lg">
              <div className="flex items-start gap-2">
                <Shield className="h-4 w-4 mt-0.5 text-muted-foreground" />
                <div className="space-y-1">
                  <p className="text-sm font-medium">Privacy & Unsubscribe</p>
                  <p className="text-sm text-muted-foreground">
                    All emails include an unsubscribe link. You can also manage your preferences here at any time. 
                    We never share your email address with third parties.
                  </p>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* In-App Notifications Card */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Bell className="h-5 w-5" />
              <CardTitle>In-App Notifications</CardTitle>
            </div>
            <CardDescription>
              In-app notifications appear in the notification bell at the top of the page. These cannot be disabled.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between">
              <div className="space-y-1">
                <Label className="text-base font-medium">
                  In-app notifications
                </Label>
                <p className="text-sm text-muted-foreground">
                  Always enabled to ensure you don&apos;t miss important updates about your leagues and comment requests.
                </p>
              </div>
              <Switch
                checked={true}
                disabled={true}
                className="opacity-50"
              />
            </div>
          </CardContent>
        </Card>

        {/* Account Info */}
        <Card>
          <CardHeader>
            <CardTitle>Account Information</CardTitle>
            <CardDescription>
              Your account details used for notifications.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="flex justify-between">
              <span className="text-sm font-medium">Email Address:</span>
              <span className="text-sm text-muted-foreground">
                {user.emailAddresses[0]?.emailAddress || "No email address"}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-sm font-medium">Name:</span>
              <span className="text-sm text-muted-foreground">
                {user.fullName || user.firstName || "No name set"}
              </span>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
