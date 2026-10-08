import type { InterviewEventRequest } from "@stackprep/shared";
import { describe, expect, it, vi } from "vitest";
import { endErrorMessage, endInterviewInOrder } from "./end-interview";
import { createTranscriptOutbox } from "./transcript-outbox";

const completed = { ok: true as const, body: { status: "completed" as const, report: true as const } };

describe("endInterviewInOrder", () => {
  it("closes the voice session, then flushes, then asks the backend to end", async () => {
    const calls: string[] = [];
    const result = await endInterviewInOrder({
      closeVoice: () => calls.push("close"),
      flushOutbox: async () => {
        await Promise.resolve();
        calls.push("flush");
      },
      requestEnd: async () => {
        calls.push("end");
        return completed;
      },
    });
    expect(calls).toEqual(["close", "flush", "end"]);
    expect(result).toEqual(completed);
  });

  it("still ends the interview when the flush fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const requestEnd = vi.fn(async () => completed);
    await endInterviewInOrder({
      closeVoice: () => {},
      flushOutbox: () => Promise.reject(new Error("offline")),
      requestEnd,
    });
    expect(requestEnd).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("returns a refusal unchanged", async () => {
    const refused = { ok: false as const, code: "interview_not_active" };
    expect(await endInterviewInOrder({ closeVoice: () => {}, flushOutbox: async () => {}, requestEnd: async () => refused }))
      .toEqual(refused);
  });

  it("sends buffered turns and the final disconnect before the end request", async () => {
    const log: string[] = [];
    let sequence = 0;
    const outbox = createTranscriptOutbox({
      storageKey: "stackprep:interview-outbox:end-test",
      send: async (item: InterviewEventRequest) => {
        log.push(item.type);
        sequence++;
        return {
          ok: true,
          ack: item.type === "transcript_turn"
            ? { type: item.type, status: "created", client_event_id: item.client_event_id, turn_sequence: sequence }
            : { type: item.type, status: "created", client_event_id: item.client_event_id, event_sequence: sequence },
        };
      },
    });
    outbox.enqueue({ type: "transcript_turn", role: "user", content: "We cache at the edge.", item_id: "item_1" });

    await endInterviewInOrder({
      closeVoice: () => outbox.enqueue({ type: "disconnected" }),
      flushOutbox: () => outbox.flush(),
      requestEnd: async () => {
        log.push("end");
        return completed;
      },
    });
    outbox.dispose();
    expect(log).toEqual(["transcript_turn", "disconnected", "end"]);
  });
});

describe("endErrorMessage", () => {
  it("explains an ended interview and falls back to a retry hint", () => {
    expect(endErrorMessage("interview_not_active")).toBe("This interview is no longer active.");
    expect(endErrorMessage("network_error")).toBe("The interview could not be ended. Try again.");
  });
});
