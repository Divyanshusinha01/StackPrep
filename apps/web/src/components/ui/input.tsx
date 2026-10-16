import * as React from "react"
import { cn } from "@/lib/utils"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-10 w-full min-w-0 rounded-md border border-border-strong/70 bg-panel px-3 text-sm text-foreground outline-none transition-[color,box-shadow,border-color] placeholder:text-muted-foreground",
        "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
        "aria-invalid:border-danger/70 aria-invalid:ring-danger/20",
        "disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
        "[&::-webkit-search-cancel-button]:hidden",
        className
      )}
      {...props}
    />
  )
}

export { Input }
