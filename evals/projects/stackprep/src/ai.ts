/**
 * Recorded wrappers around the production AIProvider and EmbeddingProvider. Every call goes through the
 * core Recorder, keyed on the request parameters that can change the output; the recorder adds the
 * format version, site, sample index and pin hashes. Replay needs no API key and makes no network calls.
 *
 * Key components for generateStructured: model, reasoning effort, verbosity, max output tokens, schema
 * name, the exact strict JSON Schema the provider sends (`toStrictJsonSchema`), system, input, and image
 * hashes. For embed: model, expected dimensions, stored precision and the input texts. `timeoutMs`,
 * `retries` and abort signals are excluded: they do not change the output.
 */
import { REPOSITORY_MEMORY_EMBEDDING_DIMENSIONS } from "@stackprep/shared";
import {
  createOpenAIEmbeddingProvider,
  createOpenAIProvider,
  type OpenAIProviderOptions,
  toStrictJsonSchema,
} from "../../../../supabase/functions/_shared/ai/openai.ts";
import {
  type AIProvider,
  AIInvalidOutputError,
  type AIUsage,
  assertEmbeddingDimensions,
  type EmbeddingProvider,
  type EmbeddingRequest,
  type EmbeddingResult,
  type StructuredRequest,
  type StructuredResult,
} from "../../../../supabase/functions/_shared/ai/provider.ts";
import { sha256 } from "../../../core/keys.ts";
import type { Recorder } from "../../../core/types.ts";

/** Decimal places kept in recorded vectors, so committed embeddings stay small and diff-stable. */
export const DEFAULT_EMBEDDING_DECIMALS = 5;

type InvalidReason = AIInvalidOutputError["reason"];

/**
 * What a structured call stores. Invalid output (refusal, incomplete, schema mismatch) is model
 * behaviour and is recorded so replay reproduces it; transport and request errors are never recorded.
 */
type StructuredRecording = { result: { output: unknown; usage: AIUsage } } | { invalid: InvalidReason };

export interface RecordedAIOptions {
  /** Real provider used in record and live modes; omit for replay-only use. */
  provider?: AIProvider;
  /** Recording site; defaults to the request's schema name. */
  site?: string;
  /** Independent sample index, for K separate live calls on the same request. Default 0. */
  sample?: number;
}

export interface RecordedEmbeddingOptions {
  /** Real provider used in record and live modes; omit for replay-only use. */
  provider?: EmbeddingProvider;
  /** Recording site, e.g. "embedding.query" or "embedding.corpus". Default "embedding". */
  site?: string;
  /** Vector size every result must have; a mismatch is never recorded. */
  dimensions?: number;
  /** Decimal places kept in stored vectors. */
  decimals?: number;
}

/** The output-affecting parameters of a structured request, as stored in its recording key. */
export async function structuredComponents(request: StructuredRequest<unknown>): Promise<Record<string, unknown>> {
  return {
    model: request.model,
    reasoningEffort: request.reasoningEffort ?? "default",
    verbosity: request.verbosity ?? null,
    maxOutputTokens: request.maxOutputTokens ?? null,
    schemaName: request.schemaName,
    schema: toStrictJsonSchema(request.schema),
    system: request.system,
    input: request.input,
    images: await Promise.all((request.images ?? []).map((url) => sha256(url))),
  };
}

/** The output-affecting parameters of an embedding request, as stored in its recording key. */
export function embeddingComponents(
  request: EmbeddingRequest,
  config: { dimensions: number; decimals: number },
): Record<string, unknown> {
  return { model: request.model, dimensions: config.dimensions, decimals: config.decimals, input: request.input };
}

export function recordedAIProvider(recorder: Recorder, options: RecordedAIOptions = {}): AIProvider {
  return {
    async generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
      const recording = await recorder.call<StructuredRecording>(
        {
          site: options.site ?? request.schemaName,
          sample: options.sample,
          components: await structuredComponents(request as StructuredRequest<unknown>),
        },
        async () => {
          const provider = requireProvider(options.provider, "AIProvider");
          try {
            const { output, usage } = await provider.generateStructured(request);
            return { result: { output, usage } };
          } catch (err) {
            if (err instanceof AIInvalidOutputError) {
              return { invalid: err.reason };
            }
            throw err;
          }
        },
      );
      if ("invalid" in recording) {
        throw new AIInvalidOutputError(recording.invalid);
      }
      const parsed = request.schema.safeParse(recording.result.output);
      if (!parsed.success) {
        throw new AIInvalidOutputError("schema_mismatch");
      }
      return { output: parsed.data, usage: recording.result.usage };
    },
  };
}

export function recordedEmbeddingProvider(recorder: Recorder, options: RecordedEmbeddingOptions = {}): EmbeddingProvider {
  const dimensions = options.dimensions ?? REPOSITORY_MEMORY_EMBEDDING_DIMENSIONS;
  const decimals = options.decimals ?? DEFAULT_EMBEDDING_DECIMALS;
  const scale = 10 ** decimals;
  return {
    embed(request: EmbeddingRequest): Promise<EmbeddingResult> {
      return recorder.call<EmbeddingResult>(
        {
          site: options.site ?? "embedding",
          components: embeddingComponents(request, { dimensions, decimals }),
        },
        async () => {
          const provider = requireProvider(options.provider, "EmbeddingProvider");
          const { embeddings, usage } = await provider.embed(request);
          if (embeddings.length !== request.input.length) {
            throw new AIInvalidOutputError("malformed");
          }
          assertEmbeddingDimensions(embeddings, dimensions);
          return {
            embeddings: embeddings.map((vector) => vector.map((value) => Math.round(value * scale) / scale)),
            usage: { input_tokens: usage.input_tokens },
          };
        },
      );
    },
  };
}

export interface LiveProviders {
  ai: AIProvider;
  embedding: EmbeddingProvider;
}

/**
 * The production OpenAI providers for record and live modes. Without an API key the providers still
 * construct, so replay never needs one, but any call that reaches them fails with a clear message.
 */
export function openAIProviders(
  apiKey: string | undefined,
  options: Omit<OpenAIProviderOptions, "apiKey"> = {},
): LiveProviders {
  if (!apiKey) {
    const missing = () => Promise.reject(new Error("OPENAI_API_KEY is required to record or run live model calls"));
    return { ai: { generateStructured: missing }, embedding: { embed: missing } };
  }
  return {
    ai: createOpenAIProvider({ apiKey, ...options }),
    embedding: createOpenAIEmbeddingProvider({ apiKey, ...options }),
  };
}

function requireProvider<P>(provider: P | undefined, kind: string): P {
  if (!provider) {
    throw new Error(`no live ${kind} configured; this call can only be replayed`);
  }
  return provider;
}
