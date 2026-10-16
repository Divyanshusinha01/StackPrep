import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, ExternalLink, KeyRound } from "lucide-react";
import { type ApiErrorCode, apiErrorCodeSchema, type OpenAIKeyStatusResponse } from "@stackprep/shared";
import { AppShell } from "@/components/app/app-shell";
import { Notice } from "@/components/app/notice";
import { OpenAIKeyForm } from "@/components/app/openai-key-form";
import { PageHeader } from "@/components/app/page-header";
import { SetupChecklist } from "@/components/app/setup-checklist";
import { type ChipTone, StatusChip } from "@/components/app/status-chip";
import { Button } from "@/components/ui/button";
import { getOpenAIKeyStatus } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { keyStatusSetupCode } from "@/lib/openai-key-setup";
import { settingsReturnPath } from "@/lib/return-to";
import { deleteOpenAIKeyAction, revalidateOpenAIKeyAction, saveOpenAIKeyAction } from "./actions";

export const metadata: Metadata = {
  title: "Settings",
  robots: { index: false },
};

const MODEL_ID = /^[A-Za-z0-9._:-]{1,100}$/;
const dateTimeFormat = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });

function errorMessage(code: ApiErrorCode, model: string | null): string {
  switch (code) {
    case "invalid_request":
      return "That does not look like an OpenAI secret key. Paste a project or user key that starts with sk-; admin keys are not accepted.";
    case "rate_limited":
      return "Too many key checks. Wait 10 minutes, then try again.";
    case "openai_key_invalid":
      return "OpenAI rejected this key. Check that it was copied in full and has not been revoked.";
    case "openai_key_permission_denied":
      return model
        ? `This key cannot use ${model}. Allow that model for the key's project on OpenAI, then try again.`
        : "This key cannot use a model StackPrep needs. Check the key's project permissions on OpenAI.";
    case "openai_quota_exhausted":
      return "This OpenAI account has no remaining quota. Add credit or raise its usage limit on OpenAI, then try again.";
    case "openai_rate_limited":
      return "OpenAI is rate limiting this key right now. Wait a moment, then try again.";
    case "openai_unavailable":
      return "OpenAI could not be reached to check the key. Nothing was changed; try again shortly.";
    case "openai_key_required":
      return "No key is saved yet. Add one below.";
    default:
      return "Could not update the key. Try again.";
  }
}

function param(value: string | string[] | undefined): string | null {
  return typeof value === "string" ? value : null;
}

const STATUS_COPY: Record<Exclude<OpenAIKeyStatusResponse, { configured: false }>["status"], { label: string; tone: ChipTone }> = {
  valid: { label: "Working", tone: "success" },
  invalid: { label: "Rejected by OpenAI", tone: "danger" },
  quota_exhausted: { label: "Out of quota", tone: "warning" },
  permission_denied: { label: "Missing model access", tone: "warning" },
};

function backLabel(path: string): string {
  if (path.startsWith("/interviews/")) {
    return "Back to interview";
  }
  if (path.startsWith("/workspaces/new")) {
    return "Back to repositories";
  }
  if (path.startsWith("/workspaces/")) {
    return "Back to workspace";
  }
  return "Back";
}

const STATUS_HELP: Record<Exclude<OpenAIKeyStatusResponse, { configured: false }>["status"], string | null> = {
  valid: null,
  invalid: "OpenAI no longer accepts this key (it may have been revoked). Replace it to keep using AI features.",
  quota_exhausted: "Your OpenAI account ran out of credit or hit its spend limit. Fix billing on OpenAI, then re-check the key.",
  permission_denied: "This key cannot use a model StackPrep needs. Adjust the key's project permissions, then re-check it.",
};

function KeyStatus({ status }: { status: Exclude<OpenAIKeyStatusResponse, { configured: false }> }) {
  const copy = STATUS_COPY[status.status];
  const validatedAt = status.validated_at ? new Date(status.validated_at) : null;
  return (
    <div className="mt-6 rounded-lg border bg-panel/70 p-4" data-testid="openai-key-status">
      <div className="flex flex-wrap items-center gap-3">
        <span className="font-mono text-sm">{status.key_hint}</span>
        <StatusChip tone={copy.tone} data-testid="openai-key-state">
          {copy.label}
        </StatusChip>
      </div>
      {validatedAt ? (
        <p className="mt-2 text-xs text-muted-foreground">Last validated {dateTimeFormat.format(validatedAt)} UTC</p>
      ) : null}
      {STATUS_HELP[status.status] ? <p className="mt-2 text-sm text-muted-foreground">{STATUS_HELP[status.status]}</p> : null}
    </div>
  );
}

