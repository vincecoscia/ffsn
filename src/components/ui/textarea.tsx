import * as React from "react"

import { cn } from "@/lib/utils"

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "border-bc-border-strong bg-bc-panel-2 text-bc-ink placeholder:text-bc-text-3 focus-visible:border-bc-red focus-visible:ring-bc-red/30 aria-invalid:ring-destructive/20 aria-invalid:border-destructive flex field-sizing-content min-h-24 w-full border px-3 py-2.5 text-[15px] transition-[color,box-shadow,border-color] outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50 hover:border-bc-text-3",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
