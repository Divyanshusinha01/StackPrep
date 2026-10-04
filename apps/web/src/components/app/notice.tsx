import { cn } from "@/lib/utils";

export function Notice({ tone, children }: { tone: "error" | "info" | "success"; children: React.ReactNode }) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={cn(
        "mt-6 flex flex-wrap items-center gap-3 rounded-md border px-4 py-3 text-sm",
        tone === "error" && "border-red-500/30 bg-red-500/10 text-red-300",
        tone === "info" && "border-border bg-panel/60 text-muted-foreground",
        tone === "success" && "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
      )}
    >
      {children}
    </div>
  );
}
