import { z } from "zod";
import { failureOf, type OpenAIFailure, retryAfterSeconds } from "./openai-errors.ts";
import {
  AIAuthError,
  AIInvalidOutputError,
  AIPermissionError,
  type AIProvider,
  AIQuotaError,
  AIRateLimitedError,
  AIRequestError,
  AIUnavailableError,
  type AIUsage,
  type EmbeddingProvider,
} from "./provider.ts";

const RESPONSES_URL = "https://api.openai.com/v1/responses";
const EMBEDDINGS_URL = "https://api.openai.com/v1/embeddings";
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 16_000;
const DEFAULT_RETRY_DELAY_MS = 250;

/** Keywords OpenAI structured outputs reject; Zod still enforces them on the parsed result. */
const UNSUPPORTED_SCHEMA_KEYWORDS = new Set(["$schema", "minLength", "maxLength"]);

type LogEntry = Record<string, string | number | boolean>;

export interface OpenAIProviderOptions {
  apiKey: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Pause before a retry of an unavailable call. */
  retryDelayMs?: number;
  /** One line per call with latency and token counts; never content. Defaults to console.log JSON. */
  log?: (entry: LogEntry) => void;
}

function defaultLog(entry: LogEntry): void {
  console.log(JSON.stringify({ fn: "ai", ...entry }));
}

const responseSchema = z.object({
  status: z.string(),
  output: z.array(
    z.object({
      type: z.string(),
      content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional(),
    }),
  ).default([]),
  usage: z.object({
    input_tokens: z.int().min(0),
    output_tokens: z.int().min(0),
    input_tokens_details: z.object({ cached_tokens: z.int().min(0) }).optional(),
    output_tokens_details: z.object({ reasoning_tokens: z.int().min(0) }).optional(),
  }).optional(),
});

const strictSchemaCache = new WeakMap<z.ZodType, Record<string, unknown>>();

export function toStrictJsonSchema(schema: z.ZodType): Record<string, unknown> {
  let cached = strictSchemaCache.get(schema);
  if (!cached) {
    cached = buildStrictJsonSchema(schema);
    strictSchemaCache.set(schema, cached);
  }
  return cached;
}

function buildStrictJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const strip = (node: unknown): unknown => {
    if (Array.isArray(node)) {
      return node.map(strip);
    }
    if (node && typeof node === "object") {
      return Object.fromEntries(
        Object.entries(node).filter(([key]) => !UNSUPPORTED_SCHEMA_KEYWORDS.has(key)).map(([k, v]) => [k, strip(v)]),
      );
    }
    return node;
  };
  return strip(z.toJSONSchema(schema)) as Record<string, unknown>;
}

/**
 * POSTs JSON and returns the parsed body. Network failures, aborts, timeouts, and 5xx are
 * AIUnavailableError; a rate-limit 429 is AIRateLimitedError; 401 is AIAuthError, 403 and an
 * unknown model are AIPermissionError, 429 `insufficient_quota` is AIQuotaError, and other 4xx are
 * AIRequestError. Only the error code of a failed response is read; its message is never surfaced.
 */
async function postJson(fetchFn: typeof fetch, url: string, apiKey: string, body: unknown, signal: AbortSignal): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchFn(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch {
    throw new AIUnavailableError();
  }

  if (res.status >= 500) {
    await res.body?.cancel();
    throw new AIUnavailableError(res.status);
  }
  if (!res.ok) {
    throw aiErrorFor(res, await failureOf(res));
  }

  try {
    return await res.json();
  } catch {
    throw new AIUnavailableError(res.status);
  }
}

function aiErrorFor(res: Response, failure: OpenAIFailure): AIRequestError | AIRateLimitedError {
  switch (failure) {
    case "auth":
      return new AIAuthError();
    case "permission":
      return new AIPermissionError(res.status, "permission_denied");
    case "model_unavailable":
      return new AIPermissionError(res.status, "model_unavailable");
    case "quota":
      return new AIQuotaError();
    case "rate_limited":
      return new AIRateLimitedError(retryAfterSeconds(res));
    default:
      return new AIRequestError(res.status);
  }
}

function errorReason(err: unknown): string {
  return err instanceof AIInvalidOutputError ? `${err.name}:${err.reason}` : err instanceof Error ? err.name : "unknown";
}

