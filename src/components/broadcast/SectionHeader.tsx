import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export interface SectionHeaderProps {
  title: ReactNode;
  /** Small-caps label shown above the title. */
  kicker?: ReactNode;
  /** Right-side slot: buttons, meta text, filters. */
  actions?: ReactNode;
  /** `"sm"` matches the 22px h-title used in sidebar cards. */
  size?: "default" | "sm";
  className?: string;
}

/** A `bc-h-title` (red bar + condensed title) with an optional kicker and a right-side actions slot, sitting on a 2px hairline. */
export function SectionHeader({
  title,
  kicker,
  actions,
  size = "default",
  className,
}: SectionHeaderProps) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-between gap-x-4 gap-y-2.5 border-b-2 border-bc-hairline pb-3",
        className
      )}
    >
      {/* The title never shrinks: actions wrap onto their own line first, and
          the title only truncates when it alone is wider than the container. */}
      <div className="flex min-w-0 max-w-full shrink-0 flex-col gap-1.5">
        {kicker && <span className="bc-label-sm text-bc-text-3">{kicker}</span>}
        <span className={cn("bc-h-title max-w-full", size === "sm" && "text-[20px]")}>
          <span className="min-w-0 truncate">{title}</span>
        </span>
      </div>
      {actions && (
        <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-3">{actions}</div>
      )}
    </div>
  );
}
