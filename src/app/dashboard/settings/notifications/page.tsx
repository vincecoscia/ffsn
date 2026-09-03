"use client";

import { useState, useEffect } from "react";
import { useUser } from "@clerk/nextjs";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../../../../convex/_generated/api";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { Bell, Mail, Shield, VolumeX } from "lucide-react";
import { PageHeader, Panel, SectionHeader } from "@/components/broadcast";

const EMAIL_TOPICS = [
  "Comment requests for articles",
  "Follow-up questions in conversations",
  "Reminders for pending comment requests",
  "Thank you messages when articles are published",
  "Important league updates and announcements",
];

export default function NotificationSettingsPage() {
  const { user } = useUser();
  const [isLoading, setIsLoading] = useState(false);

  // Get user preferences (derived from the authenticated identity server-side)
  const userPreferences = useQuery(api.users.getUserPreferences, {});

  // Update user preferences mutation
  const updatePreferences = useMutation(api.users.updateUserPreferences);
  // "Keep it clean about my team" (owner ask, Sept 2026): a separate mutation because
  // users.updatePreferences replaces the whole preferences object rather than merging it.
  const updateCleanLanguage = useMutation(api.users.updatePreferences);

  const [emailNotifications, setEmailNotifications] = useState(true);
  const [cleanLanguage, setCleanLanguage] = useState(false);

  // Sync with fetched preferences
  useEffect(() => {
    if (userPreferences?.preferences) {
      setEmailNotifications(userPreferences.preferences.emailNotifications ?? true);
      setCleanLanguage(userPreferences.preferences.cleanLanguage ?? false);
    }
  }, [userPreferences]);

  const handleEmailNotificationChange = async (enabled: boolean) => {
    if (!user) return;

    setIsLoading(true);
    try {
      await updatePreferences({
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

  const handleCleanLanguageChange = async (enabled: boolean) => {
    if (!user) return;

    setIsLoading(true);
    try {
      // updatePreferences replaces the whole preferences object, so the current values ride
      // along rather than getting clobbered.
      await updateCleanLanguage({
        preferences: {
          emailNotifications,
          favoriteTeam: userPreferences?.preferences?.favoriteTeam,
          timezone: userPreferences?.preferences?.timezone,
          cleanLanguage: enabled,
        },
      });

      setCleanLanguage(enabled);
      toast.success(
        enabled
          ? "Coverage of your team will stay clean"
          : "Coverage of your team will follow the league's language setting"
      );
    } catch (error) {
      console.error("Failed to update clean-language preference:", error);
      toast.error("Failed to update this setting. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };

  if (!user) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-bc-ground">
        <div className="text-center">
          <h2 className="font-display mb-2 text-xl font-bold text-bc-ink uppercase">
            Please sign in
          </h2>
          <p className="text-bc-text-2">You need to be signed in to access notification settings.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-bc-ground">
      <main className="mx-auto max-w-4xl px-4 py-8 sm:px-6 lg:px-12">
        <PageHeader
          kicker="Preferences"
          title="Notification settings"
          description="Manage how you receive notifications from FFSN — both in-app and email."
        />

        <div className="mt-10 flex flex-col gap-6">
          <Panel padding="md" className="flex flex-col gap-5">
            <SectionHeader
              title="Email notifications"
              actions={<Mail className="size-5 text-bc-text-3" strokeWidth={1.8} />}
            />
            <p className="text-sm text-bc-text-2">
              Control when FFSN sends you email notifications. You&apos;ll still receive in-app
              notifications regardless of this setting.
            </p>

            <div className="flex items-center justify-between gap-4 border-t border-bc-hairline pt-4">
              <div className="flex flex-col gap-1">
                <Label htmlFor="email-notifications" className="font-display text-base font-semibold text-bc-ink">
                  Send email notifications
                </Label>
                <p className="max-w-md text-sm text-bc-text-2">
                  Receive email notifications for comment requests, article updates, and other
                  important activities.
                </p>
              </div>
              <Switch
                id="email-notifications"
                checked={emailNotifications}
                onCheckedChange={handleEmailNotificationChange}
                disabled={isLoading}
              />
            </div>

            <div className="flex flex-col gap-3 border-t border-bc-hairline pt-4">
              <h4 className="flex items-center gap-2.5 font-display text-sm font-semibold text-bc-ink uppercase tracking-[0.04em]">
                <Bell className="size-4" strokeWidth={1.8} />
                What you&apos;ll receive emails for
              </h4>
              <ul className="flex flex-col gap-2">
                {EMAIL_TOPICS.map((topic) => (
                  <li key={topic} className="flex items-center gap-2.5 text-sm text-bc-body">
                    <span className="bc-sep bc-sep-muted" aria-hidden="true" />
                    {topic}
                  </li>
                ))}
              </ul>
            </div>

            <div className="flex items-start gap-2.5 bg-bc-panel-2 p-4">
              <Shield className="mt-0.5 size-4 flex-none text-bc-text-3" strokeWidth={1.8} />
              <div className="flex flex-col gap-1">
                <p className="text-sm font-semibold text-bc-ink">Privacy and unsubscribe</p>
                <p className="text-sm text-bc-text-2">
                  All emails include an unsubscribe link. You can also manage your preferences here
                  at any time. We never share your email address with third parties.
                </p>
              </div>
            </div>
          </Panel>

          <Panel padding="md" className="flex flex-col gap-5">
            <SectionHeader
              title="Coverage of my team"
              actions={<VolumeX className="size-5 text-bc-text-3" strokeWidth={1.8} />}
            />
            <div className="flex items-center justify-between gap-4 border-t border-bc-hairline pt-4">
              <div className="flex flex-col gap-1">
                <Label htmlFor="clean-language" className="font-display text-base font-semibold text-bc-ink">
                  Keep it clean about my team
                </Label>
                <p className="max-w-md text-sm text-bc-text-2">
                  The desk writes about your team as if the league&apos;s language setting were
                  Clean.
                </p>
              </div>
              <Switch
                id="clean-language"
                checked={cleanLanguage}
                onCheckedChange={handleCleanLanguageChange}
                disabled={isLoading}
              />
            </div>
          </Panel>

          <Panel padding="md" className="flex flex-col gap-5">
            <SectionHeader
              title="In-app notifications"
              actions={<Bell className="size-5 text-bc-text-3" strokeWidth={1.8} />}
            />
            <p className="text-sm text-bc-text-2">
              In-app notifications appear in the notification bell at the top of the page. These
              cannot be disabled.
            </p>
            <div className="flex items-center justify-between gap-4 border-t border-bc-hairline pt-4">
              <div className="flex flex-col gap-1">
                <Label className="font-display text-base font-semibold text-bc-ink">
                  In-app notifications
                </Label>
                <p className="max-w-md text-sm text-bc-text-2">
                  Always enabled to ensure you don&apos;t miss important updates about your leagues
                  and comment requests.
                </p>
              </div>
              <Switch checked disabled className="opacity-50" />
            </div>
          </Panel>

          <Panel padding="md" className="flex flex-col gap-4">
            <SectionHeader title="Account information" />
            <div className="flex flex-col gap-2.5">
              <div className="flex items-center justify-between gap-4">
                <span className="text-sm font-semibold text-bc-ink">Email address</span>
                <span className="text-sm text-bc-text-2">
                  {user.emailAddresses[0]?.emailAddress || "No email address"}
                </span>
              </div>
              <div className="flex items-center justify-between gap-4 border-t border-bc-hairline pt-2.5">
                <span className="text-sm font-semibold text-bc-ink">Name</span>
                <span className="text-sm text-bc-text-2">
                  {user.fullName || user.firstName || "No name set"}
                </span>
              </div>
            </div>
          </Panel>
        </div>
      </main>
    </div>
  );
}
