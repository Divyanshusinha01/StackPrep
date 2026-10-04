import { assertEquals, assertInstanceOf, assertRejects } from "@std/assert";
import {
  type InterviewStateRpcClient,
  InterviewStateUpdateError,
  StaleInterviewStateError,
  updateInterviewState,
} from "./interview-state.ts";

const state = { coverageMap: { backend: "covered" }, plan: {}, strategy: {} };

function clientReturning(result: Awaited<ReturnType<InterviewStateRpcClient["rpc"]>>) {
  const calls: unknown[] = [];
  const client: InterviewStateRpcClient = {
    rpc(fn, args) {
      calls.push({ fn, args });
      return Promise.resolve(result);
    },
  };
  return { client, calls };
}

Deno.test("returns the new version and sends the expected RPC arguments", async () => {
  const { client, calls } = clientReturning({ data: 4, error: null });
  assertEquals(await updateInterviewState(client, "interview-1", 3, state), 4);
  assertEquals(calls, [{
    fn: "update_interview_state",
    args: {
      p_interview_id: "interview-1",
      p_expected_version: 3,
      p_coverage_map: state.coverageMap,
      p_plan: {},
      p_strategy: {},
    },
  }]);
});

Deno.test("maps SQLSTATE P0409 to StaleInterviewStateError", async () => {
  const { client } = clientReturning({ data: null, error: { code: "P0409", message: "stale_interview_state" } });
  const error = await assertRejects(() => updateInterviewState(client, "interview-1", 3, state));
  assertInstanceOf(error, StaleInterviewStateError);
  assertEquals(error.interviewId, "interview-1");
  assertEquals(error.expectedVersion, 3);
});

Deno.test("other database errors are not reported as stale", async () => {
  const { client } = clientReturning({ data: null, error: { code: "42501", message: "permission denied" } });
  const error = await assertRejects(() => updateInterviewState(client, "interview-1", 3, state));
  assertInstanceOf(error, InterviewStateUpdateError);
  assertEquals(error.code, "42501");
});

Deno.test("rejects a version that is not exactly expected + 1", async () => {
  const { client } = clientReturning({ data: 7, error: null });
  await assertRejects(() => updateInterviewState(client, "interview-1", 3, state), InterviewStateUpdateError);
});
