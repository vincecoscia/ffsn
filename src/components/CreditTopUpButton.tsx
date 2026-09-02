"use client";

import { useEffect, useRef, useState } from "react";
import { useAction } from "convex/react";
import { Check, Plus } from "lucide-react";

import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** One top-up unit: 100 credits for $5 (spec §10.1). */
export const TOPUP_CREDITS = 100;
export const TOPUP_PRICE = 5;

/**
 * Where Checkout should drop the manager back. Stripe returns to an absolute
 * URL built server-side from `SITE_URL`, so only the relative path travels, and
 * our own result params are stripped so a second top-up doesn't inherit the
 * first one's banner.
 */
function currentReturnPath(fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const url = new URL(window.location.href);
  url.searchParams.delete("topup");
  url.searchParams.delete("session_id");
  const search = url.searchParams.toString();
  return `${url.pathname}${search ? `?${search}` : ""}`;
}

export interface CreditTopUpButtonProps {
  /** Number of 100-credit units to buy. Defaults to one. */
  quantity?: number;
  /** Recorded on the payment so league-scoped spend reporting can attribute it. */
  leagueId?: Id<"leagues">;
  variant?: "glow" | "default" | "outline" | "secondary" | "ghost" | "plate";
  size?: "sm" | "default" | "lg";
  className?: string;
  children?: React.ReactNode;
}

/**
 * Buys the signed-in manager their own credits. Credits always land on the
 * authenticated identity - the action takes no user id - so this is safe to
 * mount anywhere a balance is shown.
 */
export function CreditTopUpButton({
  quantity = 1,
  leagueId,
  variant = "glow",
  size = "sm",
  className,
  children,
}: CreditTopUpButtonProps) {
  const [isRedirecting, setIsRedirecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justPurchased, setJustPurchased] = useState(false);
  const verified = useRef(false);
  const topUp = useAction(api.stripe.createCreditTopUpSession);
  const verifyPayment = useAction(api.stripe.verifyPaymentCompleted);

  // Coming back from Checkout, settle the purchase immediately rather than
  // waiting on the webhook, then clean our params out of the URL. Verification
  // is idempotent and ownership-checked server-side; the webhook remains the
  // source of truth if the manager closes the tab first.
  useEffect(() => {
    if (verified.current) return;
    const url = new URL(window.location.href);
    if (url.searchParams.get("topup") !== "success") return;
    const sessionId = url.searchParams.get("session_id");
    verified.current = true;

    const clearParams = () => {
      url.searchParams.delete("topup");
      url.searchParams.delete("session_id");
      const search = url.searchParams.toString();
      window.history.replaceState(null, "", `${url.pathname}${search ? `?${search}` : ""}`);
    };

    if (!sessionId) {
      clearParams();
      return;
    }

    verifyPayment({ sessionId })
      .then(() => setJustPurchased(true))
      .catch((err) => console.error("Top-up verification failed:", err))
      .finally(clearParams);
  }, [verifyPayment]);

  const credits = TOPUP_CREDITS * quantity;
  const price = TOPUP_PRICE * quantity;

  const handleClick = async () => {
    setIsRedirecting(true);
    setError(null);
    try {
      const result = await topUp({
        quantity,
        leagueId,
        returnPath: currentReturnPath("/dashboard/credits"),
      });
      if (result.success && result.url) {
        window.location.href = result.url;
        return;
      }
      setError(result.error ?? "Could not start checkout. Try again.");
    } catch (err) {
      console.error("Credit top-up checkout error:", err);
      setError("Could not start checkout. Try again.");
    } finally {
      setIsRedirecting(false);
    }
  };

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <Button variant={variant} size={size} onClick={handleClick} disabled={isRedirecting}>
        <Plus className="size-4" strokeWidth={2.4} />
        {children ??
          (isRedirecting ? "Opening checkout..." : `Top up ${credits} credits · $${price}`)}
      </Button>
      {justPurchased && (
        <p className="flex items-center gap-2 text-[13px] text-bc-win">
          <Check className="size-3.5" strokeWidth={3} aria-hidden="true" />
          Credits added.
        </p>
      )}
      {error && <p className="text-[13px] text-bc-red-text">{error}</p>}
    </div>
  );
}
