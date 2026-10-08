"use client";

import { useFormStatus } from "react-dom";
import { Loader2, Trash2 } from "lucide-react";
import { deleteInterview } from "@/app/interviews/actions";
import { Button } from "@/components/ui/button";

function confirmMessage(interviewNumber: number): string {
  return `Delete Interview ${interviewNumber}? It will be removed from your history. It still counts toward your daily interview limit.`;
}

function DeleteSubmit({ interviewNumber }: { interviewNumber: number }) {
  const { pending } = useFormStatus();
  return (
    <Button
      type="submit"
      variant="ghost"
      size="icon-xs"
      disabled={pending}
      aria-label={`Delete Interview ${interviewNumber}`}
      title="Delete interview"
      className="text-muted-foreground hover:text-red-300"
    >
      {pending ? <Loader2 className="animate-spin" aria-hidden /> : <Trash2 aria-hidden />}
    </Button>
  );
}

/** Deletes an ended interview from history after a browser confirm. */
export function DeleteInterviewButton({
  interviewId,
  interviewNumber,
  returnTo,
}: {
  interviewId: string;
  interviewNumber: number;
  returnTo: string;
}) {
  return (
    <form
      action={deleteInterview}
      onSubmit={(event) => {
        if (!window.confirm(confirmMessage(interviewNumber))) {
          event.preventDefault();
        }
      }}
    >
      <input type="hidden" name="interview_id" value={interviewId} />
      <input type="hidden" name="return_to" value={returnTo} />
      <DeleteSubmit interviewNumber={interviewNumber} />
    </form>
  );
}
