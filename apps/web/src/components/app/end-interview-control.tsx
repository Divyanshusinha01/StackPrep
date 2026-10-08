"use client";

import { useState } from "react";
import { Loader2, Square } from "lucide-react";
import { END_CONFIRM_MESSAGE } from "@/components/app/end-interview";
import { Notice } from "@/components/app/notice";
import { Button } from "@/components/ui/button";

export interface EndControl {
  busy: boolean;
  error: string | null;
  onEnd: () => void;
}

/** "End interview" with an inline confirm; the confirm renders below the row the button sits in. */
export function useEndInterviewConfirm(control: EndControl | null, disabled = false) {
  const [confirming, setConfirming] = useState(false);

  const button = control ? (
    <Button
      variant="outline"
      size="sm"
      onClick={() => setConfirming(true)}
      disabled={disabled || control.busy || confirming}
      className="border-red-500/30 text-red-300 hover:bg-red-500/10 hover:text-red-200"
    >
      <Square className="size-3.5" aria-hidden />
      End interview
    </Button>
  ) : null;

  const panel = control ? (
    <>
      {confirming ? (
        <Notice tone="info">
          <span className="min-w-0 flex-1">End the interview now? {END_CONFIRM_MESSAGE}</span>
          <Button
            size="sm"
            variant="destructive"
            disabled={control.busy}
            onClick={() => {
              setConfirming(false);
              control.onEnd();
            }}
          >
            End interview
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
            Cancel
          </Button>
        </Notice>
      ) : null}
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
