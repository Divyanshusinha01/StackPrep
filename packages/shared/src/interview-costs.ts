import { z } from "zod";

// GET /workspaces/:id/costs -----------------------------------------------------------
// Estimated AI spend per interview, from `ai_usage_effective`. It is an estimate from the price
// table and never the user's actual OpenAI bill (architecture "Usage tracking").

export const interviewCostSchema = z.object({
  interview_id: z.uuid(),
  interview_number: z.int().min(1),
  /** Sum of the priced calls, in USD. */
  cost_usd: z.number().min(0),
  voice_cost_usd: z.number().min(0),
  text_cost_usd: z.number().min(0),
  /** True when any part of the total comes from connected-time estimates, not reported usage. */
  has_estimate: z.boolean(),
  /** Calls whose model has no price; their cost is missing from the total, not zero. */
  unpriced_calls: z.int().min(0),
});

export const interviewCostsResponseSchema = z.object({
  interviews: z.array(interviewCostSchema),
});

/** Raw `workspace_interview_costs` row; numerics and bigints arrive as numbers or strings. */
export const interviewCostRowSchema = z.object({
  interview_id: z.uuid(),
  interview_number: z.int().min(1),
  cost_usd: z.coerce.number().min(0),
  voice_cost_usd: z.coerce.number().min(0),
  text_cost_usd: z.coerce.number().min(0),
  has_estimate: z.boolean(),
  unpriced_calls: z.coerce.number().int().min(0),
});

export type InterviewCost = z.infer<typeof interviewCostSchema>;
export type InterviewCostsResponse = z.infer<typeof interviewCostsResponseSchema>;

/** "$0.42", or "<$0.01" for a positive amount that would round to zero. */
export function formatInterviewCost(usd: number): string {
  if (usd > 0 && usd < 0.005) {
    return "<$0.01";
  }
  return `$${usd.toFixed(2)}`;
}
