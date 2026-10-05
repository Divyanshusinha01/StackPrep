import {
  type EndInterviewInput,
  type EvaluateAnswerInput,
  type GetFileInput,
  REALTIME_TOOLS,
  type RealtimeToolName,
  realtimeToolNameSchema,
  type SearchRepositoryInput,
  type ToolErrorCode,
} from "@stackprep/shared";
import { advanceInterview } from "./advance-interview.ts";
import { endInterview } from "./end-interview.ts";
import { evaluateAnswer } from "./evaluate-answer.ts";
import { getFile } from "./get-file.ts";
import { searchRepository } from "./search-repository.ts";
import type { ToolContext, ToolOutcome } from "./types.ts";

export const READ_TOOLS: readonly RealtimeToolName[] = ["search_repository", "get_file"];

export type ParsedToolCall =
  | { ok: true; tool: RealtimeToolName; args: Record<string, unknown> }
  | { ok: false; code: ToolErrorCode };

/** Validates the tool name and its arguments; `args` has the tool schema's defaults applied. */
export function parseToolCall(name: string, rawArguments: string | Record<string, unknown>): ParsedToolCall {
  const tool = realtimeToolNameSchema.safeParse(name);
  if (!tool.success) {
    return { ok: false, code: "unknown_tool" };
  }
  let raw: unknown = rawArguments;
  if (typeof rawArguments === "string") {
    try {
      raw = rawArguments.trim() === "" ? {} : JSON.parse(rawArguments);
    } catch {
      return { ok: false, code: "invalid_arguments" };
    }
  }
  const args = REALTIME_TOOLS[tool.data].input.safeParse(raw);
  if (!args.success) {
    return { ok: false, code: "invalid_arguments" };
  }
  return { ok: true, tool: tool.data, args: args.data as Record<string, unknown> };
}

export function runTool(tool: RealtimeToolName, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
  switch (tool) {
    case "search_repository":
      return searchRepository(ctx, args as SearchRepositoryInput);
    case "get_file":
      return getFile(ctx, args as GetFileInput);
    case "evaluate_answer":
      return evaluateAnswer(ctx, args as EvaluateAnswerInput);
    case "advance_interview":
      return advanceInterview(ctx);
    case "end_interview":
      return endInterview(ctx, args as EndInterviewInput);
  }
}
