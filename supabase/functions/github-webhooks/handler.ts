import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { logGithubError } from "../_shared/github-errors.ts";
import { json } from "../_shared/http.ts";
import type { JobQueue } from "../_shared/jobs.ts";

const FN = "github-webhooks";
export const PUSH_EVENT = "repository.push.received";
const SIGNATURE_PREFIX = "sha256=";
const DELIVERY_ID = /^[A-Za-z0-9-]{1,64}$/;

const pushPayloadSchema = z.object({
  ref: z.string(),
  after: z.string(),
  deleted: z.boolean().optional(),
  forced: z.boolean().optional(),
  repository: z.object({ id: z.int().min(1), default_branch: z.string().min(1) }),
  installation: z.object({ id: z.int().min(1) }).optional(),
});

/** Bumps push_generation of every eligible workspace of the repository and returns their ids. */
export type MarkPushReceived = (githubRepoId: number, installationId: number) => Promise<string[]>;

export interface GithubWebhooksHandlerOptions {
  webhookSecret: string;
  markPushReceived: MarkPushReceived;
  jobs: JobQueue;
  log?: (line: string) => void;
  /** Reports an internal failure; defaults to the JSON error log plus Sentry. */
  reportError?: (err: unknown, event: string) => void;
}

export function createMarkPushReceived(serviceClient: SupabaseClient): MarkPushReceived {
  return async (githubRepoId, installationId) => {
    const { data, error } = await serviceClient.rpc("mark_push_received", {
      p_github_repo_id: githubRepoId,
      p_installation_id: installationId,
    });
    if (error) {
      throw new Error(`Failed to mark push: ${error.message}`);
    }
    return Array.isArray(data) ? data.filter((id): id is string => typeof id === "string") : [];
  };
}

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Checks `X-Hub-Signature-256` (HMAC-SHA256 of the raw body). `crypto.subtle.verify` compares in
 * constant time; a header of the wrong shape or length never reaches it.
 */
export async function verifySignature(secret: string, body: Uint8Array<ArrayBuffer>, header: string | null): Promise<boolean> {
  if (!header?.startsWith(SIGNATURE_PREFIX)) {
    return false;
  }
  const hex = header.slice(SIGNATURE_PREFIX.length);
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    return false;
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify("HMAC", key, hexToBytes(hex), body);
}

/**
 * GitHub App webhook receiver. A push to a repository's default branch marks every eligible
 * workspace as pending before anything is enqueued, so a lost event is recovered by the push
 * reconciler instead of needing a manual redelivery.
 */
export function createGithubWebhooksHandler({
  webhookSecret,
  markPushReceived,
  jobs,
  log = console.log,
  reportError = (err, event) => logGithubError(FN, err, { event, code: "internal_error" }),
}: GithubWebhooksHandlerOptions) {
  function logLine(entry: Record<string, string | number | boolean>): void {
    log(JSON.stringify({ fn: FN, ...entry }));
  }

  return async (req: Request): Promise<Response> => {
    if (req.method !== "POST") {
      return json({ error: "Method not allowed" }, { status: 405, headers: { Allow: "POST" } });
    }

    const body = new Uint8Array(await req.arrayBuffer());
    if (!await verifySignature(webhookSecret, body, req.headers.get("X-Hub-Signature-256"))) {
      logLine({ event: "webhook_signature_rejected" });
      return json({ error: "Invalid signature" }, { status: 401 });
    }

    const event = req.headers.get("X-GitHub-Event");
    if (event === "ping") {
      return json({ status: "pong" });
    }
    if (event !== "push") {
      return json({ status: "ignored" }, { status: 202 });
    }

    const deliveryId = req.headers.get("X-GitHub-Delivery") ?? "";
    let parsed: z.infer<typeof pushPayloadSchema> | null = null;
    try {
      const result = pushPayloadSchema.safeParse(JSON.parse(new TextDecoder().decode(body)));
      parsed = result.success ? result.data : null;
    } catch {
      parsed = null;
    }
    if (!parsed || !DELIVERY_ID.test(deliveryId)) {
      logLine({ event: "webhook_invalid_push" });
      return json({ error: "Invalid push payload" }, { status: 400 });
    }

    const push = parsed;
    if (push.deleted || !push.installation || push.ref !== `refs/heads/${push.repository.default_branch}`) {
      return json({ status: "ignored" }, { status: 202 });
    }
    const installationId = push.installation.id;

    let workspaceIds: string[];
    try {
      workspaceIds = await markPushReceived(push.repository.id, installationId);
    } catch (err) {
      reportError(err, "push_mark_failed");
      return json({ error: "Internal error", code: "internal_error" }, { status: 500 });
    }

    const results = await Promise.allSettled(workspaceIds.map((workspaceId) =>
      jobs.enqueue(PUSH_EVENT, {
        workspace_id: workspaceId,
        installation_id: installationId,
        dedupe_key: `push:${deliveryId}:${workspaceId}`,
      })
    ));
    const failed = results.filter((r) => r.status === "rejected");
    if (failed.length > 0) {
      // The pushes are already marked, so the reconciler re-emits them; GitHub needs no redelivery.
      reportError((failed[0] as PromiseRejectedResult).reason, "push_enqueue_failed");
    }

    logLine({
      event: "push_received",
      delivery_id: deliveryId,
      installation_id: installationId,
      forced: push.forced ?? false,
      workspaces: workspaceIds.length,
      enqueue_failed: failed.length,
    });
    return json({ status: "accepted", workspaces: workspaceIds.length }, { status: 202 });
  };
}
