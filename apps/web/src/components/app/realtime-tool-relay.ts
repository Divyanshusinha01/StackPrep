import { type ToolCallRequest, type ToolCallResponse, toolCallResponseSchema, type ToolError } from "@stackprep/shared";
import type { ExaminedItem } from "./examining";
import type { RealtimeServerEvent } from "./realtime-transcript";

export interface RealtimeClientEvent {
  type: string;
  [key: string]: unknown;
}

/** Sends the call to the backend and resolves to its unparsed result body, or null on failure. */
export type ToolCallSender = (call: ToolCallRequest) => Promise<unknown>;

export interface ToolCallRelay {
  /** Events to send back over the data channel, in order. */
  events: RealtimeClientEvent[];
  /** The interview is over; the interviewer should give its closing turn, then the call ends. */
  ending: boolean;
  /** Files or modules the tool looked at, for the "Examining …" indicator. Never content. */
  examined: ExaminedItem[];
}

const INTERNAL_ERROR: ToolError = { ok: false, error: { code: "internal" } };

/** The function call in a `response.function_call_arguments.done` event, or null for anything else. */
export function toolCallFromEvent(event: RealtimeServerEvent): ToolCallRequest | null {
  if (
    event.type !== "response.function_call_arguments.done" ||
    typeof event.call_id !== "string" ||
    typeof event.name !== "string" ||
    typeof event.arguments !== "string"
  ) {
    return null;
  }
  return { call_id: event.call_id, name: event.name, arguments: event.arguments };
}

function argumentPath(args: string): string | null {
  try {
    const path = (JSON.parse(args) as { path?: unknown } | null)?.path;
    return typeof path === "string" && path.length > 0 ? path : null;
  } catch {
    return null;
  }
}

function examinedBy(call: ToolCallRequest, result: ToolCallResponse): ExaminedItem[] {
  if (!result.ok) {
    return [];
  }
  if (call.name === "get_file" && typeof call.arguments === "string") {
    const path = "path" in result ? result.path : argumentPath(call.arguments);
    return path ? [{ path }] : [];
  }
  if (call.name === "search_repository" && "results" in result) {
    return result.results
      .filter((r) => r.path !== ".")
      .map((r) => (r.area ? { path: r.path, area: r.area } : { path: r.path }));
  }
  return [];
}

function isEnding(call: ToolCallRequest, result: ToolCallResponse): boolean {
  if (!result.ok) {
    return result.error.code === "interview_not_active";
  }
  return call.name === "end_interview" && "accepted" in result && result.accepted;
}

/**
 * Answers a Realtime tool call by relaying it to `POST /interviews/:id/tool-calls`. The backend's
 * result goes back to Realtime unchanged; a failed or malformed response becomes an `internal` tool
 * error so the conversation never stalls waiting for an output.
 */
export async function relayToolCall(event: RealtimeServerEvent, send: ToolCallSender): Promise<ToolCallRelay | null> {
  const call = toolCallFromEvent(event);
  if (!call) {
    return null;
  }
  let body: unknown = null;
  try {
    body = await send(call);
  } catch {
    body = null;
  }
  const parsed = toolCallResponseSchema.safeParse(body);
  const result: ToolCallResponse = parsed.success ? parsed.data : INTERNAL_ERROR;
  const output = parsed.success ? body : INTERNAL_ERROR;
  return {
    events: [
      {
        type: "conversation.item.create",
        item: { type: "function_call_output", call_id: call.call_id, output: JSON.stringify(output) },
      },
      { type: "response.create" },
    ],
    ending: isEnding(call, result),
    examined: examinedBy(call, result),
  };
}
