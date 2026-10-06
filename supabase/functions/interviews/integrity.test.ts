import { assert, assertEquals, assertInstanceOf, assertRejects } from "@std/assert";
import { type AIUsage, AIUnavailableError } from "../_shared/ai/provider.ts";
import { createFakeAIProvider } from "../_shared/testing.ts";
import { analyzeFrame, INTEGRITY_SYSTEM_PROMPT, INTEGRITY_WARNING_MESSAGES } from "./integrity.ts";

const IMAGE = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";

function context(respond: () => unknown) {
  const ai = createFakeAIProvider(respond);
  const logs: Record<string, string | number | boolean>[] = [];
  const usage: AIUsage[] = [];
  const ctx = {
    ai,
    model: "gpt-vision",
    log: (entry: Record<string, string | number | boolean>) => logs.push(entry),
    recordUsage: (u: AIUsage) => Promise.resolve(usage.push(u)),
  };
  return { ai, logs, usage, ctx };
}

Deno.test("sends the frame as an image with a fixed prompt and logs usage only", async () => {
  const { ai, logs, usage, ctx } = context(() => ({ signal: true, kind: "looking_away" }));
  assertEquals(await analyzeFrame(ctx, IMAGE), "looking_away");
  assertEquals(ai.calls.length, 1);
  const [call] = ai.calls;
  assertEquals(call.model, "gpt-vision");
  assertEquals(call.system, INTEGRITY_SYSTEM_PROMPT);
  assertEquals(call.images, [IMAGE]);
  assert(!call.input.includes("base64"), "the frame is never part of the text input");
  assertEquals(logs, [{ event: "integrity_ai_usage", model: "gpt-vision", input_tokens: 100, cached_input_tokens: 0, output_tokens: 50 }]);
  assert(!JSON.stringify(logs).includes("base64"));
  assertEquals(usage, [{ input_tokens: 100, cached_input_tokens: 0, output_tokens: 50 }]);
});

Deno.test("a failed call records no usage", async () => {
  const { usage, ctx } = context(() => new AIUnavailableError(503));
  await assertRejects(() => analyzeFrame(ctx, IMAGE));
  assertEquals(usage, []);
});

Deno.test("no signal, or an inconsistent kind, means no signal", async () => {
  assertEquals(await analyzeFrame(context(() => ({ signal: false, kind: "none" })).ctx, IMAGE), null);
  assertEquals(await analyzeFrame(context(() => ({ signal: true, kind: "none" })).ctx, IMAGE), null);
  assertEquals(await analyzeFrame(context(() => ({ signal: false, kind: "other_person" })).ctx, IMAGE), null);
});

Deno.test("provider failures propagate to the caller", async () => {
  const { ctx } = context(() => new AIUnavailableError(503));
  assertInstanceOf(await assertRejects(() => analyzeFrame(ctx, IMAGE)), AIUnavailableError);
});

Deno.test("every signal kind has PRD-style warning copy", () => {
  assertEquals(INTEGRITY_WARNING_MESSAGES.looking_away, "We detected that you may be looking away from the screen. Please remain focused.");
  for (const message of Object.values(INTEGRITY_WARNING_MESSAGES)) {
    assert(message.length > 0 && message.length <= 300);
  }
});
