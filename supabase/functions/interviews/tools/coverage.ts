import {
  type CoverageArea,
  type CoverageAreaStatus,
  type CoverageMap,
  coverageMapSchema,
  type InterviewPlan,
  interviewPlanSchema,
  type InterviewStrategy,
  interviewStrategySchema,
} from "@stackprep/shared";
import { StaleInterviewStateError } from "../../_shared/interview-state.ts";
import type { InterviewStateSnapshot, ToolStore } from "./types.ts";

const STATUS_RANK: Record<CoverageAreaStatus, number> = { not_started: 0, partial: 1, covered: 2 };

export interface ParsedState {
  coverage: CoverageMap | null;
  plan: InterviewPlan | null;
  strategy: InterviewStrategy | null;
  version: number;
}

export function parseState(snapshot: InterviewStateSnapshot | null): ParsedState | null {
  if (!snapshot) {
    return null;
  }
  const coverage = coverageMapSchema.safeParse(snapshot.coverageMap);
  const plan = interviewPlanSchema.safeParse(snapshot.plan);
  const strategy = interviewStrategySchema.safeParse(snapshot.strategy);
  return {
    coverage: coverage.success ? coverage.data : null,
    plan: plan.success ? plan.data : null,
    strategy: strategy.success ? strategy.data : null,
    version: snapshot.version,
  };
}

/** Coverage only moves forward: an area already covered is never marked partial again. */
export function raiseStatus(areas: CoverageArea[], id: string, status: CoverageAreaStatus): CoverageArea[] {
  return areas.map((area) =>
    area.id === id && STATUS_RANK[status] > STATUS_RANK[area.status] ? { ...area, status } : area
  );
}

/**
 * Applies `mutate` to the stored coverage areas with optimistic concurrency. A stale version
 * reloads the state and recomputes once; a second conflict is rethrown.
 */
export async function updateCoverage(
  store: ToolStore,
  interviewId: string,
  mutate: (areas: CoverageArea[]) => CoverageArea[],
): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const snapshot = await store.getInterviewState(interviewId);
    const coverage = coverageMapSchema.safeParse(snapshot?.coverageMap);
    if (!snapshot || !coverage.success) {
      return;
    }
    const areas = mutate(coverage.data.areas);
    if (areas.every((area, i) => area === coverage.data.areas[i])) {
      return;
    }
    try {
      await store.updateInterviewState(interviewId, snapshot.version, {
        coverageMap: { ...(snapshot.coverageMap as Record<string, unknown>), areas },
        plan: snapshot.plan as Record<string, unknown>,
        strategy: snapshot.strategy as Record<string, unknown>,
      });
      return;
    } catch (err) {
      if (!(err instanceof StaleInterviewStateError) || attempt === 1) {
        throw err;
      }
    }
  }
}