/** OpenAI Responses API with strict JSON-schema output. Errors carry status codes only, never bodies. */
export function createOpenAIProvider({
  apiKey,
  fetch: fetchFn = fetch,
  timeoutMs: defaultTimeoutMs = DEFAULT_TIMEOUT_MS,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  log = defaultLog,
}: OpenAIProviderOptions): AIProvider {
  return {
    async generateStructured(request) {
      const { model, system, input, images, schemaName, schema, maxOutputTokens, reasoningEffort, verbosity } = request;
      const timeoutMs = request.timeoutMs ?? defaultTimeoutMs;
      const retries = Math.max(0, request.retries ?? 0);
      const userContent = images?.length
        ? [
          { type: "input_text", text: input },
          ...images.map((url) => ({ type: "input_image", image_url: url, detail: "low" })),
        ]
        : input;
      const body = {
        model,
        instructions: system,
        input: [{ role: "user", content: userContent }],
        text: {
          format: { type: "json_schema", name: schemaName, schema: toStrictJsonSchema(schema), strict: true },
          ...(verbosity ? { verbosity } : {}),
        },
        ...(reasoningEffort && reasoningEffort !== "default" ? { reasoning: { effort: reasoningEffort } } : {}),
        max_output_tokens: maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
        store: false,
      };

      for (let attempt = 1;; attempt++) {
        const startedAt = Date.now();
        const entry = { event: "ai_call", kind: "structured", model, schema: schemaName, attempt };
        try {
          const result = await requestStructured(fetchFn, apiKey, body, schema, AbortSignal.timeout(timeoutMs));
          log({
            ...entry,
            outcome: "ok",
            elapsed_ms: Date.now() - startedAt,
            input_tokens: result.usage.input_tokens,
            cached_input_tokens: result.usage.cached_input_tokens,
            output_tokens: result.usage.output_tokens,
            reasoning_tokens: result.usage.reasoning_tokens ?? 0,
          });
          return result;
        } catch (err) {
          const retry = err instanceof AIUnavailableError && attempt <= retries;
          log({ ...entry, outcome: errorReason(err), elapsed_ms: Date.now() - startedAt, retry });
          if (!retry) {
            throw err;
          }
          await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        }
      }
    },
  };
}

async function requestStructured<T>(
  fetchFn: typeof fetch,
  apiKey: string,
  requestBody: unknown,
  schema: z.ZodType<T>,
  signal: AbortSignal,
): Promise<{ output: T; usage: AIUsage }> {
  const raw = await postJson(fetchFn, RESPONSES_URL, apiKey, requestBody, signal);
  const parsed = responseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AIInvalidOutputError("malformed");
  }
  const body = parsed.data;
  const content = body.output.filter((item) => item.type === "message").flatMap((item) => item.content ?? []);
  if (content.some((c) => c.type === "refusal")) {
    throw new AIInvalidOutputError("refusal");
  }
  if (body.status !== "completed") {
    throw new AIInvalidOutputError("incomplete");
  }
  const text = content.filter((c) => c.type === "output_text").map((c) => c.text ?? "").join("");

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new AIInvalidOutputError("malformed");
  }
  const output = schema.safeParse(json);
  if (!output.success) {
    throw new AIInvalidOutputError("schema_mismatch");
  }

  const usage: AIUsage = {
    input_tokens: body.usage?.input_tokens ?? 0,
    cached_input_tokens: body.usage?.input_tokens_details?.cached_tokens ?? 0,
    output_tokens: body.usage?.output_tokens ?? 0,
  };
  const reasoning = body.usage?.output_tokens_details?.reasoning_tokens;
  if (reasoning !== undefined) {
    usage.reasoning_tokens = reasoning;
  }
  return { output: output.data, usage };
}

const embeddingResponseSchema = z.object({
  data: z.array(z.object({ index: z.int().min(0), embedding: z.array(z.number()) })),
  usage: z.object({ prompt_tokens: z.int().min(0) }).optional(),
});

/**
 * OpenAI embeddings API. Never sends `dimensions`, so vectors keep the model's native size; callers
 * validate that size. The caller's signal and the provider timeout both abort the request.
 */
export function createOpenAIEmbeddingProvider(
  { apiKey, fetch: fetchFn = fetch, timeoutMs = DEFAULT_TIMEOUT_MS, log = defaultLog }: OpenAIProviderOptions,
): EmbeddingProvider {
  return {
    async embed({ model, input, signal }) {
      const startedAt = Date.now();
      const entry = { event: "ai_call", kind: "embedding", model, inputs: input.length };
      try {
        const result = await requestEmbeddings(fetchFn, apiKey, model, input, signal, timeoutMs);
        log({ ...entry, outcome: "ok", elapsed_ms: Date.now() - startedAt, input_tokens: result.usage.input_tokens });
        return result;
      } catch (err) {
        log({ ...entry, outcome: errorReason(err), elapsed_ms: Date.now() - startedAt });
        throw err;
      }
    },
  };
}

async function requestEmbeddings(
  fetchFn: typeof fetch,
  apiKey: string,
  model: string,
  input: string[],
  signal: AbortSignal | undefined,
  timeoutMs: number,
) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const raw = await postJson(fetchFn, EMBEDDINGS_URL, apiKey, {
    model,
    input,
    encoding_format: "float",
  }, signal ? AbortSignal.any([signal, timeout]) : timeout);
  const parsed = embeddingResponseSchema.safeParse(raw);
  if (!parsed.success || parsed.data.data.length !== input.length) {
    throw new AIInvalidOutputError("malformed");
  }
  const embeddings = new Array<number[]>(input.length);
  for (const item of parsed.data.data) {
    if (item.index >= input.length || embeddings[item.index] !== undefined) {
      throw new AIInvalidOutputError("malformed");
    }
    embeddings[item.index] = item.embedding;
  }
  return { embeddings, usage: { input_tokens: parsed.data.usage?.prompt_tokens ?? 0 } };
}
