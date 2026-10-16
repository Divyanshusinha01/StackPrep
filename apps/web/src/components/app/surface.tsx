import { cn } from "@/lib/utils";

const BASE = "surface-inset rounded-xl border bg-panel/60";

/** The raised panel used for cards and sections across the app. */
export function Surface({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn(BASE, className)} {...props} />;
}

/** A Surface that is a divided list; rows are plain `li` elements. */
export function SurfaceList({ className, ...props }: React.ComponentProps<"ul">) {
  return <ul className={cn(BASE, "divide-y overflow-hidden", className)} {...props} />;
}
