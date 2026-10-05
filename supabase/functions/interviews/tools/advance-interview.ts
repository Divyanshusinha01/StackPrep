import type { AdvanceInterviewOutput, CoverageArea, InterviewStrategy } from "@stackprep/shared";
import { parseState, raiseStatus, updateCoverage } from "./coverage.ts";
import { failed, type ToolContext, type ToolOutcome } from "./types.ts";

const PRIORITY_RANK: Record<CoverageArea["priority"], number> = { high: 0, medium: 1, low: 2 };

const DEPTH: Record<InterviewStrategy["difficulty"], AdvanceInterviewOutput["depth"]> = {
  foundational: "foundational",
  intermediate: "standard",
  advanced: "deep",
};

const WRAP_UP_FOCUS = {
  area: "wrap-up",
  category: "closing",
  angle: "The planned topics are done. Briefly revisit an earlier answer if useful, then end the interview.",
};

/** Strategy focus areas first, then priority, then untouched before partially covered, then plan order. */
export function pickNextArea(
  areas: CoverageArea[],
  strategy: InterviewStrategy | null,
  currentId: string | null,
): CoverageArea | null {
  const focus = strategy?.focus_area_ids ?? [];
  const focusRank = (id: string) => (focus.includes(id) ? focus.indexOf(id) : focus.length);
  const ranked = areas
    .map((area, index) => ({ area, index }))
    .filter(({ area }) => area.id !== currentId && area.status !== "covered")
    .sort((a, b) =>
      focusRank(a.area.id) - focusRank(b.area.id) ||
      PRIORITY_RANK[a.area.priority] - PRIORITY_RANK[b.area.priority] ||
      Number(a.area.status === "partial") - Number(b.area.status === "partial") ||
      a.index - b.index
    );
  return ranked[0]?.area ?? null;
}

function pickAngle(area: CoverageArea, strategy: InterviewStrategy | null): string {
  const avoid = new Set((strategy?.avoid_repeating ?? []).map((t) => t.toLowerCase()));
  return area.topics.find((t) => !avoid.has(t.toLowerCase())) ?? area.topics[0];
}

export async function advanceInterview(ctx: ToolContext): Promise<ToolOutcome> {
  const { interview, store } = ctx;
  const [snapshot, lastArea, evaluated] = await Promise.all([
    store.getInterviewState(interview.id),
    store.lastAdvancedArea(interview.id),
    store.listEvaluationCategories(interview.id),
  ]);
  const state = parseState(snapshot);
  if (!state?.coverage) {
    ctx.log({ event: "advance_interview_failed", reason: "no_coverage_map" });
    return failed("internal", false);
  }
  const areas = state.coverage.areas;
  const current = lastArea ?? state.plan?.phases[0]?.coverage_area_ids[0] ?? null;
  const currentStatus = current && evaluated.includes(current) ? "covered" : "partial";
  const next = pickNextArea(areas, state.strategy, current);

  const output: AdvanceInterviewOutput = {
    ok: true,
    nextFocus: next
      ? { area: next.repo_evidence[0] ?? next.name, category: next.name, angle: pickAngle(next, state.strategy) }
      : WRAP_UP_FOCUS,
    depth: DEPTH[state.strategy?.difficulty ?? "intermediate"],
    elapsedMinutes: Math.floor(ctx.elapsedSeconds / 60),
  };

  return {
    output,
    // area_id is what the next advance_interview treats as the current area.
    summary: { ok: true, area_id: next?.id ?? current, previous_area_id: current },
    persist: true,
    afterRecord: () =>
      updateCoverage(store, interview.id, (all) => {
        let updated = current ? raiseStatus(all, current, currentStatus) : all;
        if (next) {
          updated = raiseStatus(updated, next.id, "partial");
        }
        return updated;
      }),
  };
}
