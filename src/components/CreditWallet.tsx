"use client";

import Link from "next/link";
import { useQuery } from "convex/react";

import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { Panel, StatBlock, Chip, Spinner } from "@/components/broadcast";
import { CreditTopUpButton, TOPUP_CREDITS } from "@/components/CreditTopUpButton";
import { cn } from "@/lib/utils";

/**
 * The signed-in manager's credit balance, read from the single source of
 * truth (`api.credits.getUserCredits`) so every mount of `CreditWallet` - and
 * anything else that needs the balance, like `ContentGenerator`'s Generate
 * button - shares one query rather than each defining its own.
 */
export function useCreditBalance() {
  const userCredits = useQuery(api.credits.getUserCredits, {});
  return {
    balance: userCredits?.balance,
    isLoading: userCredits === undefined,
  };
}

export interface CreditWalletProps {
  leagueId: Id<"leagues">;
  /** Cost of the story currently selected, if any. Drives the warning state. */
  requiredCredits?: number;
  variant?: "strip" | "header";
  className?: string;
}

/**
 * Lets a manager see their credit balance and top up without leaving the page
 * they're generating a story from. `"strip"` is the compact panel row that
 * sits above the generator form; `"header"` is a single Chip-styled link for
 * the league header's context row.
 */
export function CreditWallet({
  leagueId,
  requiredCredits,
  variant = "strip",
  className,
}: CreditWalletProps) {
  if (variant === "header") {
    return <CreditWalletHeaderChip leagueId={leagueId} className={className} />;
  }
  return (
    <CreditWalletStrip leagueId={leagueId} requiredCredits={requiredCredits} className={className} />
  );
}

function CreditWalletStrip({
  leagueId,
  requiredCredits,
  className,
}: {
  leagueId: Id<"leagues">;
  requiredCredits?: number;
  className?: string;
}) {
  const { balance, isLoading } = useCreditBalance();

  const shortage =
    !isLoading && requiredCredits != null && balance != null
      ? Math.max(0, requiredCredits - balance)
      : 0;
  const isShort = shortage > 0;
  const topUpQuantity = isShort ? Math.max(1, Math.ceil(shortage / TOPUP_CREDITS)) : 1;

  return (
    <Panel
      padding="md"
      className={cn(
        "flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between",
        isShort && "border-l-4 border-l-bc-red-deep",
        className
      )}
    >
      <StatBlock
        label="Your credits"
        value={isLoading ? <Spinner size={16} /> : balance}
      />

      {requiredCredits != null && (
        <p className={cn("text-sm", isShort ? "text-bc-red-text" : "text-bc-text-2")}>
          {isShort
            ? `You need ${shortage} more credits to file this story`
            : `This story: ${requiredCredits} credits`}
        </p>
      )}

      <div className="flex flex-col items-start gap-2 sm:items-end">
        <CreditTopUpButton
          leagueId={leagueId}
          quantity={isShort ? topUpQuantity : 1}
          variant={isShort ? "glow" : "outline"}
          size="sm"
        />
        <Link
          href="/dashboard/credits"
          className="text-xs text-bc-text-3 underline underline-offset-2 hover:text-bc-text-2"
        >
          Wallet &amp; history
        </Link>
      </div>
    </Panel>
  );
}

function CreditWalletHeaderChip({
  leagueId,
  className,
}: {
  leagueId: Id<"leagues">;
  className?: string;
}) {
  const { balance, isLoading } = useCreditBalance();

  // Hide rather than flash a 0 while the query resolves.
  if (isLoading || balance == null) return null;

  return (
    <Chip asChild variant="outline" className={className} title="Buy credits and generate stories">
      <Link href={`/leagues/${leagueId}/ai-generation`}>
        <span className="bc-num">{balance}</span> credits
      </Link>
    </Chip>
  );
}
