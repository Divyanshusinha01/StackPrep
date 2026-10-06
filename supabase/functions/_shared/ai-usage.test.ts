import { assertAlmostEquals, assertEquals } from "@std/assert";
import type { SupabaseClient } from "@supabase/supabase-js";
import { type AiUsageEntry, aiUsageRow, recordAiUsage } from "./ai-usage.ts";

const base: AiUsageEntry = {
  userId: "u1",
  workspaceId: "w1",
  interviewId: "i1",
  task: "evaluation",
  model: "gpt-5.6-terra",
  source: "provider",
  tokens: { input_tokens: 1_000, cached_input_tokens: 400, output_tokens: 100 },
  idempotencyKey: "evaluation:i1:1",
};

/** Records the upsert call and answers like PostgREST. */
function fakeDb(result: { data: unknown[] | null; error: { message: string } | null } | Error) {
  const calls: { row: Record<string, unknown>; options: unknown }[] = [];
  const db = {
    from(table: string) {
      assertEquals(table, "ai_usage");
      return {
        upsert(row: Record<string, unknown>, options: unknown) {
          calls.push({ row, options });
          return {
            select: () => (result instanceof Error ? Promise.reject(result) : Promise.resolve(result)),
          };
        },
      };
    },
  } as unknown as SupabaseClient;
  return { db, calls };
}

Deno.test("aiUsageRow prices provider tokens with cached input subtracted", () => {
  const row = aiUsageRow(base);
  assertEquals(row.input_tokens, 1_000);
  assertEquals(row.cached_input_tokens, 400);
  assertEquals(row.audio_seconds, null);
  // 600 * 2.00 + 400 * 0.20 + 100 * 12.00, per 1M tokens
  assertAlmostEquals(row.estimated_cost_usd!, 0.00248, 1e-12);
});

Deno.test("aiUsageRow uses the per-minute rate for a duration-only transcription estimate", () => {
  const row = aiUsageRow({
    ...base,
    task: "voice",
    source: "duration_estimate",
    model: "gpt-4o-mini-transcribe",
    tokens: undefined,
    audioSeconds: 120,
    voiceSegmentEventId: "e1",
  });
  assertEquals(row.audio_input_tokens, 0);
  assertEquals(row.voice_segment_event_id, "e1");
  assertAlmostEquals(row.estimated_cost_usd!, 0.006, 1e-12);
});

Deno.test("aiUsageRow keeps the row with a null cost for an unknown model", () => {
  assertEquals(aiUsageRow({ ...base, model: "gpt-unknown" }).estimated_cost_usd, null);
});

Deno.test("recordAiUsage ignores duplicate keys and reports what happened", async () => {
  const created = fakeDb({ data: [{ id: "r1" }], error: null });
  assertEquals(await recordAiUsage(created.db, base), "created");
  assertEquals(created.calls[0].options, { onConflict: "idempotency_key", ignoreDuplicates: true });
  assertEquals(created.calls[0].row.idempotency_key, "evaluation:i1:1");

  assertEquals(await recordAiUsage(fakeDb({ data: [], error: null }).db, base), "duplicate");
});

Deno.test("recordAiUsage logs and swallows failures", async () => {
  const lines: string[] = [];
  const original = console.error;
  console.error = (line: string) => lines.push(line);
  try {
    assertEquals(await recordAiUsage(fakeDb({ data: null, error: { message: "boom" } }).db, base), "failed");
    assertEquals(await recordAiUsage(fakeDb(new Error("network")).db, base), "failed");
  } finally {
    console.error = original;
  }
  assertEquals(lines.length, 2);
  assertEquals(JSON.parse(lines[0]).event, "ai_usage_record_failed");
});
