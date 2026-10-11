import { assert, assertAlmostEquals, assertEquals, assertNotEquals, assertThrows } from "@std/assert";
import {
  agreement,
  bootstrapCI,
  confusion,
  mean,
  precisionAtK,
  range,
  rankingMetrics,
  recallAtK,
  reciprocalRankAtK,
  seededRandom,
  std,
} from "./stats.ts";

Deno.test("mean, std and range on known values", () => {
  const values = [2, 4, 4, 4, 5, 5, 7, 9];
  assertEquals(mean(values), 5);
  // Sample variance: 32 / 7.
  assertAlmostEquals(std(values), Math.sqrt(32 / 7), 1e-12);
  assertEquals(range(values), 7);
  assertEquals(std([3]), 0);
  assertEquals(range([3]), 0);
});

Deno.test("mean, std and range reject empty and non-finite input", () => {
  for (const fn of [mean, std, range]) {
    assertThrows(() => fn([]), RangeError);
    assertThrows(() => fn([1, NaN]), RangeError);
  }
});

Deno.test("agreement returns the modal share and compares structurally", () => {
  assertEquals(agreement(["strong", "strong", "weak", "strong"]), { mode: "strong", share: 0.75 });
  assertEquals(agreement([{ a: 1, b: 2 }, { b: 2, a: 1 }, { a: 2 }]).share, 2 / 3);
  assertEquals(agreement([true]), { mode: true, share: 1 });
  assertThrows(() => agreement([]), RangeError);
});

Deno.test("agreement breaks ties deterministically regardless of input order", () => {
  assertEquals(agreement(["b", "a"]).mode, "a");
  assertEquals(agreement(["a", "b"]).mode, "a");
  assertEquals(agreement([3, 1, 3, 1]).mode, 1);
});

Deno.test("seededRandom is reproducible, seed-sensitive and in [0, 1)", () => {
  const draw = (seed: number) => {
    const r = seededRandom(seed);
    return Array.from({ length: 1000 }, () => r());
  };
  const a = draw(42);
  assertEquals(a, draw(42));
  assertNotEquals(a, draw(43));
  assert(a.every((x) => x >= 0 && x < 1));
  const m = mean(a);
  assert(m > 0.45 && m < 0.55, `mean ${m} is far from uniform`);
});

Deno.test("bootstrapCI is byte-identical for the same seed and brackets the mean", () => {
  const values = [0.2, 0.4, 0.5, 0.55, 0.6, 0.7, 0.8, 0.9, 1, 0.3];
  const a = bootstrapCI(values, { seed: 7 });
  assertEquals(a, bootstrapCI(values, { seed: 7 }));
  assertNotEquals(a, bootstrapCI(values, { seed: 8 }));
  const m = mean(values);
  assert(a[0] < m && m < a[1], `interval ${a} does not contain ${m}`);
  assert(a[0] >= Math.min(...values) && a[1] <= Math.max(...values));
});

Deno.test("bootstrapCI narrows with a lower level and supports custom statistics", () => {
  const values = Array.from({ length: 30 }, (_, i) => i % 7);
  const wide = bootstrapCI(values, { seed: 1, level: 0.95 });
  const narrow = bootstrapCI(values, { seed: 1, level: 0.5 });
  assert(narrow[1] - narrow[0] < wide[1] - wide[0]);
  const [lo, hi] = bootstrapCI(values, { seed: 1, statistic: (s) => Math.max(...s) });
  assert(lo <= hi && hi === 6);
});

Deno.test("bootstrapCI of a constant or single value is a point", () => {
  assertEquals(bootstrapCI([0.5, 0.5, 0.5], { seed: 3 }), [0.5, 0.5]);
  assertEquals(bootstrapCI([1], { seed: 3 }), [1, 1]);
});

Deno.test("bootstrapCI rejects bad options", () => {
  assertThrows(() => bootstrapCI([], { seed: 1 }), RangeError);
  assertThrows(() => bootstrapCI([1], { seed: 1, iterations: 0 }), RangeError);
  assertThrows(() => bootstrapCI([1], { seed: 1, level: 1 }), RangeError);
});

Deno.test("precision, recall and reciprocal rank at k", () => {
  const c = { ranked: ["x", "a", "y", "b", "z"], relevant: ["a", "b", "c"] };
  assertEquals(precisionAtK(c, 1), 0);
  assertAlmostEquals(precisionAtK(c, 3), 1 / 3, 1e-12);
  assertAlmostEquals(precisionAtK(c, 5), 2 / 5, 1e-12);
  assertAlmostEquals(recallAtK(c, 3), 1 / 3, 1e-12);
  assertAlmostEquals(recallAtK(c, 5), 2 / 3, 1e-12);
  assertEquals(reciprocalRankAtK(c, 1), 0);
  assertEquals(reciprocalRankAtK(c, 5), 0.5);
});

Deno.test("ranking metrics count short result lists as misses and repeated ids once", () => {
  assertEquals(precisionAtK({ ranked: ["a"], relevant: ["a"] }, 5), 0.2);
  assertEquals(recallAtK({ ranked: ["a", "a", "a"], relevant: ["a", "b"] }, 3), 0.5);
  assertEquals(precisionAtK({ ranked: ["a", "a", "b"], relevant: ["b"] }, 2), 0.5);
  assertEquals(reciprocalRankAtK({ ranked: ["a", "a", "b"], relevant: ["b"] }, 2), 0.5);
});

Deno.test("ranking metrics refuse unlabelled cases and invalid k", () => {
  assertThrows(() => recallAtK({ ranked: ["a"], relevant: [] }, 1), RangeError, "unlabelled");
  assertThrows(() => precisionAtK({ ranked: ["a"], relevant: ["a"] }, 0), RangeError);
  assertThrows(() => rankingMetrics([], [1]), RangeError);
});

Deno.test("rankingMetrics averages per k in ascending order and keeps per-case values", () => {
  const cases = [
    { ranked: ["a", "b", "c"], relevant: ["a"] },
    { ranked: ["x", "y", "b"], relevant: ["b"] },
  ];
  const [k1, k3] = rankingMetrics(cases, [3, 1, 3]);
  assertEquals(k1.k, 1);
  assertEquals(k1.precision, 0.5);
  assertEquals(k1.recall, 0.5);
  assertEquals(k1.mrr, 0.5);
  assertEquals(k3.k, 3);
  assertEquals(k3.recall, 1);
  assertAlmostEquals(k3.mrr, (1 + 1 / 3) / 2, 1e-12);
  assertEquals(k3.perCase.reciprocalRank, [1, 1 / 3]);
});

Deno.test("confusion counts cells and leaves undefined ratios null", () => {
  const pairs = [
    { predicted: true, actual: true },
    { predicted: true, actual: true },
    { predicted: true, actual: false },
    { predicted: false, actual: true },
    { predicted: false, actual: false },
  ];
  assertEquals(confusion(pairs), {
    n: 5,
    tp: 2,
    fp: 1,
    tn: 1,
    fn: 1,
    precision: 2 / 3,
    recall: 2 / 3,
    accuracy: 3 / 5,
  });
  const negatives = confusion([{ predicted: false, actual: false }]);
  assertEquals(negatives.precision, null);
  assertEquals(negatives.recall, null);
  assertThrows(() => confusion([]), RangeError);
});
