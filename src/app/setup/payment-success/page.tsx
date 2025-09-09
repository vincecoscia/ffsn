"use client";

import { useEffect, useState, useCallback, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { useAction, useMutation } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { UserButton } from "@clerk/nextjs";
import Link from "next/link";
import { Progress } from "@/components/ui/progress";
import { Button } from "@/components/ui/button";
import { CheckCircle, CreditCard, Users, Zap, AlertCircle } from "lucide-react";

interface SyncProgress {
  step: number;
  totalSteps: number;
  message: string;
  percentage: number;
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
  const syncHistoricalLeaguePlayerStats = useAction(api.playerHistoricalSync.syncHistoricalLeaguePlayerStats);
  const linkPaymentToLeague = useMutation(api.payments.linkPaymentToLeague);

  const processPaymentSuccess = useCallback(async (sessionId: string) => {
    try {
      // Step 1: Verify payment with Stripe
      setSyncProgress({ 
        step: 1, 
        totalSteps: 6, 
        message: "Verifying payment...", 
        percentage: 10 
      });

      const paymentResult = await verifyPayment({ sessionId });
      
      if (!paymentResult.success) {
        throw new Error("Payment verification failed");
      }

      setPaymentVerified(true);
      
      // Step 2: Extract league data from payment metadata
      setSyncProgress({ 
        step: 2, 
        totalSteps: 6, 
        message: "Processing league data...", 
        percentage: 25 
      });

      const metadata = paymentResult.session?.metadata;
      if (!metadata || !metadata.leagueId) {
        throw new Error("Missing league information in payment");
      }

      // Step 3: Get the existing league ID from metadata
      setSyncProgress({ 
        step: 3, 
        totalSteps: 6, 
        message: "Retrieving league information...", 
        percentage: 40 
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
        percentage: 60 
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
        percentage: 80 
      });

      await completeOnboarding();

      // Step 7: Complete
      setSyncProgress({ 
        step: 7, 
        totalSteps: 7, 
        message: "All done! Welcome to FFSN!", 
        percentage: 100 
      });

      // Small delay to show completion
      await new Promise(resolve => setTimeout(resolve, 1500));

    } catch (error) {
      console.error("Payment processing error:", error);
      setError(error instanceof Error ? error.message : "An unexpected error occurred");
    } finally {
      setIsLoading(false);
    }
  }, [verifyPayment, setPaymentVerified, setLeagueId, setLeagueCreated, linkPaymentToLeague, syncAllLeagueData, syncHistoricalLeaguePlayerStats, completeOnboarding, setSyncProgress, setError, setIsLoading]);

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
      <div className="min-h-screen bg-gray-900 flex items-center justify-center">
        <div className="max-w-md w-full mx-4">
          <div className="bg-red-900/50 border border-red-500 p-6 rounded-lg text-center">
            <AlertCircle className="w-12 h-12 text-red-400 mx-auto mb-4" />
            <h2 className="text-xl font-bold text-white mb-2">Payment Processing Error</h2>
            <p className="text-red-200 text-sm mb-4">{error}</p>
            <div className="space-y-2">
              <Button 
                onClick={() => router.push("/setup")}
                className="w-full bg-red-600 hover:bg-red-700"
              >
                Return to Setup
              </Button>
              <Button 
                onClick={() => router.push("/dashboard")}
                variant="outline"
                className="w-full"
              >
                Go to Dashboard
              </Button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-900">
      <header className="bg-gray-800 border-b border-gray-700">
        <div className="container mx-auto px-6 py-4 flex justify-between items-center">
          <Link href="/" className="text-2xl font-bold text-white cursor-pointer">
            FFSN
          </Link>
          <div className="flex items-center gap-4">
            <span className="text-gray-300">Payment Processing</span>
            <UserButton />
          </div>
        </div>
      </header>

      <main className="container mx-auto px-6 py-8 max-w-2xl">
        <div className="text-center mb-8">
          <div className="w-16 h-16 bg-green-600 rounded-full flex items-center justify-center mx-auto mb-4">
            <CheckCircle className="w-10 h-10 text-white" />
          </div>
          <h1 className="text-3xl font-black text-white mb-2">
            Payment Successful!
          </h1>
          <p className="text-gray-400">
            Setting up your fantasy league with AI-powered content
          </p>
        </div>

        {syncProgress && (
          <div className="bg-gray-800 rounded-lg p-6 mb-6">
            <div className="flex items-center justify-between text-sm mb-2">
              <span className="text-gray-300">{syncProgress.message}</span>
              <span className="text-gray-400">{syncProgress.percentage}%</span>
            </div>
            <Progress value={syncProgress.percentage} className="h-3 mb-2" />
            <div className="flex items-center justify-between text-xs text-gray-400">
              <span>Step {syncProgress.step} of {syncProgress.totalSteps}</span>
              {syncProgress.percentage === 100 && (
                <span className="text-green-400">✓ Complete</span>
              )}
            </div>
          </div>
        )}

        {syncProgress && syncProgress.percentage < 100 && (
          <div className="bg-blue-900/50 border border-blue-500 p-3 rounded-md mb-6 text-blue-100 text-sm">
            ⏱️ This sync can take up to 5 minutes depending on your league size.
          </div>
        )}

        <div className="bg-gray-800 rounded-lg p-6 space-y-4">
          <div className="flex items-center space-x-3">
            <div className={`w-8 h-8 rounded-full flex items-center justify-center ${
              paymentVerified ? 'bg-green-600' : 'bg-gray-600'
            }`}>
              <CreditCard className="w-4 h-4 text-white" />
            </div>
            <div>
              <h3 className="text-white font-semibold">Payment Processed</h3>
              <p className="text-gray-400 text-sm">$99.99 charged successfully</p>
            </div>
            {paymentVerified && <CheckCircle className="w-5 h-5 text-green-400" />}
          </div>

          <div className="flex items-center space-x-3">
            <div className={`w-8 h-8 rounded-full flex items-center justify-center ${
              leagueCreated ? 'bg-green-600' : paymentVerified ? 'bg-blue-600' : 'bg-gray-600'
            }`}>
              <Users className="w-4 h-4 text-white" />
            </div>
            <div>
              <h3 className="text-white font-semibold">League Created</h3>
              <p className="text-gray-400 text-sm">ESPN data synced and ready</p>
            </div>
            {leagueCreated && <CheckCircle className="w-5 h-5 text-green-400" />}
          </div>

          <div className="flex items-center space-x-3">
            <div className={`w-8 h-8 rounded-full flex items-center justify-center ${
              syncProgress?.percentage === 100 ? 'bg-green-600' : leagueCreated ? 'bg-blue-600' : 'bg-gray-600'
            }`}>
              <Zap className="w-4 h-4 text-white" />
            </div>
            <div>
              <h3 className="text-white font-semibold">1,000 Credits Added</h3>
              <p className="text-gray-400 text-sm">Ready for AI content generation</p>
            </div>
            {syncProgress?.percentage === 100 && <CheckCircle className="w-5 h-5 text-green-400" />}
          </div>
        </div>

        {syncProgress?.percentage === 100 && (
          <div className="mt-6 text-center space-y-4">
            <div className="bg-green-900/50 border border-green-500 p-4 rounded-lg">
              <p className="text-green-200 text-sm">
                🎉 <strong>Success!</strong> Your league is ready. Team members who join will receive 100 bonus credits each.
              </p>
            </div>
            
            <div className="space-y-2">
              <Button 
                onClick={() => router.push("/dashboard")}
                className="w-full bg-red-600 hover:bg-red-700 text-lg py-3"
              >
                Go to Dashboard
              </Button>
              
              {/* Removed "View League Details" button as it's not relevant here */}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

export default function PaymentSuccessPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen bg-gray-900 flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-red-500 mx-auto mb-4"></div>
          <p className="text-white">Loading payment details...</p>
        </div>
      </div>
    }>
      <PaymentSuccessContent />
    </Suspense>
  );
}