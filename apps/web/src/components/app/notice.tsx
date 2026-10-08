import { CircleAlert, CircleCheck, Info, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";

export type NoticeTone = "error" | "warning" | "info" | "success";

const ICONS = { error: CircleAlert, warning: TriangleAlert, info: Info, success: CircleCheck } as const;

const TONES: Record<NoticeTone, { box: string; icon: string }> = {
  error: { box: "border-red-500/30 bg-red-500/10 text-red-200", icon: "text-red-300" },
  warning: { box: "border-amber-500/30 bg-amber-500/10 text-amber-100", icon: "text-amber-300" },
  info: { box: "border-border bg-panel-raised/70 text-muted-foreground", icon: "text-brand" },
  success: { box: "border-emerald-500/30 bg-emerald-500/10 text-emerald-200", icon: "text-emerald-300" },
};

export function Notice({
  tone,
  icon = true,
  className,
  children,
}: {
  tone: NoticeTone;
  /** Leading tone icon; turn off when the content brings its own (a spinner, say). */
  icon?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  const Icon = ICONS[tone];
  return (
    <div
      role={tone === "error" || tone === "warning" ? "alert" : "status"}
      className={cn(
        "mt-6 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border px-4 py-3 text-sm leading-relaxed",
        TONES[tone].box,
        "print:border-border print:bg-transparent print:text-foreground",
        className,
      )}
    >
      {icon ? <Icon aria-hidden className={cn("size-4 shrink-0", TONES[tone].icon)} /> : null}
      {children}
    </div>
  );
}
