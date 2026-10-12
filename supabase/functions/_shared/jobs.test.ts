import { assertEquals, assertRejects } from "@std/assert";
import { createInngestJobQueue, type EventSender } from "./jobs.ts";

const payload = {
  workspace_id: "cccccccc-0000-4000-8000-000000000003",
  repository_id: "bbbbbbbb-0000-4000-8000-000000000002",
  job_id: "dddddddd-0000-4000-8000-000000000004",
  commit_sha: "a".repeat(40),
  installation_id: 7,
};

Deno.test("Inngest job queue sends the event with a job-derived id and returns the event id", async () => {
  const sent: Parameters<EventSender["send"]>[0][] = [];
  const queue = createInngestJobQueue({
    send(event) {
      sent.push(event);
      return Promise.resolve({ ids: ["01J0EVENT"] });
    },
  });
  assertEquals(await queue.enqueue("repository.analysis.requested", payload), { eventId: "01J0EVENT" });
  assertEquals(sent, [{
    id: `repository.analysis.requested:${payload.job_id}`,
    name: "repository.analysis.requested",
    data: payload,
  }]);
});

Deno.test("memory embedding events are keyed by the originating job and never collide with it", async () => {
  const sent: Parameters<EventSender["send"]>[0][] = [];
  const queue = createInngestJobQueue({
    send(event) {
      sent.push(event);
      return Promise.resolve({ ids: [] });
    },
  });
  const embedding = { workspace_id: payload.workspace_id, job_id: payload.job_id, commit_sha: payload.commit_sha };
  await queue.enqueue("repository.memory_embedding.requested", embedding);
  await queue.enqueue("repository.analysis.requested", payload);
  assertEquals(sent.map((e) => e.id), [
    `repository.memory_embedding.requested:${payload.job_id}`,
    `repository.analysis.requested:${payload.job_id}`,
  ]);
  assertEquals(sent[0].data, embedding);
});

Deno.test("events without a job are keyed by their explicit dedupe key", async () => {
  const sent: Parameters<EventSender["send"]>[0][] = [];
  const queue = createInngestJobQueue({
    send(event) {
      sent.push(event);
      return Promise.resolve({ ids: [] });
    },
  });
  const push = { workspace_id: payload.workspace_id, installation_id: 7, dedupe_key: `push:delivery-1:${payload.workspace_id}` };
  await queue.enqueue("repository.push.received", push);
  await queue.enqueue("repository.push.received", push);
  assertEquals(sent.map((e) => e.id), [
    `repository.push.received:push:delivery-1:${payload.workspace_id}`,
    `repository.push.received:push:delivery-1:${payload.workspace_id}`,
  ]);
  assertEquals(sent[0].data, push);
});

Deno.test("Inngest job queue returns no event id when none is reported and propagates send errors", async () => {
  const empty = createInngestJobQueue({ send: () => Promise.resolve({ ids: [] }) });
  assertEquals(await empty.enqueue("repository.analysis.requested", payload), { eventId: null });

  const failing = createInngestJobQueue({ send: () => Promise.reject(new Error("inngest down")) });
  await assertRejects(() => failing.enqueue("repository.analysis.requested", payload), Error, "inngest down");
});
