import { describe, expect, it, vi } from "vitest";
import { relayToolCall, toolCallFromEvent } from "./realtime-tool-relay";

const done = (name: string, args: unknown, callId = "call_1") => ({
  type: "response.function_call_arguments.done",
  item_id: "item_1",
  call_id: callId,
  name,
  arguments: JSON.stringify(args),
});

function outputOf(relay: Awaited<ReturnType<typeof relayToolCall>>) {
  const item = relay?.events[0].item as { type: string; call_id: string; output: string };
  return { ...item, output: JSON.parse(item.output) };
}

describe("toolCallFromEvent", () => {
  it("extracts the call and ignores everything else", () => {
    expect(toolCallFromEvent(done("get_file", { path: "a" }))).toEqual({
      call_id: "call_1",
      name: "get_file",
      arguments: '{"path":"a"}',
    });
    expect(toolCallFromEvent({ type: "response.done" })).toBeNull();
    expect(toolCallFromEvent({ type: "response.function_call_arguments.done", name: "get_file", arguments: "{}" })).toBeNull();
    expect(toolCallFromEvent({ type: "response.function_call_arguments.done", call_id: "c", arguments: "{}" })).toBeNull();
  });
});

describe("relayToolCall", () => {
  it("forwards the call unchanged and returns the backend result unchanged", async () => {
    const result = { ok: true, guidance: "follow_up", focus: "token rotation" };
    const send = vi.fn().mockResolvedValue(result);
    const relay = await relayToolCall(done("evaluate_answer", { answerSummary: "JWTs" }), send);
    expect(send).toHaveBeenCalledWith({ call_id: "call_1", name: "evaluate_answer", arguments: '{"answerSummary":"JWTs"}' });
    expect(relay?.events).toEqual([
      { type: "conversation.item.create", item: { type: "function_call_output", call_id: "call_1", output: JSON.stringify(result) } },
      { type: "response.create" },
    ]);
    expect(relay).toMatchObject({ ending: false, examined: [] });
  });

  it.each([
    ["a network failure", () => Promise.reject(new TypeError("offline"))],
    ["an HTTP failure", () => Promise.resolve(null)],
    ["a malformed body", () => Promise.resolve({ error: "Unauthorized", code: "unauthorized" })],
  ])("sends an internal tool error on %s so the conversation continues", async (_label, send) => {
    const relay = await relayToolCall(done("get_file", { path: "src/a.ts" }), send);
    expect(outputOf(relay)).toEqual({ type: "function_call_output", call_id: "call_1", output: { ok: false, error: { code: "internal" } } });
    expect(relay?.events[1]).toEqual({ type: "response.create" });
    expect(relay).toMatchObject({ ending: false, examined: [] });
  });

  it("does nothing for non-tool events", async () => {
    const send = vi.fn();
    expect(await relayToolCall({ type: "response.output_audio_transcript.delta", delta: "hi" }, send)).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  it("flags the end of the interview on an accepted end_interview or interview_not_active", async () => {
    const accepted = await relayToolCall(done("end_interview", { reason: "time_target" }), () =>
      Promise.resolve({ ok: true, accepted: true, guidance: "Close." }));
    expect(accepted?.ending).toBe(true);
    const declined = await relayToolCall(done("end_interview", { reason: "time_target" }), () =>
      Promise.resolve({ ok: true, accepted: false, guidance: "Continue." }));
    expect(declined?.ending).toBe(false);
    const timeUp = await relayToolCall(done("get_file", { path: "a" }), () =>
      Promise.resolve({ ok: false, error: { code: "interview_not_active" }, guidance: "Close now." }));
    expect(timeUp?.ending).toBe(true);
    expect(outputOf(timeUp).output.guidance).toBe("Close now.");
  });

  it("reports examined paths from get_file and search results, never content", async () => {
    const file = await relayToolCall(done("get_file", { path: "./src/auth/jwt.ts" }), () =>
      Promise.resolve({ ok: true, path: "src/auth/jwt.ts", startLine: 1, endLine: 2, totalLines: 2, content: "secret code", truncated: false }));
    expect(file?.examined).toEqual([{ path: "src/auth/jwt.ts" }]);

    const search = await relayToolCall(done("search_repository", { query: "auth" }), () =>
      Promise.resolve({
        ok: true,
        results: [
          { path: "src/auth/jwt.ts", area: "src", excerpt: "x" },
          { path: ".", area: "architecture_summary", excerpt: "y" },
          { path: "config/auth.ts", excerpt: "z" },
        ],
      }));
    expect(search?.examined).toEqual([{ path: "src/auth/jwt.ts", area: "src" }, { path: "config/auth.ts" }]);

    const failed = await relayToolCall(done("get_file", { path: ".env" }), () =>
      Promise.resolve({ ok: false, error: { code: "excluded" } }));
    expect(failed?.examined).toEqual([]);
  });
});
