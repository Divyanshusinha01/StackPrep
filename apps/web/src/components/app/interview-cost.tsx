import { Coins } from "lucide-react";
import { formatInterviewCost, type InterviewCost } from "@stackprep/shared";

/** Whether there is anything worth showing: some priced spend, or calls whose price is unknown. */
export function hasInterviewCost(cost: InterviewCost | undefined): cost is InterviewCost {
  return cost !== undefined && (cost.cost_usd > 0 || cost.unpriced_calls > 0);
}

function detail(cost: InterviewCost): string {
  const parts = [
    `Estimated from token usage: voice ${formatInterviewCost(cost.voice_cost_usd)}, text ${formatInterviewCost(cost.text_cost_usd)}.`,
  ];
  if (cost.has_estimate) {
    parts.push("Part of the voice cost is estimated from connected time.");
  }
  if (cost.unpriced_calls > 0) {
    parts.push(`${cost.unpriced_calls} call${cost.unpriced_calls === 1 ? "" : "s"} used a model without a known price and ${cost.unpriced_calls === 1 ? "is" : "are"} not included.`);
  }
  parts.push("Your OpenAI bill is the source of truth.");
  return parts.join(" ");
}

/** Estimated OpenAI spend of one interview, billed to the user's own key. */
export function InterviewCostLabel({ cost }: { cost: InterviewCost }) {
  return (
    <span
      className="inline-flex items-center gap-1 font-mono text-[11px] text-muted-foreground tabular-nums"
      title={detail(cost)}
    >
      <Coins className="size-3" aria-hidden />
      <span aria-hidden>
        Est. {formatInterviewCost(cost.cost_usd)}
        {cost.unpriced_calls > 0 ? "+" : ""}
      </span>
      <span className="sr-only">
        Estimated OpenAI cost {formatInterviewCost(cost.cost_usd)}
        {cost.unpriced_calls > 0 ? " or more" : ""}. {detail(cost)}
      </span>
    </span>
  );
}
