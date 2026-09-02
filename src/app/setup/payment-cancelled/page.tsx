"use client";

import { Suspense } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { UserButton } from "@clerk/nextjs";
import { ArrowLeft, CreditCard, XCircle } from "lucide-react";

import { TopBar, ThemeToggle, Panel, LoadingScreen } from "@/components/broadcast";
import { Button } from "@/components/ui/button";

function PaymentCancelledContent() {
  const searchParams = useSearchParams();
  // Only a Convex document id is ever put here (by the checkout cancel URL);
  // anything else is dropped rather than turned into a link.
  const rawLeague = searchParams?.get("league");
  const league = rawLeague && /^[a-z0-9]+$/i.test(rawLeague) ? rawLeague : null;

  return (
    <div className="min-h-screen bg-bc-ground">
      <TopBar title="New league" subtitle="Payment cancelled">
        <ThemeToggle />
        <UserButton />
      </TopBar>

      <main className="mx-auto flex max-w-2xl flex-col gap-8 px-4 py-12 sm:px-6 sm:py-16">
        <div className="flex flex-col items-center gap-4 text-center">
          <span className="flex size-16 flex-none items-center justify-center border border-bc-border-strong text-bc-text-2">
            <XCircle className="size-8" strokeWidth={1.6} />
          </span>
          <div className="flex flex-col gap-2">
            <h1 className="bc-display text-bc-ink text-[32px] sm:text-[38px]">
              Payment cancelled
            </h1>
            <p className="text-[15px] text-bc-text-2">No charges were made to your account.</p>
          </div>
        </div>

        <Panel padding="lg" className="flex flex-col gap-6">
          <div className="flex flex-col gap-4">
            <p className="text-center text-[15px] leading-relaxed text-bc-text-2">
              {league
                ? "Your league was created and is waiting on its League Pass. Buy the pass from league settings whenever you're ready — there's no need to set the league up again."
                : "You cancelled the payment process. No charges were made to your account."}
            </p>
            <div className="border border-bc-signal/40 bg-bc-signal/10 p-4">
              <h3 className="bc-label text-bc-signal">What you&apos;re missing</h3>
              <ul className="mt-2.5 flex flex-col gap-1.5 text-[14px] leading-relaxed text-bc-text-2">
                <li>Every automated story for the season</li>
                <li>Weekly recaps, previews, and analysis</li>
                <li>Custom team roasts and power rankings</li>
                <li>100 bonus credits for each included manager</li>
              </ul>
            </div>
          </div>

          <div className="flex flex-col gap-3 border-t border-bc-hairline pt-6">
            {league ? (
              <>
                <Button asChild variant="glow" size="lg" className="w-full">
                  <Link href={`/leagues/${league}/settings`}>
                    <CreditCard className="size-5" strokeWidth={1.8} />
                    Buy the League Pass from league settings
                  </Link>
                </Button>
                <Button asChild variant="outline" size="lg" className="w-full">
                  <Link href="/dashboard">
                    <ArrowLeft className="size-4" strokeWidth={1.8} />
                    Back to dashboard
                  </Link>
                </Button>
              </>
            ) : (
              <Button asChild variant="glow" size="lg" className="w-full">
                <Link href="/dashboard">
                  <ArrowLeft className="size-4" strokeWidth={1.8} />
                  Back to dashboard
                </Link>
              </Button>
            )}
          </div>

          <p className="border-t border-bc-hairline pt-5 text-center text-[13px] text-bc-text-3">
            Need help? Contact us at support@ffsn.ai
          </p>
        </Panel>
      </main>
    </div>
  );
}

export default function PaymentCancelledPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-bc-ground">
          <LoadingScreen message="Loading" />
        </div>
      }
    >
      <PaymentCancelledContent />
    </Suspense>
  );
}
