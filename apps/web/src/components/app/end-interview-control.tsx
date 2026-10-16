"use client";

import { useState } from "react";
import { Loader2, Square } from "lucide-react";
import { ConfirmDialog } from "@/components/app/confirm-dialog";
import { END_CONFIRM_MESSAGE } from "@/components/app/end-interview";
import { Notice } from "@/components/app/notice";
import { Button } from "@/components/ui/button";

export interface EndControl {
  busy: boolean;
  error: string | null;
  onEnd: () => void;
}

/** "End interview" behind a confirmation dialog; `panel` carries the busy and error notices. */
export function useEndInterviewConfirm(control: EndControl | null, disabled = false) {
  const [confirming, setConfirming] = useState(false);

  const button = control ? (
    <ConfirmDialog
      open={confirming}
      onOpenChange={setConfirming}
      title="End the interview now?"
      description={END_CONFIRM_MESSAGE}
      confirmLabel="End interview"
      disabled={control.busy}
      onConfirm={control.onEnd}
      trigger={
        <Button
          variant="outline"
          size="sm"
          disabled={disabled || control.busy}
          className="border-danger/30 text-danger hover:bg-danger/10 hover:text-danger-foreground"
        >
          <Square className="size-3.5" aria-hidden />
          End interview
        </Button>
      }
    />
  ) : null;

  const panel = control ? (
    <>
      {control.busy ? (
        <Notice tone="info" icon={false}>
          <Loader2 className="size-4 shrink-0 motion-safe:animate-spin text-brand" aria-hidden />
          Ending the interview and saving your answers…
        </Notice>
      ) : null}
      {control.error ? <Notice tone="error">{control.error}</Notice> : null}
    </>
  ) : null;

  return { button, panel, confirming };
}
