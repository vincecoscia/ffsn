"use client";

import { useState } from "react";
import { useQuery, useAction } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import { useUser } from "@clerk/nextjs";
import { Button } from "@/components/ui/button";
import { PageHeader, Panel, SectionHeader, StatBlock, Chip, Spinner } from "@/components/broadcast";
import { CreditTopUpButton } from "@/components/CreditTopUpButton";
import { creditCostFor } from "@/lib/ai/content-templates";
import { cn } from "@/lib/utils";

import { CreditCard, History, Plus, AlertCircle, ArrowLeft } from "lucide-react";
import Link from "next/link";

// Top-ups are always 100 credits for $5 (spec §10.1); a pack is just a
// quantity of that same unit, so the price per credit never moves.
const CREDIT_PACKAGES = [
  {
    id: "single",
    name: "One top-up",
    quantity: 1,
    credits: 100,
    price: 5,
    popular: false,
    description: "The standard top-up",
    features: ["100 credits", "$5 per 100, always", "Runs through the end of the season"],
  },
  {
    id: "triple",
    name: "Three top-ups",
    quantity: 3,
    credits: 300,
    price: 15,
    popular: true,
    description: "A season of manual stories",
    features: ["300 credits", "$5 per 100, always", "Runs through the end of the season"],
  },
  {
    id: "five",
    name: "Five top-ups",
    quantity: 5,
    credits: 500,
    price: 25,
    popular: false,
    description: "For managers who file constantly",
    features: ["500 credits", "$5 per 100, always", "Runs through the end of the season"],
  },
];

const LIFETIME_STATS = [
  { label: "Earned", key: "totalEarned" as const },
  { label: "Spent", key: "totalSpent" as const },
  { label: "Purchased", key: "totalPurchased" as const },
];

// Straight from `creditCostFor`, the same source of truth ContentGenerator
// uses — no hardcoded prices to drift out of sync (spec §10.2).
const CONTENT_COSTS = [
  { label: "Weekly recap", cost: creditCostFor("weekly_recap") },
  { label: "Trade analysis", cost: creditCostFor("trade_analysis") },
  { label: "Power rankings", cost: creditCostFor("power_rankings") },
  { label: "Custom roast", cost: creditCostFor("custom_roast") },
];

