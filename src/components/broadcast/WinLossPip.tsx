import { cn } from "@/lib/utils";

export interface WinLossPipProps {
  result: "W" | "L";
  className?: string;
}

/** 22px W/L square: red fill for a win, filled border-strong for a loss. */
export function WinLossPip({ result, className }: WinLossPipProps) {
  const isWin = result === "W";
  return (
    <span
      aria-label={isWin ? "Win" : "Loss"}
      className={cn(
        "inline-flex size-[22px] flex-none items-center justify-center font-display text-[13px] font-extrabold",
        isWin ? "bg-bc-red text-white" : "bg-bc-border-strong text-bc-text-2",
        className
      )}
    >
      {result}
    </span>
  );
}
