import type { ComponentProps } from "react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export interface ChipProps extends ComponentProps<typeof Badge> {
  /** Adds a pulsing dot (color follows the badge's own text color via `currentColor`). */
  live?: boolean;
}

/** Thin wrapper over `Badge` that adds an optional pulsing dot, for "On air" / "On deck" / "New" chips. */
export function Chip({ live, className, children, ...props }: ChipProps) {
  return (
    <Badge className={cn("gap-2", className)} {...props}>
      {live && (
        <span
          className="bc-pulse size-[7px] flex-none rounded-full bg-current"
          aria-hidden="true"
        />
      )}
      {children}
    </Badge>
  );
}
