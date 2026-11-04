"use client";

import { useActionState, useState } from "react";
import { Check, Copy, Link2, Link2Off, Loader2 } from "lucide-react";
import { createShareLink, revokeShareLink, type ShareState } from "@/app/interviews/[id]/report/actions";
import { Notice } from "@/components/app/notice";
import { Surface } from "@/components/app/surface";
import { Button } from "@/components/ui/button";

const IDLE: ShareState = { status: "idle" };

const dateFormat = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: "UTC" });

function errorMessage(code: string): string {
  if (code === "report_not_ready" || code === "interview_not_completed") {
    return "The report has to be ready before it can be shared.";
  }
  if (code === "interview_not_found") {
    return "This interview no longer exists.";
  }
  return "Could not update the link. Try again.";
}

/**
 * Read-only link to this report. The link contains only the report (no transcript) and is shown
 * once, when it is created: the server keeps a hash, so it cannot be shown again. Creating a new
 * link or revoking stops the old one.
 */
export function ShareReportControl({
  interviewId,
  active,
  activeSince,
}: {
  interviewId: string;
  active: boolean;
  activeSince: string | null;
}) {
  const [state, action, pending] = useActionState(
    (previous: ShareState, formData: FormData) =>
      formData.get("intent") === "revoke" ? revokeShareLink(previous, formData) : createShareLink(previous, formData),
    IDLE,
  );
  const [copied, setCopied] = useState(false);

  const url = state.status === "created" ? state.url : null;
  // After an action, its outcome applies; before any, the server-rendered state does.
  const isActive = state.status === "created" || (state.status !== "revoked" && active);

  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <Surface className="mb-8 p-4 print:hidden" role="region" aria-labelledby="share-report-heading">
      <form action={action}>
        <input type="hidden" name="interview_id" value={interviewId} />
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <h2 id="share-report-heading" className="flex items-center gap-2 text-sm font-medium">
              <Link2 className="size-4 text-brand" aria-hidden />
              Share a read-only link
            </h2>
            <p className="mt-1 max-w-xl text-xs leading-relaxed text-muted-foreground">
              Anyone with the link can read this report, including your answers to the reviewed questions. The
              full transcript is not included.
              {isActive && !url && activeSince
                ? ` A link has been active since ${dateFormat.format(new Date(activeSince))} UTC. It is not shown again, but you can replace it.`
                : null}
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <Button
              type="submit"
              name="intent"
              value="create"
              variant={isActive ? "outline" : "secondary"}
              size="sm"
              disabled={pending}
            >
              {pending ? <Loader2 className="motion-safe:animate-spin" aria-hidden /> : <Link2 aria-hidden />}
              {isActive ? "Create new link" : "Create link"}
            </Button>
            {isActive ? (
              <Button type="submit" name="intent" value="revoke" variant="ghost" size="sm" disabled={pending}>
                <Link2Off aria-hidden />
                Revoke
              </Button>
            ) : null}
          </div>
        </div>
      </form>

      {url ? (
        <>
          <div className="mt-3 flex items-center gap-2">
            <input
              readOnly
              value={url}
              aria-label="Read-only report link"
              onFocus={(event) => event.currentTarget.select()}
              className="focus-ring min-w-0 flex-1 rounded-md border bg-background/60 px-3 py-1.5 font-mono text-xs"
            />
            <Button type="button" variant="outline" size="sm" onClick={() => copy(url)}>
              {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            Copy it now: it is not shown again. Creating a new link or revoking stops this one.
          </p>
        </>
      ) : null}
      {state.status === "revoked" ? (
        <p role="status" className="mt-3 text-xs text-muted-foreground">
          The link no longer works.
        </p>
      ) : null}
      {state.status === "error" ? <Notice tone="error">{errorMessage(state.code)}</Notice> : null}
    </Surface>
  );
}
