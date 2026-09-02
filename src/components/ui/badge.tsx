import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

/**
 * Broadcast badge: a condensed small-caps chip, 26px tall, no rounding.
 * `default` is the red slate, `outline` the hairline chip, `signal` the
 * blue "on deck" chip, `plate` the off-white/ink plate, `live` pulses a dot.
 */
const badgeVariants = cva(
  "inline-flex items-center justify-center gap-2 h-6 px-2 font-display font-bold text-[11px] uppercase tracking-[0.14em] leading-none w-fit whitespace-nowrap shrink-0 [&>svg]:size-3 [&>svg]:pointer-events-none border transition-colors overflow-hidden",
  {
    variants: {
      variant: {
        default: "border-bc-red bg-bc-red text-white",
        secondary: "border-bc-hairline bg-bc-panel-2 text-bc-text-2",
        outline: "border-bc-border-strong bg-transparent text-bc-text-2",
        signal: "border-bc-signal bg-transparent text-bc-signal",
        plate: "border-bc-plate bg-bc-plate text-bc-plate-fg",
        red: "border-bc-red bg-transparent text-bc-red-text",
        win: "border-bc-win bg-transparent text-bc-win",
        destructive: "border-bc-red-deep bg-bc-red-deep text-white",
        muted: "border-transparent bg-transparent text-bc-text-3 px-0",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Badge({
  className,
  variant,
  asChild = false,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : "span"

  return (
    <Comp
      data-slot="badge"
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  )
}

export { Badge, badgeVariants }
