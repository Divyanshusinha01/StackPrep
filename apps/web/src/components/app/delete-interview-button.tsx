"use client";

import { useRef } from "react";
import { useFormStatus } from "react-dom";
import { Loader2, Trash2 } from "lucide-react";
import { deleteInterview } from "@/app/interviews/actions";
import { ConfirmDialog } from "@/components/app/confirm-dialog";
import { Button } from "@/components/ui/button";

function DeleteControl({ interviewNumber, onConfirm }: { interviewNumber: number; onConfirm: () => void }) {
  const { pending } = useFormStatus();
  return (
    <ConfirmDialog
      title={`Delete Interview ${interviewNumber}?`}
      description="It will be removed from your history. It still counts toward your daily interview limit."
      confirmLabel="Delete interview"
      onConfirm={onConfirm}
      trigger={
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          disabled={pending}
          aria-label={`Delete Interview ${interviewNumber}`}
          title="Delete interview"
          className="text-muted-foreground hover:bg-danger/10 hover:text-danger"
        >
          {pending ? <Loader2 className="motion-safe:animate-spin" aria-hidden /> : <Trash2 aria-hidden />}
        </Button>
      }
    />
  );
}

/** Deletes an ended interview from history after a confirmation dialog. */
export function DeleteInterviewButton({
  interviewId,
  interviewNumber,
  returnTo,
}: {
  interviewId: string;
  interviewNumber: number;
  returnTo: string;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  return (
    <form ref={formRef} action={deleteInterview}>
      <input type="hidden" name="interview_id" value={interviewId} />
      <input type="hidden" name="return_to" value={returnTo} />
      <DeleteControl interviewNumber={interviewNumber} onConfirm={() => formRef.current?.requestSubmit()} />
    </form>
  );
}
