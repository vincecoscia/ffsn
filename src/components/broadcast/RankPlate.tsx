import type { HTMLAttributes, ReactNode } from "react";

import { cn } from "@/lib/utils";

export interface RankPlateProps extends Omit<HTMLAttributes<HTMLSpanElement>, "children"> {
  rank: ReactNode;
  /** `"first"` fills solid red (e.g. rank #1); `"outline"` keeps the panel fill with a red border (e.g. the viewer's own row). */
  tone?: "default" | "first" | "outline";
}

/** The 32px square rank tile used in standings and trending lists. */
export function RankPlate({ rank, tone = "default", className, ...props }: RankPlateProps) {
  return (
    <span
      className={cn(
        "inline-flex size-8 flex-none items-center justify-center border font-display text-[15px] font-extrabold",
        tone === "first" && "border-bc-red bg-bc-red text-white",
        tone === "outline" && "border-bc-red bg-bc-panel-2 text-bc-ink",
        tone === "default" && "border-bc-border-strong bg-bc-panel-2 text-bc-ink",
        className
      )}
      {...props}
    >
      {rank}
    </span>
  );
}
