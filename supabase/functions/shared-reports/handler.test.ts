import { assert, assertEquals } from "@std/assert";
import { sharedReportResponseSchema } from "@stackprep/shared";
import { hashShareToken } from "../_shared/share-token.ts";
import { createSharedReportsHandler, type SharedReportRecord } from "./handler.ts";

const TOKEN = "T".repeat(43);

const content = {
  executive_summary: "Summary",
  categories: [{ name: "Architecture", rating: "strong", narrative: "Good." }],
  strengths: [],
  gaps: [],
  interview_evidence: [],
  repository_evidence: [],
  areas_to_improve: [],
  struggled_questions: [],
};

function setup(
  record: Partial<SharedReportRecord> | null,
  tokenHash?: Promise<string>,
) {
  const lookups: string[] = [];
  const handler = createSharedReportsHandler({
    webOrigin: "http://localhost:3000",
    store: {
      resolve: async (hash) => {
        lookups.push(hash);
        const expected = await (tokenHash ?? hashShareToken(TOKEN));
        return record && hash === expected
          ? {
            interview_number: 2,
            repository_full_name: "ivy/api",
            is_private: false,
            generated_at: "2026-11-04T10:00:00+00:00",
            content,
            ...record,
          }
          : null;
      },
    },
  });
  return { handler, lookups };
}

const get = (token: string) => new Request(`http://localhost/shared-reports/${token}`);

Deno.test("serves the report to anyone with the token, without a session", async () => {
  const { handler } = setup({});
  const res = await handler(get(TOKEN));
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("X-Robots-Tag"), "noindex, nofollow");
  assertEquals(res.headers.get("Cache-Control"), "no-store");
  const body = sharedReportResponseSchema.parse(await res.json());
  assertEquals(body.repository, "ivy/api");
  assertEquals(body.interview_number, 2);
});

Deno.test("never names a private repository", async () => {
  const { handler } = setup({ is_private: true });
  const body = sharedReportResponseSchema.parse(
    await (await handler(get(TOKEN))).json(),
  );
  assertEquals(body.repository, null);
});

Deno.test("returns only report fields: no transcript and no identifiers", async () => {
  const { handler } = setup({});
  const body = await (await handler(get(TOKEN))).json();
  assertEquals(Object.keys(body).sort(), [
    "generated_at",
    "interview_number",
    "repository",
    "report",
  ]);
});

Deno.test("an unknown or revoked token and a malformed one are the same 404", async () => {
  const { handler, lookups } = setup(null);
  const unknown = await handler(get("U".repeat(43)));
  const revoked = await handler(get(TOKEN));
  const malformed = await handler(get("short"));
  for (const res of [unknown, revoked, malformed]) {
    assertEquals(res.status, 404);
    assertEquals((await res.json()).code, "not_found");
  }
  // A malformed token never reaches the database.
  assertEquals(lookups.length, 2);
});

Deno.test("looks the token up by hash, never by the token itself", async () => {
  const { handler, lookups } = setup({});
  await handler(get(TOKEN));
  assertEquals(lookups, [await hashShareToken(TOKEN)]);
  assert(!lookups.includes(TOKEN));
});

Deno.test("a stored report that no longer parses is a 404, not a partial leak", async () => {
  const { handler } = setup({ content: { executive_summary: "only this" } });
  assertEquals((await handler(get(TOKEN))).status, 404);
});

Deno.test("only GET is allowed", async () => {
  const { handler } = setup({});
  const res = await handler(
    new Request(`http://localhost/shared-reports/${TOKEN}`, { method: "POST" }),
  );
  assertEquals(res.status, 405);
});

Deno.test("rejects browser requests from other origins", async () => {
  const { handler } = setup({});
  const res = await handler(
    new Request(`http://localhost/shared-reports/${TOKEN}`, {
      headers: { Origin: "https://evil.example" },
    }),
  );
  assertEquals(res.status, 403);
});
