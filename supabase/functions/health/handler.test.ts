import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { healthResponseSchema } from "@stackprep/shared";
import { createHealthHandler } from "./handler.ts";

const handler = createHealthHandler({ webOrigin: "http://localhost:3000" });
const url = "http://localhost/health";

Deno.test("GET returns a valid health payload", async () => {
  const res = handler(new Request(url));
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("content-type"), "application/json");
  assert(healthResponseSchema.safeParse(await res.json()).success);
});

Deno.test("GET allows the configured web origin", () => {
  const res = handler(new Request(url, { headers: { Origin: "http://localhost:3000" } }));
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("access-control-allow-origin"), "http://localhost:3000");
});

Deno.test("OPTIONS preflight from the configured web origin succeeds", () => {
  const res = handler(
    new Request(url, {
      method: "OPTIONS",
      headers: { Origin: "http://localhost:3000", "Access-Control-Request-Method": "GET" },
    }),
  );
  assertEquals(res.status, 204);
  assertEquals(res.headers.get("access-control-allow-origin"), "http://localhost:3000");
  assert(res.headers.get("access-control-allow-methods")?.includes("GET"));
});

Deno.test("rejects other origins", () => {
  for (const method of ["GET", "OPTIONS"]) {
    const res = handler(new Request(url, { method, headers: { Origin: "https://evil.example" } }));
    assertEquals(res.status, 403);
    assertNotEquals(res.headers.get("access-control-allow-origin"), "https://evil.example");
  }
});

Deno.test("rejects unsupported methods", () => {
  const res = handler(new Request(url, { method: "POST" }));
  assertEquals(res.status, 405);
  assertEquals(res.headers.get("allow"), "GET, OPTIONS");
});
