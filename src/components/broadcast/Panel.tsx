import type { HTMLAttributes } from "react";

import { cn } from "@/lib/utils";

export interface PanelProps extends HTMLAttributes<HTMLDivElement> {
  /** Which corner gets the 14px angle cut. Default `"tr"` (top-right). */
  cut?: "tr" | "bl" | "none";
  padding?: "none" | "sm" | "md" | "lg";
  /** Use the lifted panel ground (`bg-bc-panel-2`) instead of the base panel. */
  lifted?: boolean;
  /** Add the subtle scanline texture. */
  scan?: boolean;
}

const CUT: Record<NonNullable<PanelProps["cut"]>, string> = {
  tr: "bc-cut",
  bl: "bc-cut-bl",
  none: "",
};

const PADDING: Record<NonNullable<PanelProps["padding"]>, string> = {
  none: "",
  sm: "p-4",
  md: "p-5",
  lg: "p-6 sm:p-8",
};

/** The base cut-corner panel surface every Broadcast card/section sits on. */
export function Panel({
  cut = "tr",
  padding = "none",
  lifted,
  scan,
  className,
  children,
  ...props
}: PanelProps) {
  return (
    <div
      className={cn(
        "border border-bc-hairline",
        lifted ? "bg-bc-panel-2" : "bg-bc-panel",
        CUT[cut],
        PADDING[padding],
        scan && "bc-scan",
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
}
