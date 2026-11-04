import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { createReportShareResponseSchema } from "@stackprep/shared";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import type { Authenticate } from "../_shared/auth.ts";
import { hashShareToken } from "../_shared/share-token.ts";
import { createReportSharesHandler, type ReportShareStore } from "./handler.ts";

const userId = "aaaaaaaa-0000-4000-8000-000000000001";
const ownInterview = "cccccccc-0000-4000-8000-000000000003";
const otherInterview = "dddddddd-0000-4000-8000-000000000004";

const authenticate: Authenticate = (req) =>
  Promise.resolve(
    req.headers.get("Authorization") === "Bearer user"
      ? { user: { id: userId } as User, supabase: {} as SupabaseClient }
      : null,
  );

function setup(options: { status?: string; reportReady?: boolean } = {}) {
  const calls: string[] = [];
  const hashes: string[] = [];
  let active: string | null = null;
  const store: ReportShareStore = {
    create(_user, _interview, hash) {
      calls.push("create");
      hashes.push(hash);
      if (options.reportReady === false) {
        return Promise.resolve(null);
      }
      active = "2026-11-04T10:00:00+00:00";
      return Promise.resolve(active);
    },
    revoke() {
      calls.push("revoke");
      const was = active !== null;
      active = null;
      return Promise.resolve(was);
    },
    getActive() {
      calls.push("getActive");
      return Promise.resolve(active);
    },
  };
  const handler = createReportSharesHandler({
    webOrigin: "http://localhost:3000",
    authenticate,
    // Ownership: only `ownInterview` is visible to the caller's RLS client.
    reader: () => ({
      getInterviewStatus: (id) =>
        Promise.resolve(
          id === ownInterview ? (options.status ?? "completed") : null,
        ),
    }),
    store,
  });
  return { handler, calls, hashes };
}

const request = (method: string, id: string, token: string | null = "user") =>
  new Request(`http://localhost/report-shares/${id}`, {
    method,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });

Deno.test("requires a signed-in user and touches nothing otherwise", async () => {
  const { handler, calls } = setup();
  assertEquals(
    (await handler(request("POST", ownInterview, null))).status,
    401,
  );
  assertEquals(calls, []);
});

Deno.test("another user's interview is a 404 and never reaches the service role", async () => {
  const { handler, calls } = setup();
  for (const method of ["GET", "POST", "DELETE"]) {
    assertEquals((await handler(request(method, otherInterview))).status, 404);
  }
  assertEquals((await handler(request("GET", "not-a-uuid"))).status, 404);
  assertEquals(calls, []);
});

Deno.test("creating a link returns the token once and stores only its hash", async () => {
  const { handler, hashes } = setup();
  const res = await handler(request("POST", ownInterview));
  assertEquals(res.status, 201);
  const body = createReportShareResponseSchema.parse(await res.json());
  assertEquals(hashes, [await hashShareToken(body.token)]);
  assertNotEquals(hashes[0], body.token);

  const status = await (await handler(request("GET", ownInterview))).json();
  assertEquals(status.active, true);
  assert(
    !JSON.stringify(status).includes(body.token),
    "status never carries the token",
  );
});

Deno.test("a new link replaces the previous token", async () => {
  const { handler, hashes } = setup();
  await handler(request("POST", ownInterview));
  await handler(request("POST", ownInterview));
  assertEquals(hashes.length, 2);
  assertNotEquals(hashes[0], hashes[1]);
});

Deno.test("an interview that is not completed or has no report cannot be shared", async () => {
  const running = setup({ status: "in_progress" });
  assertEquals(
    (await running.handler(request("POST", ownInterview))).status,
    409,
  );
  assertEquals(running.calls, []);

  const noReport = setup({ reportReady: false });
  const res = await noReport.handler(request("POST", ownInterview));
  assertEquals(res.status, 409);
  assertEquals((await res.json()).code, "report_not_ready");
});

Deno.test("revoking deactivates the link and is idempotent", async () => {
  const { handler } = setup();
  await handler(request("POST", ownInterview));
  assertEquals(
    (await (await handler(request("DELETE", ownInterview))).json()).active,
    false,
  );
  assertEquals((await handler(request("DELETE", ownInterview))).status, 200);
  assertEquals(
    (await (await handler(request("GET", ownInterview))).json()).active,
    false,
  );
});
