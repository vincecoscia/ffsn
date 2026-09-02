import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export interface StatBlockProps {
  label: ReactNode;
  value: ReactNode;
  align?: "left" | "center" | "right";
  /** `"lg"` for hero-sized stats (36–40px); default is 28–30px. */
  size?: "default" | "lg";
  className?: string;
}

/** A muted condensed key over a large `bc-num` value, e.g. "Record" / "2-1". */
export function StatBlock({ label, value, align = "left", size = "default", className }: StatBlockProps) {
  return (
    <div
      className={cn(
        "flex flex-col gap-1.5",
        align === "center" && "items-center text-center",
        align === "right" && "items-end text-right",
        className
      )}
    >
      <span className="bc-label-sm text-bc-text-3">{label}</span>
      <span
        className={cn(
          "bc-num font-extrabold text-bc-ink",
          size === "lg" ? "text-[32px] sm:text-[36px]" : "text-[24px] sm:text-[26px]"
        )}
      >
        {value}
      </span>
    </div>
  );
}
