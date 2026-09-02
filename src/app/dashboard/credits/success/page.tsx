"use client";

import { useEffect, useState, useCallback, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { useAction } from "convex/react";
import { api } from "../../../../../convex/_generated/api";
import { UserButton } from "@clerk/nextjs";
import { Button } from "@/components/ui/button";
import { TopBar, ThemeToggle, Panel, StatBlock, Chip, LoadingScreen } from "@/components/broadcast";
import { CreditCard, Zap, AlertCircle } from "lucide-react";

function CreditsPurchaseSuccessContent() {
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creditsGranted, setCreditsGranted] = useState<number | null>(null);

  const searchParams = useSearchParams();
  const router = useRouter();

  const verifyPayment = useAction(api.stripe.verifyPaymentCompleted);

  const processPaymentSuccess = useCallback(async (sessionId: string) => {
    try {
      const paymentResult = await verifyPayment({ sessionId });

      if (!paymentResult.fulfilled) {
        throw new Error("Payment verification failed");
      }

      const metadata = paymentResult.metadata;
      const creditsAmount = metadata?.creditsPurchased ? parseInt(metadata.creditsPurchased) : 0;

      setCreditsGranted(creditsAmount);

    } catch (error) {
      console.error("Payment verification error:", error);
      setError(error instanceof Error ? error.message : "Payment verification failed");
    } finally {
      setIsLoading(false);
    }
  }, [verifyPayment, setCreditsGranted, setError, setIsLoading]);

  useEffect(() => {
    const sessionId = searchParams?.get("session_id");

    if (!sessionId) {
      setError("No payment session found.");
      setIsLoading(false);
      return;
    }

    processPaymentSuccess(sessionId);
  }, [searchParams, processPaymentSuccess]);

  if (isLoading) {
    return (
      <div className="min-h-screen bg-bc-ground">
        <LoadingScreen message="Verifying your payment" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-bc-ground">
        <TopBar title="FFSN">
          <ThemeToggle />
          <UserButton />
        </TopBar>

        <main className="mx-auto max-w-2xl px-4 py-12 sm:px-6">
          <Panel padding="lg" className="flex flex-col items-center gap-4 text-center">
            <AlertCircle className="size-12 text-bc-red-text" strokeWidth={1.6} />
            <h1 className="bc-display text-bc-ink text-[32px] sm:text-[40px]">Verification error</h1>
            <p className="text-bc-text-2">{error}</p>

            <div className="mt-2 flex w-full flex-col gap-3 sm:w-auto sm:flex-row">
              <Button onClick={() => router.push("/dashboard/credits")}>Back to credits</Button>
              <Button onClick={() => router.push("/dashboard")} variant="outline">
                Go to dashboard
              </Button>
            </div>
          </Panel>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-bc-ground">
      <TopBar title="FFSN" subtitle="Credits purchased">
        <ThemeToggle />
        <UserButton />
      </TopBar>

      <main className="mx-auto max-w-2xl px-4 py-12 sm:px-6">
        <div className="mb-8 flex flex-col items-center gap-3.5 text-center">
          <Chip variant="win" live>
            Payment confirmed
          </Chip>
          <h1 className="bc-display text-bc-ink text-[40px] sm:text-[52px]">Purchase confirmed</h1>
          <p className="text-bc-text-2">Your credits have been added to your account.</p>
        </div>

        <Panel padding="lg" className="mb-6 flex flex-col items-center gap-6">
          <span className="bc-label flex items-center gap-2.5 text-bc-text-3">
            <Zap className="size-4" strokeWidth={1.8} />
            Purchase complete
          </span>

          {creditsGranted !== null && (
            <StatBlock
              align="center"
              size="lg"
              label="Credits added to your account"
              value={`+${creditsGranted}`}
            />
          )}

          <div className="grid w-full grid-cols-2 gap-4">
            <div className="flex flex-col items-center gap-2 border border-bc-hairline bg-bc-panel-2 p-4 text-center">
              <CreditCard className="size-6 text-bc-win" strokeWidth={1.8} />
              <p className="font-display font-semibold text-bc-ink">Payment</p>
              <p className="bc-label-sm text-bc-win">Completed</p>
            </div>
            <div className="flex flex-col items-center gap-2 border border-bc-hairline bg-bc-panel-2 p-4 text-center">
              <Zap className="size-6 text-bc-win" strokeWidth={1.8} />
              <p className="font-display font-semibold text-bc-ink">Credits</p>
              <p className="bc-label-sm text-bc-win">Added</p>
            </div>
          </div>
        </Panel>

        <Panel padding="md" className="mb-6">
          <p className="text-sm text-bc-body">
            <strong className="text-bc-ink">Ready to create.</strong> Use your credits to generate
            AI-powered fantasy content — head to your league to start a weekly recap, trade analysis,
            and more.
          </p>
        </Panel>

        <Button onClick={() => router.push("/dashboard")} className="w-full">
          Go to dashboard
        </Button>
      </main>
    </div>
  );
}

export default function CreditsPurchaseSuccessPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-bc-ground">
          <LoadingScreen message="Loading payment details" />
        </div>
      }
    >
      <CreditsPurchaseSuccessContent />
    </Suspense>
  );
}
