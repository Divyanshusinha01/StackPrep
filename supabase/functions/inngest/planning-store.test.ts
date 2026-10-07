import { assert, assertEquals } from "@std/assert";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createPlanningStore, MAX_PRIOR_ITEM_CHARS, PRIOR_OUTCOME_STATUSES } from "./planning-store.ts";

const WORKSPACE = "22222222-0000-4000-8000-000000000002";
const CURRENT = "11111111-0000-4000-8000-000000000003";
const FIRST = "11111111-0000-4000-8000-000000000001";
const SECOND = "11111111-0000-4000-8000-000000000002";
const ANSWER = "ANSWER-SENTINEL: I used a mutex because the queue was shared";

interface Query {
  table: string;
  ops: [string, ...unknown[]][];
}

/** Records every chained call and resolves each query with the rows given for its table. */
function recordingClient(rows: Record<string, unknown[]>) {
  const queries: Query[] = [];
  const client = {
    from(table: string) {
      const query: Query = { table, ops: [] };
      queries.push(query);
      const builder: Record<string, unknown> = {
        then(resolve: (value: unknown) => unknown, reject?: (err: unknown) => unknown) {
          return Promise.resolve({ data: rows[table] ?? [], error: null }).then(resolve, reject);
        },
      };
      for (const op of ["select", "eq", "neq", "in", "not", "order", "limit"]) {
        builder[op] = (...args: unknown[]) => {
          query.ops.push([op, ...args]);
          return builder;
        };
      }
      return builder;
    },
  };
  return { client: client as unknown as SupabaseClient, queries };
}

const coverageArea = (id: string, status: string) => ({
  id,
  name: id,
  priority: "high",
  rationale: "Central to the repository",
  topics: ["Tokens"],
  repo_evidence: ["src/auth.ts"],
  status,
});
const coverageMap = (status: string) => ({
  areas: [coverageArea("auth", status), coverageArea("backend", "not_started"), coverageArea("testing", "not_started")],
});

function fixture() {
  return recordingClient({
    interviews: [
      { id: SECOND, interview_number: 2, status: "terminated", state: [{ coverage_map: coverageMap("partial") }] },
      { id: FIRST, interview_number: 1, status: "completed", state: { coverage_map: coverageMap("covered") } },
    ],
    evaluations: [
      {
        interview_id: FIRST,
        category: "security",
        rating: "developing",
        strengths: ["Explained token expiry"],
        gaps: ["Token rotation", "x".repeat(5_000)],
        answer: ANSWER,
        content: ANSWER,
      },
      { interview_id: SECOND, category: "backend", rating: null, strengths: [7, "Clear request tracing"], gaps: [] },
    ],
    interview_messages: [{ interview_id: FIRST, role: "user", content: ANSWER }],
  });
}

Deno.test("prior outcomes come only from completed and terminated interviews other than the current one", async () => {
  const { client, queries } = fixture();
  await createPlanningStore(client).loadPriorOutcomes(WORKSPACE, CURRENT);

  const interviews = queries.find((q) => q.table === "interviews")!;
  assert(interviews.ops.some(([op, col, v]) => op === "eq" && col === "workspace_id" && v === WORKSPACE));
  assert(interviews.ops.some(([op, col, v]) => op === "neq" && col === "id" && v === CURRENT));
  const statusFilter = interviews.ops.find(([op, col]) => op === "in" && col === "status");
  assertEquals(statusFilter?.[2], ["completed", "terminated"]);
  assertEquals(PRIOR_OUTCOME_STATUSES, ["completed", "terminated"]);
});

Deno.test("prior outcomes never read the transcript or evaluation fields beyond the allowlist", async () => {
  const { client, queries } = fixture();
  await createPlanningStore(client).loadPriorOutcomes(WORKSPACE, CURRENT);

  assertEquals(queries.map((q) => q.table).sort(), ["evaluations", "interviews"]);
  const select = queries.find((q) => q.table === "evaluations")!.ops.find(([op]) => op === "select")?.[1];
  assertEquals(select, "interview_id, category, rating, strengths, gaps");
  assert(String(queries.find((q) => q.table === "interviews")!.ops.find(([op]) => op === "select")?.[1])
    .includes("interview_state(coverage_map)"));
});

Deno.test("prior outcomes are an allowlisted shape: answer text in stray fields never comes through", async () => {
  const { client } = fixture();
  const prior = await createPlanningStore(client).loadPriorOutcomes(WORKSPACE, CURRENT);

  assert(!JSON.stringify(prior).includes("ANSWER-SENTINEL"));
  assertEquals(prior.map((p) => Object.keys(p).sort()), [
    ["categories", "coverage", "interview_number", "status"],
    ["categories", "coverage", "interview_number", "status"],
  ]);
  assertEquals(prior[0], {
    interview_number: 2,
    status: "terminated",
    coverage: [
      { id: "auth", name: "auth", status: "partial" },
      { id: "backend", name: "backend", status: "not_started" },
      { id: "testing", name: "testing", status: "not_started" },
    ],
    categories: [{ category: "backend", ratings: [], strengths: ["Clear request tracing"], gaps: [] }],
  });
  const security = prior[1].categories[0];
  assertEquals(Object.keys(security).sort(), ["category", "gaps", "ratings", "strengths"]);
  assertEquals(security.gaps[0], "Token rotation");
  assertEquals(security.gaps[1].length, MAX_PRIOR_ITEM_CHARS, "long evaluator text is truncated");
});

Deno.test("no earlier finished interviews means no evaluation query", async () => {
  const { client, queries } = recordingClient({ interviews: [] });
  assertEquals(await createPlanningStore(client).loadPriorOutcomes(WORKSPACE, CURRENT), []);
  assertEquals(queries.map((q) => q.table), ["interviews"]);
});
