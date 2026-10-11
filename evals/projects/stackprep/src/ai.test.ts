import { assert, assertEquals, assertNotEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { z } from "zod";
import {
  AIInvalidOutputError,
  AIUnavailableError,
  type EmbeddingRequest,
  type StructuredRequest,
} from "../../../../supabase/functions/_shared/ai/provider.ts";
import { createFakeAIProvider, createFakeEmbeddingProvider } from "../../../../supabase/functions/_shared/testing.ts";
import { hashCanonical } from "../../../core/keys.ts";
import { createFileRecorder, ReplayMissError } from "../../../core/recording.ts";
import type { EvalMode, Recorder } from "../../../core/types.ts";
import { embeddingComponents, openAIProviders, recordedAIProvider, recordedEmbeddingProvider, structuredComponents } from "./ai.ts";

const PINS = { synthetic: "c0rpus" };
const schema = z.object({ score: z.int(), note: z.string() }).strict();
const REQUEST: StructuredRequest<z.infer<typeof schema>> = {
  model: "gpt-test",
  system: "Rate the answer.",
  input: "candidate answer",
  schemaName: "answer_rating",
  schema,
  maxOutputTokens: 2000,
  reasoningEffort: "low",
  verbosity: "low",
  timeoutMs: 1000,
  retries: 1,
};

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "evals-ai-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const recorder = (dir: string, mode: EvalMode) => createFileRecorder({ dir, mode, pins: PINS });

/** A recorder that hashes what it is given, to compare keys without touching disk. */
function keyRecorder(): Recorder & { keys: string[] } {
  const keys: string[] = [];
  return {
    keys,
    async call(req, produce) {
      keys.push(await hashCanonical(req));
      return await produce();
    },
  };
}

Deno.test("structured calls record once and replay without a provider", async () => {
  await withDir(async (dir) => {
    const fake = createFakeAIProvider(() => ({ score: 3, note: "ok" }));
    const recorded = await recordedAIProvider(recorder(dir, "record"), { provider: fake }).generateStructured(REQUEST);
    assertEquals(recorded.output, { score: 3, note: "ok" });
    assertEquals(fake.calls.length, 1);

    const replay = recorder(dir, "replay");
    assertEquals(await recordedAIProvider(replay).generateStructured(REQUEST), recorded);
    assertEquals(replay.stats().replayed, 1);
  });
});

Deno.test("every output-affecting parameter changes the key; timeouts and retries do not", async () => {
  const base = await hashCanonical(await structuredComponents(REQUEST));
  const variants: Partial<StructuredRequest<unknown>>[] = [
    { model: "gpt-other" },
    { reasoningEffort: "high" },
    { verbosity: "high" },
    { maxOutputTokens: 4000 },
    { schemaName: "other_rating" },
    { schema: z.object({ score: z.int() }).strict() },
    { system: "Rate harshly." },
    { input: "another answer" },
    { images: ["data:image/png;base64,AAAA"] },
  ];
  for (const variant of variants) {
    const key = await hashCanonical(await structuredComponents({ ...REQUEST, ...variant } as StructuredRequest<unknown>));
    assertNotEquals(key, base, `changing ${Object.keys(variant)[0]} must change the key`);
  }
  const unchanged = await hashCanonical(await structuredComponents({ ...REQUEST, timeoutMs: 5, retries: 9 }));
  assertEquals(unchanged, base);
});

Deno.test("stored components hold the strict schema and image hashes, never image data", async () => {
  const image = "data:image/png;base64,AAAA";
  const components = await structuredComponents({ ...REQUEST, images: [image] } as StructuredRequest<unknown>);
  assertEquals((components.schema as { additionalProperties?: unknown }).additionalProperties, false);
  assertEquals((components.images as string[]).length, 1);
  assert(!JSON.stringify(components).includes("base64"));
});

Deno.test("sample index and site separate recordings of the same request", async () => {
  const keys = keyRecorder();
  const fake = createFakeAIProvider(() => ({ score: 1, note: "" }));
  await recordedAIProvider(keys, { provider: fake, sample: 0 }).generateStructured(REQUEST);
  await recordedAIProvider(keys, { provider: fake, sample: 1 }).generateStructured(REQUEST);
  await recordedAIProvider(keys, { provider: fake, site: "judge" }).generateStructured(REQUEST);
  assertEquals(new Set(keys.keys).size, 3);
});

Deno.test("invalid model output is recorded and replayed; unavailability is not recorded", async () => {
  await withDir(async (dir) => {
    const refusing = createFakeAIProvider(() => new AIInvalidOutputError("refusal"));
    const first = await assertRejects(
      () => recordedAIProvider(recorder(dir, "record"), { provider: refusing }).generateStructured(REQUEST),
      AIInvalidOutputError,
    );
    assertEquals(first.reason, "refusal");
    const replayed = await assertRejects(
      () => recordedAIProvider(recorder(dir, "replay")).generateStructured(REQUEST),
      AIInvalidOutputError,
    );
    assertEquals(replayed.reason, "refusal");

    const down = createFakeAIProvider(() => new AIUnavailableError(503));
    const other = { ...REQUEST, input: "different" };
    await assertRejects(() => recordedAIProvider(recorder(dir, "record"), { provider: down }).generateStructured(other), AIUnavailableError);
    await assertRejects(() => recordedAIProvider(recorder(dir, "replay")).generateStructured(other), ReplayMissError);
  });
});

Deno.test("a replay miss names the differing request component", async () => {
  await withDir(async (dir) => {
    const fake = createFakeAIProvider(() => ({ score: 2, note: "" }));
    await recordedAIProvider(recorder(dir, "record"), { provider: fake }).generateStructured(REQUEST);
    const err = await assertRejects(
      () => recordedAIProvider(recorder(dir, "replay")).generateStructured({ ...REQUEST, system: "changed" }),
      ReplayMissError,
    );
    assertStringIncludes(err.message, "components.system");
  });
});

Deno.test("a recording that no longer fits the schema surfaces as schema_mismatch", async () => {
  const stale: Recorder = { call: <T>() => Promise.resolve({ result: { output: { score: "x" }, usage: {} } } as T) };
  const err = await assertRejects(() => recordedAIProvider(stale).generateStructured(REQUEST), AIInvalidOutputError);
  assertEquals(err.reason, "schema_mismatch");
});

Deno.test("embeddings are rounded, recorded per call and replayed; the signal is not part of the key", async () => {
  await withDir(async (dir) => {
    const fake = createFakeEmbeddingProvider((r) => r.input.map(() => [0.1234567, -0.9876543, 0, 1]));
    const options = { provider: fake, dimensions: 4, decimals: 3, site: "embedding.query" };
    const request = { model: "embed-test", input: ["find the retry helper"] };
    const recorded = await recordedEmbeddingProvider(recorder(dir, "record"), options).embed(request);
    assertEquals(recorded.embeddings, [[0.123, -0.988, 0, 1]]);
    assertEquals(recorded.usage, { input_tokens: 7 });

    const replayed = await recordedEmbeddingProvider(recorder(dir, "replay"), { dimensions: 4, decimals: 3, site: "embedding.query" })
      .embed({ ...request, signal: AbortSignal.timeout(1000) });
    assertEquals(replayed, recorded);
    assertEquals(fake.calls.length, 1);
  });
});

Deno.test("embedding model, dimensions, precision and input change the key", async () => {
  const request = { model: "embed-test", input: ["a"] };
  const config = { dimensions: 4, decimals: 3 };
  const base = await hashCanonical(embeddingComponents(request, config));
  const variants: Array<[EmbeddingRequest, typeof config]> = [
    [{ ...request, model: "embed-other" }, config],
    [{ ...request, input: ["b"] }, config],
    [request, { ...config, dimensions: 8 }],
    [request, { ...config, decimals: 4 }],
  ];
  for (const [req, cfg] of variants) {
    assertNotEquals(await hashCanonical(embeddingComponents(req, cfg)), base);
  }
});

Deno.test("wrong-sized vectors are rejected and never recorded", async () => {
  await withDir(async (dir) => {
    const fake = createFakeEmbeddingProvider((r) => r.input.map(() => [0.1, 0.2]));
    const err = await assertRejects(
      () => recordedEmbeddingProvider(recorder(dir, "record"), { provider: fake, dimensions: 4 }).embed({ model: "m", input: ["a"] }),
      AIInvalidOutputError,
    );
    assertEquals(err.reason, "dimension_mismatch");
    await assertRejects(
      () => recordedEmbeddingProvider(recorder(dir, "replay"), { dimensions: 4 }).embed({ model: "m", input: ["a"] }),
      ReplayMissError,
    );
  });
});

Deno.test("without an API key live providers fail only when called", async () => {
  const { ai, embedding } = openAIProviders(undefined);
  await assertRejects(() => ai.generateStructured(REQUEST), Error, "OPENAI_API_KEY");
  await assertRejects(() => embedding.embed({ model: "m", input: ["a"] }), Error, "OPENAI_API_KEY");
});
