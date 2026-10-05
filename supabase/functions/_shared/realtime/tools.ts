import { REALTIME_TOOLS, type RealtimeToolName } from "@stackprep/shared";
import { z } from "zod";

export interface RealtimeFunctionTool {
  type: "function";
  name: RealtimeToolName;
  description: string;
  parameters: Record<string, unknown>;
}

/** Realtime session tool declarations, generated from the shared Zod input schemas. */
export function buildRealtimeTools(): RealtimeFunctionTool[] {
  return (Object.entries(REALTIME_TOOLS) as [RealtimeToolName, (typeof REALTIME_TOOLS)[RealtimeToolName]][]).map(
    ([name, { description, input }]) => {
      const { $schema: _, ...parameters } = z.toJSONSchema(input, { io: "input" }) as Record<string, unknown>;
      return { type: "function", name, description, parameters };
    },
  );
}