export default async function SettingsPage({ searchParams }: PageProps<"/settings">) {
  const user = await requireUser("/settings");
  const query = await searchParams;
  const returnTo = settingsReturnPath(param(query.return_to));
  const error = apiErrorCodeSchema.safeParse(param(query.error));
  const model = param(query.model);
  const saved = query.saved === "1";
  const validated = query.validated === "1";
  const deleted = query.deleted === "1";
  const onboarding = query.onboarding === "1";

  const result = await getOpenAIKeyStatus();
  const status = result.ok ? result.data : null;
  const working = status?.configured === true && status.status === "valid";
  const keyCode = status ? keyStatusSetupCode(status) : null;

  return (
    <AppShell user={user} keyAlert={keyCode !== null}>
      {onboarding ? (
        <PageHeader
          title="Add your OpenAI API key"
          description="Step 2 of 3. StackPrep runs on your own OpenAI key, so add it before connecting a repository."
        >
          <SetupChecklist keyReady={working} className="mt-4" />
        </PageHeader>
      ) : (
        <PageHeader
          title="Settings"
          description="Manage how StackPrep connects to OpenAI on your behalf."
          back={returnTo ? { href: returnTo, label: backLabel(returnTo) } : undefined}
        />
      )}

      <section aria-labelledby="openai-key" className="surface-inset max-w-3xl rounded-xl border bg-panel/60 p-6">
        <h2 id="openai-key" className="flex items-center gap-2.5 font-display text-lg font-semibold tracking-tight">
          <KeyRound className="size-4 text-brand" aria-hidden />
          OpenAI API key
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          StackPrep uses your own OpenAI key for every AI feature: repository analysis, the voice interviewer,
          answer evaluation, and reports. You pay OpenAI directly; StackPrep never funds or marks up usage. The key is
          encrypted before it is stored and is never shown again, only its last four characters.
        </p>
        <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm">
          <a
            href="https://platform.openai.com/settings/organization/billing/overview"
            target="_blank"
            rel="noreferrer"
            className="focus-ring inline-flex items-center gap-1 rounded-sm text-brand hover:underline"
          >
            OpenAI billing
            <ExternalLink className="size-3.5" aria-hidden />
            <span className="sr-only">(opens in a new tab)</span>
          </a>
          <a
            href="https://platform.openai.com/settings/organization/limits"
            target="_blank"
            rel="noreferrer"
            className="focus-ring inline-flex items-center gap-1 rounded-sm text-brand hover:underline"
          >
            Usage limits
            <ExternalLink className="size-3.5" aria-hidden />
            <span className="sr-only">(opens in a new tab)</span>
          </a>
          {status?.configured ? (
            <a
              href="https://platform.openai.com/usage"
              target="_blank"
              rel="noreferrer"
              className="focus-ring inline-flex items-center gap-1 rounded-sm text-brand hover:underline"
            >
              Compare with your OpenAI usage
              <ExternalLink className="size-3.5" aria-hidden />
            <span className="sr-only">(opens in a new tab)</span>
            </a>
          ) : null}
        </p>

        <details className="mt-4 rounded-lg border bg-background/40 px-4 py-3 text-sm" open={onboarding && !status?.configured}>
          <summary className="cursor-pointer font-medium text-foreground/90 focus-ring rounded-sm">How to create a key</summary>
          <ol className="mt-3 list-decimal space-y-1.5 pl-5 leading-relaxed text-muted-foreground">
            <li>
              Open{" "}
              <a
                href="https://platform.openai.com/api-keys"
                target="_blank"
                rel="noreferrer"
                className="focus-ring inline-flex items-center gap-1 rounded-sm text-brand hover:underline"
              >
                API keys on OpenAI
                <ExternalLink className="size-3.5" aria-hidden />
            <span className="sr-only">(opens in a new tab)</span>
              </a>{" "}
              and create a secret key. A project key scoped to StackPrep is easiest to track and revoke.
            </li>
            <li>
              Allow the project to use the models StackPrep needs: realtime voice, text, and embeddings. If one is
              blocked, StackPrep names it when it checks the key.
            </li>
            <li>Make sure the account has credit or a usage limit above zero. Admin keys are not accepted.</li>
            <li>Paste the key below. StackPrep checks it with OpenAI before saving it.</li>
          </ol>
        </details>

        {saved ? <Notice tone="success">Key validated and saved.</Notice> : null}
        {validated ? <Notice tone="success">Key re-checked: it works.</Notice> : null}
        {deleted ? <Notice tone="success">Key deleted. AI features are off until you add a key.</Notice> : null}
        {!result.ok ? <Notice tone="error">Could not load your key status. Reload the page.</Notice> : null}

        {status?.configured ? <KeyStatus status={status} /> : null}
        {status && !status.configured ? (
          <div className="mt-6 rounded-lg border border-dashed bg-panel/50 p-4" data-testid="openai-key-missing">
            <StatusChip tone="neutral">Not set up</StatusChip>
            <p className="mt-2 text-sm text-muted-foreground">
              No key saved. Add one to create workspaces and start interviews.
            </p>
          </div>
        ) : null}

        {returnTo && working ? (
          <Button asChild className="mt-6">
            <Link href={returnTo}>
              Continue
              <ArrowRight aria-hidden />
            </Link>
          </Button>
        ) : null}

        {result.ok ? (
          <OpenAIKeyForm
            configured={status?.configured === true}
            returnTo={returnTo}
            onboarding={onboarding}
            error={error.success ? errorMessage(error.data, model && MODEL_ID.test(model) ? model : null) : null}
            saveAction={saveOpenAIKeyAction}
            revalidateAction={revalidateOpenAIKeyAction}
            deleteAction={deleteOpenAIKeyAction}
          />
        ) : null}
      </section>
    </AppShell>
  );
}
