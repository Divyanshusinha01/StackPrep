import * as React from "react"
import { cn } from "@/lib/utils"

const TONES = {
  brand: "text-brand",
  muted: "text-muted-foreground",
} as const

/** Small uppercase mono label above a heading or panel title. */
function Eyebrow({
  tone = "brand",
  className,
  ...props
}: React.ComponentProps<"p"> & { tone?: keyof typeof TONES }) {
  return (
    <p
      data-slot="eyebrow"
      className={cn("font-mono text-xs tracking-[0.18em] uppercase", TONES[tone], className)}
      {...props}
    />
  )
}

export { Eyebrow }
