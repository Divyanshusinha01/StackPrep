"use client";

import { useId, useRef } from "react";
import { useFormStatus } from "react-dom";
import { CircleAlert, Loader2, RefreshCw, Trash2 } from "lucide-react";
import { ConfirmDialog } from "@/components/app/confirm-dialog";
import { SubmitButton } from "@/components/app/submit-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type FormAction = (formData: FormData) => Promise<void>;

function DeleteKeyControl({ onConfirm }: { onConfirm: () => void }) {
  const { pending } = useFormStatus();
  return (
    <ConfirmDialog
      title="Delete your OpenAI key?"
      description="Interviews, analysis, and reports will stop until you add one again."
      confirmLabel="Delete key"
      onConfirm={onConfirm}
      trigger={
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={pending}
          aria-busy={pending || undefined}
          className="text-danger hover:bg-danger/10 hover:text-danger-foreground"
        >
          {pending ? <Loader2 className="motion-safe:animate-spin" aria-hidden /> : <Trash2 aria-hidden />}
          {pending ? "Deleting…" : "Delete key"}
        </Button>
      }
    />
  );
}

/**
 * Save, re-check, and delete for the account's OpenAI key. Actions arrive as props from the server
 * page; the input is never pre-filled and the key is only ever sent in the form body.
 */
export function OpenAIKeyForm({ configured, returnTo, onboarding, error, saveAction, revalidateAction, deleteAction }: {
  configured: boolean;
  returnTo: string | null;
  /** First-run setup: saving continues to `returnTo` instead of staying on Settings. */
  onboarding: boolean;
  /** Message for the last failed key action, shown under the key field. */
  error: string | null;
  saveAction: FormAction;
  revalidateAction: FormAction;
  deleteAction: FormAction;
}) {
  const inputId = useId();
  const errorId = useId();
  const helpId = useId();
  const deleteFormRef = useRef<HTMLFormElement>(null);
  const returnField = (
    <>
      {returnTo ? <input type="hidden" name="return_to" value={returnTo} /> : null}
      {onboarding ? <input type="hidden" name="onboarding" value="1" /> : null}
    </>
  );

  return (
    <div className="mt-6 space-y-4">
      <form action={saveAction} className="flex flex-col gap-3 sm:flex-row sm:items-start">
        {returnField}
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <label htmlFor={inputId} className="text-sm font-medium">
            {configured ? "Replace key" : "OpenAI API key"}
          </label>
          <Input
            id={inputId}
            type="password"
            name="api_key"
            required
            autoComplete="off"
            spellCheck={false}
            autoCapitalize="off"
            placeholder="sk-proj-…"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${errorId} ${helpId}` : helpId}
            className="font-mono"
            data-testid="openai-key-input"
          />
          {error ? (
            <p id={errorId} role="alert" className="flex items-start gap-1.5 text-sm leading-relaxed text-danger-foreground">
              <CircleAlert className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden />
              <span>{error}</span>
            </p>
          ) : null}
        </div>
        <SubmitButton pendingLabel="Validating with OpenAI…" className="h-10 sm:mt-[1.625rem] sm:w-auto">
          {configured ? "Validate and replace" : onboarding ? "Validate and continue" : "Validate and save"}
        </SubmitButton>
      </form>
      <p id={helpId} className="text-xs leading-relaxed text-muted-foreground">
        StackPrep checks the key against OpenAI before storing it (one tiny embedding request, billed to you). If the
        check fails, any key already saved stays in place.
      </p>

      {configured ? (
        <div className="flex flex-wrap gap-2">
          <form action={revalidateAction}>
            {returnField}
            <SubmitButton variant="outline" size="sm" pendingLabel="Checking…">
              <RefreshCw aria-hidden />
              Re-check key
            </SubmitButton>
          </form>
          <form ref={deleteFormRef} action={deleteAction}>
            {returnField}
            <DeleteKeyControl onConfirm={() => deleteFormRef.current?.requestSubmit()} />
          </form>
        </div>
      ) : null}
    </div>
  );
}
