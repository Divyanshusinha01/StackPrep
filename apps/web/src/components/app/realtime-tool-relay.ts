import type { ToolError } from "@stackprep/shared";
import type { RealtimeServerEvent } from "./realtime-transcript";

export interface RealtimeClientEvent {
  type: string;
  [key: string]: unknown;
}

/**
 * Answers a Realtime tool call. Until `POST /interviews/:id/tool-calls` exists every call gets
 * `unknown_tool`, and the interviewer carries on with its own judgment.
 */
export function relayToolCall(event: RealtimeServerEvent): RealtimeClientEvent[] {
  if (event.type !== "response.function_call_arguments.done" || typeof event.call_id !== "string") {
    return [];
  }
  const result: ToolError = { ok: false, error: { code: "unknown_tool" } };
  return [
    {
      type: "conversation.item.create",
      item: { type: "function_call_output", call_id: event.call_id, output: JSON.stringify(result) },
    },
    { type: "response.create" },
  ];
}
