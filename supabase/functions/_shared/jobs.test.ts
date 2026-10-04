import { assertEquals } from "@std/assert";
import { createLoggingJobQueue } from "./jobs.ts";

Deno.test("logging job queue records the event without the payload and returns no event id", async () => {
  const lines: string[] = [];
  const queue = createLoggingJobQueue((line) => lines.push(line));
  const result = await queue.enqueue("repository.index", {
    workspace_id: "cccccccc-0000-4000-8000-000000000003",
    repository_id: "bbbbbbbb-0000-4000-8000-000000000002",
    commit_sha: "a".repeat(40),
    installation_id: 7,
  });
  assertEquals(result, { eventId: null });
  assertEquals(lines.map((l) => JSON.parse(l)), [
    { event: "job_enqueued", name: "repository.index", workspace_id: "cccccccc-0000-4000-8000-000000000003" },
  ]);
});
