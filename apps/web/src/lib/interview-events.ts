import {
  apiErrorSchema,
  type IntegrityFrameResponse,
  integrityFrameResponseSchema,
  type InterviewEventRequest,
  type ToolCallRequest,
} from "@stackprep/shared";
import { FunctionsHttpError } from "@supabase/supabase-js";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

export type SendEventResult =
  | { ok: true; ack: unknown }
  | { ok: false; retryable: boolean; code: string };

/**
 * Browser-side `POST /interviews/:id/events`. Lives apart from `api.ts`, which uses the
 * server-only Supabase client. The ack is returned unparsed; the outbox validates it.
 * 401 stays retryable so a session refresh race cannot drop transcript turns.
 */
export async function sendEvent(interviewId: string, event: InterviewEventRequest): Promise<SendEventResult> {
  const supabase = createSupabaseBrowserClient();
  const { data, error } = await supabase.functions.invoke(`interviews/${encodeURIComponent(interviewId)}/events`, {
    method: "POST",
    body: event,
  });
  if (!error) {
    return { ok: true, ack: data };
  }
  if (error instanceof FunctionsHttpError) {
    const res = error.context as Response;
    const parsed = apiErrorSchema.safeParse(await res.json().catch(() => null));
    const code = parsed.success ? parsed.data.code : `http_${res.status}`;
    const retryable = res.status >= 500 || res.status === 429 || res.status === 401;
    return { ok: false, retryable, code };
  }
  return { ok: false, retryable: true, code: "network_error" };
}

/**
 * Browser-side `POST /interviews/:id/integrity/frames`. The image is sent once and not kept.
 * Refusals (rate limited, interrupted, ended) come back as codes; the monitor skips them.
 */
export async function submitIntegrityFrame(
  interviewId: string,
  image: string,
): Promise<{ ok: true; body: IntegrityFrameResponse } | { ok: false; code: string }> {
  const supabase = createSupabaseBrowserClient();
  const { data, error } = await supabase.functions.invoke(
    `interviews/${encodeURIComponent(interviewId)}/integrity/frames`,
    { method: "POST", body: { image } },
  );
  if (!error) {
    const parsed = integrityFrameResponseSchema.safeParse(data);
    return parsed.success ? { ok: true, body: parsed.data } : { ok: false, code: "contract_error" };
  }
  if (error instanceof FunctionsHttpError) {
    const res = error.context as Response;
    const parsed = apiErrorSchema.safeParse(await res.json().catch(() => null));
    return { ok: false, code: parsed.success ? parsed.data.code : `http_${res.status}` };
  }
  return { ok: false, code: "network_error" };
}

/**
 * Browser-side `POST /interviews/:id/tool-calls`. Returns the unparsed result body, or null on any
 * network or HTTP failure; the relay validates the body and substitutes a tool error.
 */
export async function sendToolCall(interviewId: string, call: ToolCallRequest): Promise<unknown> {
  const supabase = createSupabaseBrowserClient();
  const { data, error } = await supabase.functions.invoke(`interviews/${encodeURIComponent(interviewId)}/tool-calls`, {
    method: "POST",
    body: call,
  });
  return error ? null : data;
}
