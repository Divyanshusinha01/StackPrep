"use client";

import { useRef } from "react";
import { useFormStatus } from "react-dom";
import { Loader2, Sparkles } from "lucide-react";
import { upgradeReport } from "@/app/interviews/[id]/report/actions";
import { ConfirmDialog } from "@/components/app/confirm-dialog";
import { Button } from "@/components/ui/button";

function UpgradeControl({ label, onConfirm }: { label: string; onConfirm: () => void }) {
  const { pending } = useFormStatus();
  return (
    <ConfirmDialog
      title="Regenerate this report?"
      description={
        <div className="space-y-2">
          <p>
            StackPrep will rebuild the report from your saved transcript with a review of every answer,
            concepts to learn with resources, and a learning plan.
          </p>
          <p>
            This uses your OpenAI API key and is billed to your OpenAI account. The current report stays
            here until the new one is ready.
          </p>
        </div>
      }
      confirmLabel="Regenerate report"
      tone="default"
      onConfirm={onConfirm}
      trigger={
        <Button type="button" variant="outline" size="sm" disabled={pending} className="print:hidden">
          {pending ? <Loader2 className="motion-safe:animate-spin" aria-hidden /> : <Sparkles aria-hidden />}
          {pending ? "Starting…" : label}
        </Button>
      }
    />
  );
}

/** Regenerates a legacy report as a learning report after a confirmation dialog. */
export function UpgradeReportButton({ interviewId, label }: { interviewId: string; label: string }) {
  const formRef = useRef<HTMLFormElement>(null);
  return (
    <form ref={formRef} action={upgradeReport}>
      <input type="hidden" name="interview_id" value={interviewId} />
      <UpgradeControl label={label} onConfirm={() => formRef.current?.requestSubmit()} />
    </form>
  );
}
