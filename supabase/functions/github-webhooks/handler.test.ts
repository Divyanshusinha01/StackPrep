import { assert, assertEquals } from "@std/assert";
import type { JobEvents, JobQueue } from "../_shared/jobs.ts";
import { createGithubWebhooksHandler, type MarkPushReceived, PUSH_EVENT, verifySignature } from "./handler.ts";

const SECRET = "webhook-secret";
const DELIVERY = "72d3162e-cc78-11e3-81ab-4c9367dc0958";
const WS_A = "aaaaaaaa-0000-4000-8000-000000000001";
const WS_B = "bbbbbbbb-0000-4000-8000-000000000002";

function pushBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ref: "refs/heads/main",
    before: "a".repeat(40),
    after: "b".repeat(40),
    deleted: false,
    forced: false,
    repository: { id: 9001, full_name: "acme/api", default_branch: "main" },
    installation: { id: 501 },
    ...extra,
  };
}

async function sign(body: string | Uint8Array, secret = SECRET): Promise<string> {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, bytes as Uint8Array<ArrayBuffer>));
  return `sha256=${[...mac].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

interface Setup {
  mark?: MarkPushReceived;
  enqueueError?: Error;
}

function setup({ mark, enqueueError }: Setup = {}) {
  const marked: [number, number][] = [];
  const enqueued: { name: string; payload: JobEvents["repository.push.received"] }[] = [];
  const errors: string[] = [];
  const logs: string[] = [];
  const jobs: JobQueue = {
    enqueue: (name, payload) => {
      if (enqueueError) {
        return Promise.reject(enqueueError);
      }
      enqueued.push({ name, payload: payload as JobEvents["repository.push.received"] });
      return Promise.resolve({ eventId: "evt" });
    },
  };
  const handler = createGithubWebhooksHandler({
    webhookSecret: SECRET,
    markPushReceived: mark ?? ((repoId, installationId) => {
      marked.push([repoId, installationId]);
      return Promise.resolve([WS_A, WS_B]);
    }),
    jobs,
    log: (line) => logs.push(line),
    reportError: (_err, event) => errors.push(event),
  });
  return { handler, marked, enqueued, errors, logs };
}

async function deliver(
  handler: (req: Request) => Promise<Response>,
  { body = JSON.stringify(pushBody()), event = "push", signature, delivery = DELIVERY, method = "POST" }: {
    body?: string;
    event?: string;
    signature?: string | null;
    delivery?: string;
    method?: string;
  } = {},
): Promise<Response> {
  const headers = new Headers({ "Content-Type": "application/json", "X-GitHub-Event": event, "X-GitHub-Delivery": delivery });
  const sig = signature === undefined ? await sign(body) : signature;
  if (sig !== null) {
    headers.set("X-Hub-Signature-256", sig);
  }
  return handler(new Request("http://localhost/functions/v1/github-webhooks", { method, headers, body: method === "GET" ? undefined : body }));
}

// Signature ---------------------------------------------------------------------------

Deno.test("a valid signature over the raw bytes is accepted", async () => {
  const body = new TextEncoder().encode('{"zen":"Keep it logically awesome."}');
  assert(await verifySignature(SECRET, body, await sign(body)));
});

Deno.test("bad signatures are rejected with 401 before anything is marked", async () => {
  const body = JSON.stringify(pushBody());
  const valid = await sign(body);
  const cases: [string, string | null, string][] = [
    ["missing header", null, body],
    ["wrong prefix", valid.replace("sha256=", "sha1="), body],
    ["wrong secret", await sign(body, "other-secret"), body],
    ["body altered by one byte", valid, body.replace("9001", "9002")],
    ["shorter signature", valid.slice(0, -2), body],
    ["longer signature", `${valid}00`, body],
    ["uppercase non-hex garbage", "sha256=" + "Z".repeat(64), body],
  ];
  for (const [name, signature, sent] of cases) {
    const { handler, marked, enqueued } = setup();
    const res = await deliver(handler, { body: sent, signature });
    assertEquals(res.status, 401, name);
    assertEquals(marked, [], name);
    assertEquals(enqueued, [], name);
  }
});

Deno.test("verification uses the raw bytes, not re-serialized JSON", async () => {
  const raw = '{\n  "ref": "refs/heads/main" ,"after":"' + "b".repeat(40) +
    '", "repository": {"id": 9001, "default_branch": "main"}, "installation": {"id": 501}}';
  const { handler, marked } = setup();
  const reserialized = JSON.stringify(JSON.parse(raw));
  const rejected = await deliver(handler, { body: raw, signature: await sign(reserialized) });
  assertEquals(rejected.status, 401);
  const accepted = await deliver(handler, { body: raw, signature: await sign(raw) });
  assertEquals(accepted.status, 202);
  assertEquals(marked, [[9001, 501]]);
});

// Events ------------------------------------------------------------------------------

Deno.test("ping answers 200 and other events are a 202 no-op", async () => {
  const { handler, marked } = setup();
  assertEquals((await deliver(handler, { event: "ping", body: '{"zen":"x"}' })).status, 200);
  assertEquals((await deliver(handler, { event: "installation", body: '{"action":"suspend"}' })).status, 202);
  assertEquals(marked, []);
});

Deno.test("only POST is accepted", async () => {
  const { handler } = setup();
  const res = await handler(new Request("http://localhost/functions/v1/github-webhooks", { method: "GET" }));
  assertEquals(res.status, 405);
});

Deno.test("tags, other branches, deleted refs and pushes without an installation are ignored", async () => {
  const bodies = [
    pushBody({ ref: "refs/tags/v1.0.0" }),
    pushBody({ ref: "refs/heads/feature" }),
    pushBody({ deleted: true, after: "0".repeat(40) }),
    pushBody({ installation: undefined }),
  ];
  for (const body of bodies) {
    const { handler, marked, enqueued } = setup();
    const res = await deliver(handler, { body: JSON.stringify(body) });
    assertEquals(res.status, 202);
    assertEquals(marked, []);
    assertEquals(enqueued, []);
  }
});

Deno.test("an invalid push payload or delivery id is a 400", async () => {
  const { handler, marked } = setup();
  assertEquals((await deliver(handler, { body: "not json" })).status, 400);
  assertEquals((await deliver(handler, { body: JSON.stringify({ ref: "refs/heads/main" }) })).status, 400);
  assertEquals((await deliver(handler, { delivery: "../../etc" })).status, 400);
  assertEquals(marked, []);
});

// Pushes ------------------------------------------------------------------------------

Deno.test("a push marks every eligible workspace first, then enqueues one event per workspace", async () => {
  const order: string[] = [];
  const { handler, enqueued } = setup({
    mark: (repoId, installationId) => {
      order.push(`mark:${repoId}:${installationId}`);
      return Promise.resolve([WS_A, WS_B]);
    },
  });
  const res = await deliver(handler, { body: JSON.stringify(pushBody({ forced: true })) });
  assertEquals(res.status, 202);
  assertEquals(await res.json(), { status: "accepted", workspaces: 2 });
  assertEquals(order, ["mark:9001:501"]);
  assertEquals(enqueued, [
    { name: PUSH_EVENT, payload: { workspace_id: WS_A, installation_id: 501, dedupe_key: `push:${DELIVERY}:${WS_A}` } },
    { name: PUSH_EVENT, payload: { workspace_id: WS_B, installation_id: 501, dedupe_key: `push:${DELIVERY}:${WS_B}` } },
  ]);
});

Deno.test("an unknown repository marks nothing and enqueues nothing", async () => {
  const { handler, enqueued } = setup({ mark: () => Promise.resolve([]) });
  const res = await deliver(handler);
  assertEquals(res.status, 202);
  assertEquals(await res.json(), { status: "accepted", workspaces: 0 });
  assertEquals(enqueued, []);
});

Deno.test("a duplicate delivery produces the same event ids", async () => {
  const { handler, enqueued } = setup();
  await deliver(handler);
  await deliver(handler);
  const keys = enqueued.map((e) => e.payload.dedupe_key);
  assertEquals(keys.slice(0, 2), keys.slice(2));
});

Deno.test("an enqueue failure is reported and still answers 202, since the push is already marked", async () => {
  const { handler, marked, errors, logs } = setup({ enqueueError: new Error("inngest down") });
  const res = await deliver(handler);
  assertEquals(res.status, 202);
  assertEquals(marked, [[9001, 501]]);
  assertEquals(errors, ["push_enqueue_failed"]);
  assertEquals(JSON.parse(logs.at(-1)!).enqueue_failed, 2);
});

Deno.test("a marking failure answers 500 so GitHub records a failed delivery", async () => {
  const { handler, enqueued, errors } = setup({ mark: () => Promise.reject(new Error("db down")) });
  const res = await deliver(handler);
  assertEquals(res.status, 500);
  assertEquals(enqueued, []);
  assertEquals(errors, ["push_mark_failed"]);
});
