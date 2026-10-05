import { describe, expect, it } from "vitest";
import { EXAMINING_VISIBLE_MS, examiningLabel, examiningReducer, shortenPath } from "./examining";

describe("examiningReducer", () => {
  it("shows examined paths and expires them after a few seconds", () => {
    const shown = examiningReducer(null, { type: "examined", items: [{ path: "src/a.ts", area: "src" }], at: 1000 });
    expect(shown).toEqual({ items: [{ path: "src/a.ts", area: "src" }], until: 1000 + EXAMINING_VISIBLE_MS });
    expect(examiningReducer(shown, { type: "expire", at: 1000 + EXAMINING_VISIBLE_MS - 1 })).toBe(shown);
    expect(examiningReducer(shown, { type: "expire", at: 1000 + EXAMINING_VISIBLE_MS })).toBeNull();
  });

  it("dedupes, caps the list, and ignores empty updates", () => {
    const items = ["a", "b", "a", "c", "d"].map((path) => ({ path }));
    expect(examiningReducer(null, { type: "examined", items, at: 0 })?.items.map((i) => i.path)).toEqual(["a", "b", "c"]);
    const shown = examiningReducer(null, { type: "examined", items: [{ path: "a" }], at: 0 });
    expect(examiningReducer(shown, { type: "examined", items: [], at: 5 })).toBe(shown);
  });

  it("a newer examination replaces the previous one and extends the timer", () => {
    const first = examiningReducer(null, { type: "examined", items: [{ path: "a" }], at: 0 });
    const second = examiningReducer(first, { type: "examined", items: [{ path: "b" }], at: 4000 });
    expect(second).toEqual({ items: [{ path: "b" }], until: 4000 + EXAMINING_VISIBLE_MS });
    expect(examiningReducer(second, { type: "reset" })).toBeNull();
  });
});

describe("examiningLabel", () => {
  it("names the first path and counts the rest", () => {
    expect(examiningLabel([])).toBe("");
    expect(examiningLabel([{ path: "src/auth/jwt.ts" }])).toBe("Examining src/auth/jwt.ts");
    expect(examiningLabel([{ path: "src/a.ts" }, { path: "src/b.ts" }, { path: "src/c.ts" }])).toBe(
      "Examining src/a.ts and 2 more",
    );
  });

  it("shortens long paths but keeps the file name", () => {
    const long = `src/${"nested/".repeat(10)}invoice.ts`;
    const short = shortenPath(long);
    expect(short.length).toBe(48);
    expect(short.startsWith("src/")).toBe(true);
    expect(short.endsWith("…/invoice.ts")).toBe(true);
    expect(shortenPath("x/".repeat(5) + "y".repeat(60)).length).toBe(48);
  });
});
