import { z } from "zod";
import {
  type AIProvider,
  AIInvalidOutputError,
  AIRateLimitedError,
  AIRequestError,
  AIUnavailableError,
  type AIUsage,
} from "./provider.ts";

const RESPONSES_URL = "https://api.openai.com/v1/responses";
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 16_000;
const DEFAULT_RETRY_AFTER_SECONDS = 30;

/** Keywords OpenAI structured outputs reject; Zod still enforces them on the parsed result. */
const UNSUPPORTED_SCHEMA_KEYWORDS = new Set(["$schema", "minLength", "maxLength"]);

export interface OpenAIProviderOptions {
  apiKey: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
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
  }).optional(),
});

export function toStrictJsonSchema(schema: z.ZodType): Record<string, unknown> {
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

function retryAfterSeconds(res: Response): number {
  const value = Number(res.headers.get("retry-after"));
  return Number.isFinite(value) && value > 0 ? Math.ceil(value) : DEFAULT_RETRY_AFTER_SECONDS;
}

/** OpenAI Responses API with strict JSON-schema output. Errors carry status codes only, never bodies. */
export function createOpenAIProvider({ apiKey, fetch: fetchFn = fetch, timeoutMs = DEFAULT_TIMEOUT_MS }: OpenAIProviderOptions): AIProvider {
  return {
    async generateStructured({ model, system, input, schemaName, schema, maxOutputTokens }) {
      let res: Response;
      try {
        res = await fetchFn(RESPONSES_URL, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model,
            instructions: system,
            input: [{ role: "user", content: input }],
            text: { format: { type: "json_schema", name: schemaName, schema: toStrictJsonSchema(schema), strict: true } },
            max_output_tokens: maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
            store: false,
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        throw new AIUnavailableError();
      }

      if (res.status === 429) {
        await res.body?.cancel();
        throw new AIRateLimitedError(retryAfterSeconds(res));
      }
      if (res.status >= 500) {
        await res.body?.cancel();
        throw new AIUnavailableError(res.status);
      }
      if (!res.ok) {
        await res.body?.cancel();
        throw new AIRequestError(res.status);
      }

      let raw: unknown;
      try {
        raw = await res.json();
      } catch {
        throw new AIUnavailableError(res.status);
      }
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
      return { output: output.data, usage };
    },
  };
}
