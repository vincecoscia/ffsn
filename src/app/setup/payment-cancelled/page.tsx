"use client";

import { useRouter } from "next/navigation";
import { UserButton } from "@clerk/nextjs";
import { ArrowLeft, CreditCard, XCircle } from "lucide-react";

import { TopBar, ThemeToggle, Panel } from "@/components/broadcast";
import { Button } from "@/components/ui/button";

export default function PaymentCancelledPage() {
  const router = useRouter();

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
              You cancelled the payment process. Your league setup has not been completed and no
              charges were made.
            </p>
            <div className="border border-bc-signal/40 bg-bc-signal/10 p-4">
              <h3 className="bc-label text-bc-signal">What you&apos;re missing</h3>
              <ul className="mt-2.5 flex flex-col gap-1.5 text-[14px] leading-relaxed text-bc-text-2">
                <li>Full season fantasy league access</li>
                <li>1,000 AI content generation credits</li>
                <li>Weekly recaps, previews, and analysis</li>
                <li>Custom team roasts and power rankings</li>
                <li>100 bonus credits for each league member</li>
              </ul>
            </div>
          </div>

          <div className="flex flex-col gap-3 border-t border-bc-hairline pt-6">
            <Button
              onClick={() => router.push("/setup")}
              variant="glow"
              size="lg"
              className="w-full"
            >
              <CreditCard className="size-5" strokeWidth={1.8} />
              Continue with payment ($99.99)
            </Button>
            <Button
              onClick={() => router.back()}
              variant="outline"
              size="lg"
              className="w-full"
            >
              <ArrowLeft className="size-4" strokeWidth={1.8} />
              Back to league setup
            </Button>
            <Button
              onClick={() => router.push("/dashboard")}
              variant="ghost"
              size="lg"
              className="w-full"
            >
              Skip for now and go to dashboard
            </Button>
          </div>

          <p className="border-t border-bc-hairline pt-5 text-center text-[13px] text-bc-text-3">
            Need help? Contact us at support@ffsn.ai
          </p>
        </Panel>
      </main>
    </div>
  );
}
