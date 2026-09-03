import type { ComponentProps } from "react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export interface ChipProps extends ComponentProps<typeof Badge> {
  /** Adds a pulsing dot (color follows the badge's own text color via `currentColor`). */
  live?: boolean;
}

/** Thin wrapper over `Badge` that adds an optional pulsing dot, for "On air" / "On deck" / "New" chips. */
export function Chip({ live, className, children, ...props }: ChipProps) {
  // `asChild` hands our children to a Radix Slot, which accepts exactly one
  // element. Rendering the live dot alongside the child made that an array and
  // crashed the page (React.Children.only). With asChild the child is rendered
  // as-is and the dot is skipped; wrap a Chip in the link instead if you need both.
  if (props.asChild) {
    return (
      <Badge className={cn("gap-2", className)} {...props}>
        {children}
      </Badge>
    );
  }
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
