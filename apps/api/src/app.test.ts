import { describe, expect, it } from "vitest";
import { healthResponseSchema } from "@stackprep/shared";
import { createApp } from "./app.ts";

const app = createApp({ webOrigin: "http://localhost:3000" });

describe("GET /health", () => {
  it("returns a valid health payload", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(healthResponseSchema.safeParse(await res.json()).success).toBe(true);
  });

  it("allows the configured web origin", async () => {
    const res = await app.request("/health", { headers: { Origin: "http://localhost:3000" } });
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
  });

  it("does not allow other origins", async () => {
    const res = await app.request("/health", { headers: { Origin: "https://evil.example" } });
    expect(res.headers.get("access-control-allow-origin")).not.toBe("https://evil.example");
  });
});