export default function CreditsPage() {
  const [selectedPackage, setSelectedPackage] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { user } = useUser();
  // Credit balance/history are derived from the authenticated identity on the
  // server — no user id is passed from the client.
  const userCredits = useQuery(api.credits.getUserCredits, {});
  const creditHistory = useQuery(api.credits.getCreditHistory, { limit: 10 });
  const createTopUpCheckout = useAction(api.stripe.createCreditTopUpSession);

  const handlePurchase = async (packageId: string) => {
    if (!user?.id) {
      setError("Please sign in to purchase credits");
      return;
    }

    const creditPackage = CREDIT_PACKAGES.find(p => p.id === packageId);
    if (!creditPackage) return;

    setIsProcessing(true);
    setError(null);
    setSelectedPackage(packageId);

    try {
      // Credits land on the authenticated identity; the action takes no user id.
      const result = await createTopUpCheckout({
        quantity: creditPackage.quantity,
        returnPath: "/dashboard/credits",
      });

      if (result.success && result.url) {
        window.location.href = result.url;
      } else {
        setError(result.error || "Failed to create checkout session");
      }
    } catch (err) {
      console.error("Credits purchase error:", err);
      setError("Failed to process purchase. Please try again.");
    } finally {
      setIsProcessing(false);
      setSelectedPackage(null);
    }
  };

  const formatDate = (timestamp: number) => {
    return new Date(timestamp).toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  return (
    <div className="min-h-screen bg-bc-ground">
      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-12">
        <Button asChild variant="outline" size="sm" className="mb-6">
          <Link href="/dashboard">
            <ArrowLeft className="size-4" strokeWidth={2} />
            Back to dashboard
          </Link>
        </Button>

        <PageHeader
          kicker="Wallet"
          title="Credits"
          description="Credits cover the stories you generate yourself. Automated stories are covered by the League Pass. Top up 100 credits for $5."
        />

        <div className="mt-10 grid grid-cols-1 gap-6 lg:grid-cols-3">
          <Panel padding="md" className="flex flex-col justify-center gap-4">
            <StatBlock label="Current balance" value={userCredits?.balance ?? 0} size="lg" />
            {/* 100 credits for $5, straight from where the balance is read. */}
            <CreditTopUpButton />
          </Panel>

          <Panel padding="md" className="flex flex-col gap-4">
            <SectionHeader size="sm" title="Lifetime stats" />
            <dl className="flex flex-col gap-2.5">
              {LIFETIME_STATS.map(({ label, key }) => (
                <div key={key} className="flex items-center justify-between gap-4">
                  <dt className="flex items-center gap-2.5 text-sm text-bc-text-2">
                    <span className="bc-sep bc-sep-muted" aria-hidden="true" />
                    {label}
                  </dt>
                  <dd className="bc-num text-bc-ink">{userCredits?.[key] ?? 0}</dd>
                </div>
              ))}
            </dl>
          </Panel>

          <Panel padding="md" className="flex flex-col gap-4">
            <SectionHeader size="sm" title="Content costs" />
            <dl className="flex flex-col gap-2.5">
              {CONTENT_COSTS.map(({ label, cost }) => (
                <div key={label} className="flex items-center justify-between gap-4">
                  <dt className="flex items-center gap-2.5 text-sm text-bc-text-2">
                    <span className="bc-sep bc-sep-muted" aria-hidden="true" />
                    {label}
                  </dt>
                  <dd className="bc-num text-bc-ink">{cost}</dd>
                </div>
              ))}
            </dl>
          </Panel>
        </div>

        {error && (
          <Panel padding="md" className="mt-8 flex items-start gap-3 border-bc-red">
            <AlertCircle className="mt-0.5 size-5 flex-none text-bc-red-text" strokeWidth={1.8} />
            <div>
              <p className="font-display font-bold text-bc-ink uppercase">Purchase error</p>
              <p className="mt-1 text-sm text-bc-text-2">{error}</p>
            </div>
          </Panel>
        )}

        <div className="mt-10">
          <SectionHeader title="Purchase credits" />
          <div className="mt-6 grid grid-cols-1 gap-6 md:grid-cols-3">
            {CREDIT_PACKAGES.map((pkg) => (
              <Panel
                key={pkg.id}
                padding="md"
                className={cn(
                  "relative flex flex-col gap-5",
                  pkg.popular && "border-bc-red"
                )}
              >
                {pkg.popular && (
                  <Chip
                    variant="red"
                    className="absolute -top-3.5 left-1/2 -translate-x-1/2"
                  >
                    Most popular
                  </Chip>
                )}

                <div className="flex flex-col gap-1">
                  <h3 className="font-display text-xl font-extrabold text-bc-ink uppercase">
                    {pkg.name}
                  </h3>
                  <p className="text-sm text-bc-text-2">{pkg.description}</p>
                </div>

                <div className="flex items-baseline gap-2">
                  <span className="bc-num text-[36px] font-extrabold text-bc-ink">
                    ${pkg.price}
                  </span>
                  <span className="bc-label-sm text-bc-text-3">one-time</span>
                </div>

                <div className="border-t border-bc-hairline pt-4">
                  <StatBlock label="Credits" value={pkg.credits} size="lg" />
                </div>

                <ul className="flex flex-col gap-2">
                  {pkg.features.map((feature) => (
                    <li key={feature} className="flex items-center gap-2.5 text-sm text-bc-body">
                      <span className="bc-sep" aria-hidden="true" />
                      {feature}
                    </li>
                  ))}
                </ul>

                <Button
                  type="button"
                  onClick={() => handlePurchase(pkg.id)}
                  disabled={isProcessing}
                  className="mt-auto w-full"
                >
                  {isProcessing && selectedPackage === pkg.id ? (
                    <>
                      <Spinner size={14} />
                      Processing…
                    </>
                  ) : (
                    <>
                      <Plus className="size-4" strokeWidth={2} />
                      Purchase credits
                    </>
                  )}
                </Button>
              </Panel>
            ))}
          </div>
        </div>

        <Panel padding="md" className="mt-10 flex flex-col gap-4">
          <SectionHeader
            title="Recent transactions"
            actions={<History className="size-5 text-bc-text-3" strokeWidth={1.8} />}
          />
          {creditHistory && creditHistory.length > 0 ? (
            <div className="flex flex-col">
              {creditHistory.map((transaction) => (
                <div
                  key={transaction.id}
                  className="flex items-center justify-between gap-4 border-t border-bc-hairline py-3.5 first:border-t-0"
                >
                  <div className="flex flex-col gap-0.5">
                    <p className="font-display font-semibold text-bc-ink">
                      {transaction.description}
                    </p>
                    <p className="text-sm text-bc-text-3">{formatDate(transaction.createdAt)}</p>
                  </div>
                  <div className="flex flex-col items-end gap-0.5">
                    <div
                      className={cn(
                        "bc-num",
                        transaction.amount > 0 ? "text-bc-win" : "text-bc-red-text"
                      )}
                    >
                      {transaction.amount > 0 ? "+" : ""}
                      {transaction.amount} credits
                    </div>
                    <div className="text-sm text-bc-text-3">
                      Balance: {transaction.balanceAfter}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="flex flex-col items-center gap-3 py-8 text-center">
              <CreditCard className="size-6 text-bc-text-3" strokeWidth={1.8} />
              <p className="text-bc-text-2">No credit transactions yet</p>
            </div>
          )}
        </Panel>
      </main>
    </div>
  );
}
