import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

/**
 * Broadcast button: condensed, uppercase, sharp-cornered.
 * `default` is the red on-air action (cut corner + glow), `outline` the
 * hairline secondary, `ghost` for toolbars, `plate` for off-white plates.
 */
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap font-display font-bold uppercase tracking-[0.08em] transition-colors disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 aria-invalid:border-destructive hover:cursor-pointer",
  {
    variants: {
      variant: {
        default:
          "bg-bc-red text-white bc-cut-sm hover:bg-[#A81214] focus-visible:ring-bc-red/50",
        glow:
          "bg-bc-red text-white bc-cut-sm bc-glow hover:bg-[#A81214] focus-visible:ring-bc-red/50",
        destructive:
          "bg-bc-red-deep text-white hover:bg-bc-red focus-visible:ring-bc-red/50",
        outline:
          "border border-bc-border-strong bg-transparent text-bc-ink hover:border-bc-red hover:text-bc-ink",
        secondary:
          "bg-bc-panel-2 text-bc-ink border border-bc-hairline hover:border-bc-border-strong",
        plate:
          "bg-bc-plate text-bc-plate-fg hover:bg-bc-red hover:text-white",
        signal:
          "border border-bc-signal text-bc-signal bg-transparent hover:bg-bc-signal/10",
        ghost:
          "text-bc-text-2 hover:text-bc-ink hover:bg-bc-panel-2",
        link:
          "text-bc-red-text underline-offset-4 hover:underline normal-case tracking-normal font-sans font-semibold",
      },
      size: {
        default: "h-10 px-4 text-[15px]",
        sm: "h-9 px-3 text-[14px] gap-1.5",
        lg: "h-12 px-6 text-[18px] gap-2.5",
        xs: "h-7 px-2.5 text-[12px] gap-1 tracking-[0.1em]",
        icon: "size-10 text-[15px]",
        "icon-sm": "size-9 text-[14px]",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot : "button"

  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
