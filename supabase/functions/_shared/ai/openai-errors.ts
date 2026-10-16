import { z } from "zod";

/** Only `error.code` and `error.type` are read from a failed response; the message is never read or kept. */
const errorBodySchema = z.object({
  error: z.object({
    code: z.string().max(100).nullish(),
    type: z.string().max(100).nullish(),
  }).nullish(),
});

/** How an OpenAI request failed, from the status and the error code alone. */
export type OpenAIFailure =
  | "auth"
  | "permission"
  | "model_unavailable"
  | "quota"
  | "rate_limited"
  | "unavailable"
  | "rejected";

const DEFAULT_RETRY_AFTER_SECONDS = 30;

export function retryAfterSeconds(res: Response): number {
  const value = Number(res.headers.get("retry-after"));
  return Number.isFinite(value) && value > 0 ? Math.ceil(value) : DEFAULT_RETRY_AFTER_SECONDS;
}

/** Reads and consumes the failed response's body. */
export async function readErrorCode(res: Response): Promise<{ code: string | null; type: string | null }> {
  const parsed = errorBodySchema.safeParse(await res.json().catch(() => null));
  const error = parsed.success ? parsed.data.error : null;
  return { code: error?.code ?? null, type: error?.type ?? null };
}

export function classifyOpenAIFailure(status: number, error: { code: string | null; type: string | null }): OpenAIFailure {
  if (status === 401) {
    return "auth";
  }
  if (status === 403) {
    return "permission";
  }
  if (status === 404 && error.code === "model_not_found") {
    return "model_unavailable";
  }
  if (status === 429) {
    return error.code === "insufficient_quota" || error.type === "insufficient_quota" ? "quota" : "rate_limited";
  }
  return status >= 500 ? "unavailable" : "rejected";
}

/** Reads the failed response and classifies it. */
export async function failureOf(res: Response): Promise<OpenAIFailure> {
  return classifyOpenAIFailure(res.status, await readErrorCode(res));
}
