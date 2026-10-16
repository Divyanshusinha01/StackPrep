import { Video } from "lucide-react";
import type { useDeviceCheck } from "@/components/app/use-device-check";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type DevicePhase = ReturnType<typeof useDeviceCheck>["phase"];

/** Mirrored camera preview, with the start / retry control over it until the check is running. */
export function PreviewTile({
  videoRef,
  phase,
  cameraOk,
  onStart,
  onVideoLoaded,
}: {
  videoRef: React.Ref<HTMLVideoElement>;
  phase: DevicePhase;
  cameraOk: boolean;
  onStart: () => void;
  onVideoLoaded: () => void;
}) {
  const checking = phase === "active";
  return (
    <div className="relative mt-4 aspect-video overflow-hidden rounded-lg border border-border-strong/70 bg-background shadow-inner">
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        onLoadedData={onVideoLoaded}
        className={cn("size-full -scale-x-100 object-cover", !checking && "invisible")}
        aria-label="Camera preview"
      />
      {!checking ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3.5 bg-radial from-panel/80 to-background p-4 text-center">
          <span
            aria-hidden
            className="grid size-12 place-items-center rounded-xl border border-brand/25 bg-brand-muted/70 text-brand"
          >
            <Video className="size-5" />
          </span>
          <Button onClick={onStart} disabled={phase === "requesting"} variant="outline">
            {phase === "requesting" ? "Waiting for permission…" : phase === "error" ? "Try again" : "Start check"}
          </Button>
        </div>
      ) : null}
      {checking && cameraOk ? (
        <span className="absolute top-3 left-3 inline-flex items-center gap-1.5 rounded-full border border-success/30 bg-background/80 px-2.5 py-0.5 font-mono text-[11px] text-success backdrop-blur-md">
          <span aria-hidden className="size-1.5 rounded-full bg-success" />
          Preview on
        </span>
      ) : null}
    </div>
  );
}
