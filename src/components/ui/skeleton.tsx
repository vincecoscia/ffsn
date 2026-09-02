import { cn } from "@/lib/utils"

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("bg-bc-panel-2 animate-pulse", className)}
      {...props}
    />
  )
}

export { Skeleton }