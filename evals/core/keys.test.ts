import { assertEquals, assertMatch, assertNotEquals, assertThrows } from "@std/assert";
import { canonicalJson, componentDiff, hashCanonical, sha256, stableJson } from "./keys.ts";

Deno.test("stableJson indents sorted keys and ends with one newline", () => {
  assertEquals(stableJson({ b: [1], a: { d: 1, c: undefined } }), '{\n  "a": {\n    "d": 1\n  },\n  "b": [\n    1\n  ]\n}\n');
});

Deno.test("canonicalJson sorts keys at every depth and keeps array order", () => {
  assertEquals(
    canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: "x" } }),
    '{"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":1}',
  );
  assertNotEquals(canonicalJson([1, 2]), canonicalJson([2, 1]));
});

Deno.test("canonicalJson omits undefined properties like JSON", () => {
  assertEquals(canonicalJson({ a: undefined, b: null }), '{"b":null}');
});

Deno.test("canonicalJson rejects values that would silently lose information", () => {
  for (const bad of [NaN, Infinity, 1n, () => 1, Symbol("s"), new Map(), new Set(), new Date(0), undefined]) {
    assertThrows(() => canonicalJson({ nested: [bad] }), TypeError);
  }
  assertThrows(() => canonicalJson({ a: { b: NaN } }), TypeError, "$.a.b");
});

Deno.test("canonicalJson accepts null-prototype objects", () => {
  const value = Object.assign(Object.create(null), { b: 2, a: 1 });
  assertEquals(canonicalJson(value), '{"a":1,"b":2}');
});

Deno.test("sha256 matches the known digest and accepts bytes", async () => {
  const hex = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
  assertEquals(await sha256("abc"), hex);
  assertEquals(await sha256(new TextEncoder().encode("abc")), hex);
  assertMatch(await sha256(""), /^[0-9a-f]{64}$/);
});

Deno.test("hashCanonical ignores key order but not values", async () => {
  const a = await hashCanonical({ model: "m", input: { text: "hi", images: [] } });
  const b = await hashCanonical({ input: { images: [], text: "hi" }, model: "m" });
  const c = await hashCanonical({ model: "m", input: { text: "hi!", images: [] } });
  assertEquals(a, b);
  assertNotEquals(a, c);
});

Deno.test("componentDiff names added, removed and changed paths, sorted", () => {
  const before = { model: "a", schema: { name: "s", properties: { score: 1, keep: true } }, system: "x", tools: [1] };
  const after = { model: "b", schema: { name: "s", properties: { score: 2, keep: true } }, input: "q", tools: [1] };
  assertEquals(componentDiff(before, after), [
    { path: "input", kind: "added" },
    { path: "model", kind: "changed" },
    { path: "schema.properties.score", kind: "changed" },
    { path: "system", kind: "removed" },
  ]);
});

Deno.test("componentDiff compares arrays whole and treats key order as equal", () => {
  assertEquals(componentDiff({ a: { x: 1, y: 2 } }, { a: { y: 2, x: 1 } }), []);
  assertEquals(componentDiff({ list: [{ a: 1 }] }, { list: [{ a: 2 }] }), [{ path: "list", kind: "changed" }]);
  assertEquals(componentDiff({ a: { x: 1 } }, { a: "flat" }), [{ path: "a", kind: "changed" }]);
});
