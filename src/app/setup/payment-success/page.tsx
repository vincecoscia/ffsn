"use client";

import { useEffect, useState, useCallback, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { useAction, useMutation } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { UserButton } from "@clerk/nextjs";
import { Progress } from "@/components/ui/progress";
import { Button } from "@/components/ui/button";
import { CheckCircle2, CreditCard, Users, Zap, AlertCircle } from "lucide-react";

import { TopBar, ThemeToggle, Panel, Chip, LoadingScreen } from "@/components/broadcast";

interface SyncProgress {
  step: number;
  totalSteps: number;
  message: string;
  percentage: number;
}

function ChecklistRow({
  icon,
  title,
  description,
  done,
  active,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  done: boolean;
  active: boolean;
}) {
  return (
    <div className="flex items-center gap-4">
      <span
        className={
          "flex size-10 flex-none items-center justify-center border " +
          (done
            ? "border-bc-win bg-bc-win text-white"
            : active
              ? "border-bc-red text-bc-red-text"
              : "border-bc-border-strong text-bc-text-3")
        }
      >
        {icon}
      </span>
      <div className="flex flex-1 flex-col gap-0.5">
        <h3 className="bc-label text-bc-ink">{title}</h3>
        <p className="text-[13px] text-bc-text-2">{description}</p>
      </div>
      {done && <CheckCircle2 className="size-5 flex-none text-bc-win" strokeWidth={1.8} />}
    </div>
  );
}

function PaymentSuccessContent() {
  const [, setIsLoading] = useState(true);
  const [paymentVerified, setPaymentVerified] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [leagueCreated, setLeagueCreated] = useState(false);
  const [syncProgress, setSyncProgress] = useState<SyncProgress | null>(null);
  const [, setLeagueId] = useState<string | null>(null);

  const searchParams = useSearchParams();
  const router = useRouter();

  const verifyPayment = useAction(api.stripe.verifyPaymentCompleted);
  const completeOnboarding = useMutation(api.users.completeOnboarding);
  const syncAllLeagueData = useAction(api.espnSync.syncAllLeagueData);
  const syncHistoricalLeaguePlayerStats = useAction(
    api.playerHistoricalSync.syncHistoricalLeaguePlayerStats
  );
  const linkPaymentToLeague = useMutation(api.payments.linkPaymentToLeague);

  const processPaymentSuccess = useCallback(
    async (sessionId: string) => {
      try {
        // Step 1: Verify payment with Stripe
        setSyncProgress({
          step: 1,
          totalSteps: 6,
          message: "Verifying payment...",
          percentage: 10,
        });

        const paymentResult = await verifyPayment({ sessionId });

        if (!paymentResult.fulfilled) {
          throw new Error("Payment verification failed");
        }

        setPaymentVerified(true);

        // Step 2: Extract league data from payment metadata
        setSyncProgress({
          step: 2,
          totalSteps: 6,
          message: "Processing league data...",
          percentage: 25,
        });

        const metadata = paymentResult.metadata;
        if (!metadata || !metadata.leagueId) {
          throw new Error("Missing league information in payment");
        }

        // Step 3: Get the existing league ID from metadata
        setSyncProgress({
          step: 3,
          totalSteps: 6,
          message: "Retrieving league information...",
          percentage: 40,
        });

        const leagueId = metadata.leagueId;
        if (!leagueId) {
          throw new Error("League ID not found in payment metadata");
        }

        setLeagueId(leagueId);
        setLeagueCreated(true);

        // Link the payment to the existing league
        await linkPaymentToLeague({
          userId: metadata.userId,
          leagueId: leagueId as Id<"leagues">,
          paymentType: "league_creation" as const,
        });

        // Step 4: Sync ESPN data
        setSyncProgress({
          step: 4,
          totalSteps: 6,
          message: "Syncing ESPN data...",
          percentage: 60,
        });

        await syncAllLeagueData({
          leagueId: leagueId as Id<"leagues">,
          includeCurrentSeason: true,
          historicalYears: 5,
        });

        // Step 5: Backfill top performers for older seasons (skip if already cached)
        setSyncProgress({
          step: 5,
          totalSteps: 6,
          message: "Backfilling top performers for prior seasons...",
          percentage: 70,
        });

        await syncHistoricalLeaguePlayerStats({
          leagueId: leagueId as Id<"leagues">,
        });

        // Step 6: Finalize setup
        setSyncProgress({
          step: 6,
          totalSteps: 6,
          message: "Finalizing setup...",
          percentage: 80,
        });

        await completeOnboarding();

        // Step 7: Complete
        setSyncProgress({
          step: 7,
          totalSteps: 7,
          message: "All done! Welcome to FFSN!",
          percentage: 100,
        });

        // Small delay to show completion
        await new Promise((resolve) => setTimeout(resolve, 1500));
      } catch (error) {
        console.error("Payment processing error:", error);
        setError(error instanceof Error ? error.message : "An unexpected error occurred");
      } finally {
        setIsLoading(false);
      }
    },
    [
      verifyPayment,
      setPaymentVerified,
      setLeagueId,
      setLeagueCreated,
      linkPaymentToLeague,
      syncAllLeagueData,
      syncHistoricalLeaguePlayerStats,
      completeOnboarding,
      setSyncProgress,
      setError,
      setIsLoading,
    ]
  );

  useEffect(() => {
    const sessionId = searchParams?.get("session_id");

    if (!sessionId) {
      setError("No payment session found. Please try again.");
      setIsLoading(false);
      return;
    }

    processPaymentSuccess(sessionId);
  }, [searchParams, processPaymentSuccess]);

  if (error) {
    return (
      <div className="min-h-screen bg-bc-ground">
        <TopBar title="New league" subtitle="Payment processing">
          <ThemeToggle />
          <UserButton />
        </TopBar>
        <main className="mx-auto flex max-w-md flex-col px-4 py-16 sm:px-6">
          <Panel padding="lg" className="flex flex-col items-center gap-4 border-bc-red text-center">
            <AlertCircle className="size-10 text-bc-red-text" strokeWidth={1.6} />
            <h2 className="bc-display text-bc-ink text-[26px]">Payment processing error</h2>
            <p className="text-[14px] leading-relaxed text-bc-text-2">{error}</p>
            <div className="flex w-full flex-col gap-3 pt-2">
              <Button onClick={() => router.push("/setup")} variant="glow" size="lg" className="w-full">
                Return to setup
              </Button>
              <Button
                onClick={() => router.push("/dashboard")}
                variant="outline"
                size="lg"
                className="w-full"
              >
                Go to dashboard
              </Button>
            </div>
          </Panel>
        </main>
      </div>
    );
  }

  const isComplete = syncProgress?.percentage === 100;

  return (
    <div className="min-h-screen bg-bc-ground">
      <TopBar title="New league" subtitle="Payment processing">
        <ThemeToggle />
        <UserButton />
      </TopBar>

      <main className="mx-auto flex max-w-2xl flex-col gap-8 px-4 py-12 sm:px-6 sm:py-16">
        <div className="flex flex-col items-center gap-4 text-center">
          <Chip live>Live</Chip>
          <h1 className="bc-display text-bc-ink text-[40px] sm:text-[52px]">You&apos;re on the air</h1>
          <p className="text-[15px] text-bc-text-2">
            Setting up your fantasy league with AI-powered content.
          </p>
        </div>

        {syncProgress && (
          <Panel padding="md" className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <span className="text-[14px] text-bc-text-2">{syncProgress.message}</span>
              <span className="bc-num text-[14px] text-bc-text-3">{syncProgress.percentage}%</span>
            </div>
            <Progress value={syncProgress.percentage} className="h-2" />
            <div className="flex items-center justify-between text-[12px] text-bc-text-3">
              <span>
                Step {syncProgress.step} of {syncProgress.totalSteps}
              </span>
              {isComplete && <span className="text-bc-win">Complete</span>}
            </div>
          </Panel>
        )}

        {syncProgress && !isComplete && (
          <div className="border border-bc-signal/40 bg-bc-signal/10 p-3.5 text-[14px] text-bc-signal">
            This sync can take up to 5 minutes depending on your league size.
          </div>
        )}

        <Panel padding="lg" className="flex flex-col gap-6">
          <ChecklistRow
            icon={<CreditCard className="size-4" strokeWidth={1.8} />}
            title="Payment processed"
            description="$99.99 charged successfully"
            done={paymentVerified}
            active={!paymentVerified}
          />
          <ChecklistRow
            icon={<Users className="size-4" strokeWidth={1.8} />}
            title="League created"
            description="ESPN data synced and ready"
            done={leagueCreated}
            active={paymentVerified && !leagueCreated}
          />
          <ChecklistRow
            icon={<Zap className="size-4" strokeWidth={1.8} />}
            title="1,000 credits added"
            description="Ready for AI content generation"
            done={isComplete}
            active={leagueCreated && !isComplete}
          />
        </Panel>

        {isComplete && (
          <div className="flex flex-col items-center gap-4">
            <div className="w-full border border-bc-win/40 bg-bc-win/10 p-4 text-center">
              <p className="text-[14px] leading-relaxed text-bc-win">
                Success. Your league is ready. Team members who join will receive 100 bonus
                credits each.
              </p>
            </div>
            <Button
              onClick={() => router.push("/dashboard")}
              variant="glow"
              size="lg"
              className="w-full"
            >
              Go to dashboard
            </Button>
          </div>
        )}
      </main>
    </div>
  );
}

export default function PaymentSuccessPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-bc-ground">
          <LoadingScreen message="Loading payment details" />
        </div>
      }
    >
      <PaymentSuccessContent />
    </Suspense>
  );
}
