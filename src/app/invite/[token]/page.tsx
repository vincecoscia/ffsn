"use client";

import { use } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import { useUser } from "@clerk/nextjs";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import Link from "next/link";
import { AlertTriangle, CheckCircle2 } from "lucide-react";

import {
  BrandLogo,
  ThemeToggle,
  Panel,
  StatBlock,
  TeamTile,
  LoadingScreen,
} from "@/components/broadcast";
import { Button } from "@/components/ui/button";

interface InvitePageProps {
  params: Promise<{ token: string }>;
}

function getInitials(name: string | undefined) {
  if (!name) return "FF";
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "FF";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

function StudioBackdrop({ children }: { children: ReactNode }) {
  return (
    <div className="bc-scan relative flex min-h-screen flex-col items-center justify-center overflow-hidden bg-bc-ground px-4 py-16">
      <div
        className="pointer-events-none absolute -top-24 -right-24 h-[420px] w-[420px] opacity-70"
        style={{
          background:
            "radial-gradient(circle, rgba(201,22,24,0.22) 0%, rgba(201,22,24,0.08) 35%, rgba(14,12,12,0) 68%)",
        }}
        aria-hidden="true"
      />
      <div className="absolute top-4 left-4 sm:top-6 sm:left-6">
        <BrandLogo size="md" />
      </div>
      <div className="absolute top-4 right-4 sm:top-6 sm:right-6">
        <ThemeToggle />
      </div>
      <div className="relative w-full max-w-xl">{children}</div>
    </div>
  );
}

export default function InvitePage({ params }: InvitePageProps) {
  const { user, isLoaded: userLoaded } = useUser();
  const router = useRouter();
  const [isClaiming, setIsClaiming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Unwrap the params Promise
  const { token } = use(params);

  const invitation = useQuery(api.teamInvitations.getByToken, {
    token: token,
  });

  const claimInvitation = useMutation(api.teamInvitations.claimInvitation);

  const handleClaimTeam = async () => {
    if (!user) {
      // Redirect to sign-in with return URL to come back to this invite page
      router.push(`/sign-in?redirect_url=${encodeURIComponent(`/invite/${token}`)}`);
      return;
    }

    setIsClaiming(true);
    setError(null);

    try {
      const leagueId = await claimInvitation({ token: token });

      // Add a small delay before redirect to ensure Convex reactivity catches up
      await new Promise((resolve) => setTimeout(resolve, 250));

      router.push(`/leagues/${leagueId}`);
    } catch (error) {
      console.error("Error claiming invitation:", error);
      const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";

      // Provide more specific error messages based on the error
      if (errorMessage.includes("LEAGUE_AT_CAPACITY")) {
        // The League Pass covers 12 managers; anyone past that needs a $10
        // seat the commissioner buys from league settings (spec §10.1).
        setError(
          "This league is at its 12 included managers. Ask your commissioner to add a seat ($10)."
        );
      } else if (errorMessage.includes("database consistency issue")) {
        setError("There was a temporary database issue. Please try again in a moment.");
      } else if (errorMessage.includes("User not found")) {
        setError("Authentication issue. Please sign out and try again.");
      } else if (errorMessage.includes("already claimed")) {
        setError("This team has already been claimed by another user.");
      } else if (errorMessage.includes("already have a team")) {
        setError("You already have a team in this league for this season.");
      } else {
        setError(`Failed to claim team: ${errorMessage}`);
      }
    } finally {
      setIsClaiming(false);
    }
  };

  if (!userLoaded || invitation === undefined) {
    return (
      <StudioBackdrop>
        <LoadingScreen message="Loading invitation" />
      </StudioBackdrop>
    );
  }

  if (!invitation) {
    return (
      <StudioBackdrop>
        <Panel padding="lg" className="flex flex-col items-center gap-5 text-center">
          <AlertTriangle className="size-10 text-bc-red-text" strokeWidth={1.6} />
          <div className="flex flex-col gap-2">
            <h1 className="bc-display text-bc-ink text-[32px]">Invalid invitation</h1>
            <p className="text-[15px] leading-relaxed text-bc-text-2">
              This invitation link is invalid or has expired.
            </p>
          </div>
          <Button asChild variant="glow" size="lg">
            <Link href="/dashboard">Go to dashboard</Link>
          </Button>
        </Panel>
      </StudioBackdrop>
    );
  }

  return (
    <StudioBackdrop>
      <Panel padding="lg" className="flex flex-col gap-8">
        <div className="flex flex-col items-center gap-3 text-center">
          <CheckCircle2 className="size-10 text-bc-win" strokeWidth={1.6} />
          <span className="bc-label text-bc-text-3">You&apos;re invited</span>
          <h1 className="bc-display text-bc-ink text-[32px] sm:text-[40px]">
            Join {invitation.league?.name}
          </h1>
          <p className="text-[15px] text-bc-text-2">Claim your team and get in the game.</p>
        </div>

        <div className="flex flex-col items-center gap-6 border-y border-bc-hairline py-6 sm:flex-row">
          <TeamTile
            initials={getInitials(invitation.teamName)}
            src={invitation.team?.logo}
            alt={invitation.teamName}
            size={64}
            tone="accent"
          />
          <div className="flex flex-1 flex-wrap items-center justify-center gap-x-10 gap-y-4 sm:justify-start">
            <StatBlock label="Team" value={invitation.teamName} />
            <StatBlock label="League" value={invitation.league?.name ?? "—"} />
            <StatBlock label="Season" value={invitation.seasonId} />
          </div>
        </div>

        {error && (
          <div className="border border-bc-red bg-bc-red/10 p-4">
            <p className="text-[14px] text-bc-red-text">{error}</p>
            <p className="mt-1.5 text-[13px] text-bc-text-2">
              Please try again or contact support if the issue persists.
            </p>
          </div>
        )}

        <div className="flex flex-col items-center gap-3">
          <Button
            onClick={handleClaimTeam}
            disabled={isClaiming}
            variant="glow"
            size="lg"
            className="w-full sm:w-auto"
          >
            {isClaiming ? "Claiming team..." : user ? "Claim team" : "Sign in to claim team"}
          </Button>
          <p className="text-[13px] text-bc-text-3">
            {user
              ? "Click to claim this team and join the league"
              : "You'll need to sign in first to claim this team"}
          </p>
        </div>
      </Panel>
    </StudioBackdrop>
  );
}
