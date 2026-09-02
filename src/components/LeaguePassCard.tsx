"use client";

import { useEffect, useRef, useState } from "react";
import { useAction, useQuery } from "convex/react";
import { Check, Minus, Plus, Ticket, UserPlus } from "lucide-react";

import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Panel, SectionHeader, StatBlock, Chip, Spinner } from "@/components/broadcast";

/** Managers the League Pass covers before a seat has to be bought (spec §10.1). */
const INCLUDED_MANAGERS = 12;
const MAX_SEATS_PER_PURCHASE = 8;
const SEAT_PRICE = 10;

const SEAT_INCLUDES = [
  "One manager past the included 12",
  "That manager's 100 credits for the season",
  "Every automated story still covered by the pass",
];

export interface LeaguePassCardProps {
  leagueId: Id<"leagues">;
  /** Only the commissioner can buy seats. */
  canManage: boolean;
  className?: string;
}

/**
 * The commissioner's view of the League Pass (spec §10.1): whether the pass is
 * active, which season it covers, how many of the 12 included manager slots
 * are used, and a way to buy $10 seats for anyone past that.
 */
export function LeaguePassCard({ leagueId, canManage, className }: LeaguePassCardProps) {
  const [quantity, setQuantity] = useState(1);
  const [isRedirecting, setIsRedirecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [justPurchased, setJustPurchased] = useState(false);
  const verified = useRef(false);

  const league = useQuery(api.leagues.getById, { id: leagueId });
  const capacity = useQuery(api.leagues.getLeagueCapacity, { leagueId });
  const buySeats = useAction(api.stripe.createExtraSeatCheckoutSession);
  const verifyPayment = useAction(api.stripe.verifyPaymentCompleted);

  // Coming back from Checkout, settle the seat purchase without waiting on the
  // webhook, then clean our params out of the URL. Verification is idempotent
  // and ownership-checked server-side.
  useEffect(() => {
    if (verified.current) return;
    const url = new URL(window.location.href);
    if (url.searchParams.get("seat") !== "success") return;
    const sessionId = url.searchParams.get("session_id");
    verified.current = true;

    const clearParams = () => {
      url.searchParams.delete("seat");
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
      .catch((err) => console.error("Seat verification failed:", err))
      .finally(clearParams);
  }, [verifyPayment]);

  const isLoading = league === undefined || capacity === undefined;
  const subscription = league?.subscription;
  // The two values `credits.hasActivePass` treats as active ("paid" is the
  // legacy alias written by pre-Broadcast-Desk purchases).
  const isActive = subscription?.status === "active" || subscription?.status === "paid";
  const season = subscription?.seasonId ?? subscription?.seasonYear ?? league?.espnData?.seasonId;

  const included = capacity?.included ?? INCLUDED_MANAGERS;
  const managers = capacity?.managers ?? 0;
  const extraSeats = capacity?.extraSeats ?? 0;
  const remaining = capacity?.remaining ?? Math.max(included + extraSeats - managers, 0);

  const handleBuySeats = async () => {
    setIsRedirecting(true);
    setError(null);
    try {
      const result = await buySeats({
        leagueId,
        quantity,
        returnPath: `/leagues/${leagueId}/settings`,
      });
      if (result.success && result.url) {
        window.location.href = result.url;
        return;
      }
      setError(result.error ?? "Could not start checkout. Try again.");
    } catch (err) {
      console.error("Extra seat checkout error:", err);
      setError("Could not start checkout. Try again.");
    } finally {
      setIsRedirecting(false);
    }
  };

  return (
    <Panel padding="md" className={className}>
      <SectionHeader
        kicker="Billing"
        title="League Pass & seats"
        actions={
          isLoading ? (
            <Spinner />
          ) : (
            <Chip variant={isActive ? "win" : "outline"} live={isActive}>
              {isActive ? "Active" : "Not active"}
            </Chip>
          )
        }
      />

      <div className="mt-6 grid grid-cols-2 gap-5 sm:grid-cols-4">
        <StatBlock label="Season" value={season ?? "—"} />
        <StatBlock label="Managers" value={`${managers}/${included + extraSeats}`} />
        <StatBlock label="Extra seats" value={extraSeats} />
        <StatBlock label="Slots left" value={remaining} />
      </div>

      <p className="mt-5 text-[14px] leading-relaxed text-bc-text-2">
        The pass covers every automated story all season and gives {included} managers 100 credits
        each. Managers past that are ${SEAT_PRICE} a seat.
      </p>

      {canManage && (
        <div className="mt-6 flex flex-col gap-5 border-t border-bc-hairline pt-6">
          <div className="flex flex-col gap-2.5">
            <span className="bc-label-sm text-bc-text-3">A seat includes</span>
            <ul className="flex flex-col gap-2">
              {SEAT_INCLUDES.map((item) => (
                <li key={item} className="flex items-start gap-2.5 text-[14px] text-bc-text-2">
                  <UserPlus
                    className="mt-0.5 size-4 flex-none text-bc-red-text"
                    strokeWidth={1.8}
                    aria-hidden="true"
                  />
                  {item}
                </li>
              ))}
            </ul>
          </div>

          <div className="flex flex-wrap items-end gap-4">
            <div className="flex flex-col gap-2">
              <span className="bc-label-sm text-bc-text-3" id="seat-quantity-label">
                Seats
              </span>
              <div
                className="flex items-center gap-1 border border-bc-hairline bg-bc-ground"
                role="group"
                aria-labelledby="seat-quantity-label"
              >
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="One fewer seat"
                  disabled={quantity <= 1 || isRedirecting}
                  onClick={() => setQuantity((q) => Math.max(1, q - 1))}
                >
                  <Minus className="size-4" />
                </Button>
                <span className="bc-num min-w-8 text-center text-[18px] font-bold text-bc-ink">
                  {quantity}
                </span>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="One more seat"
                  disabled={quantity >= MAX_SEATS_PER_PURCHASE || isRedirecting}
                  onClick={() => setQuantity((q) => Math.min(MAX_SEATS_PER_PURCHASE, q + 1))}
                >
                  <Plus className="size-4" />
                </Button>
              </div>
            </div>

            <Button variant="glow" size="lg" onClick={handleBuySeats} disabled={isRedirecting}>
              <Ticket className="size-5" strokeWidth={1.8} />
              {isRedirecting
                ? "Opening checkout..."
                : `Buy ${quantity === 1 ? "a seat" : `${quantity} seats`} · $${quantity * SEAT_PRICE}`}
            </Button>
          </div>

          {justPurchased && (
            <p className="flex items-center gap-2 text-[14px] text-bc-win">
              <Check className="size-4" strokeWidth={3} aria-hidden="true" />
              Seats added. New managers can join now.
            </p>
          )}
          {error && <p className="text-[14px] text-bc-red-text">{error}</p>}
        </div>
      )}
    </Panel>
  );
}
