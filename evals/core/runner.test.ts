import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { stableJson } from "./keys.ts";
import { computePins, updatePins } from "./pins.ts";
import { RunConfigError, runProject } from "./runner.ts";
import type { Metric, Project, Suite } from "./types.ts";

const PINS = [
  { id: "synthetic", kind: "corpus" as const, files: ["corpus"] },
  { id: "dataset.a", kind: "dataset" as const, files: ["a.json"] },
  { id: "recordings", kind: "recordings" as const, files: ["recordings"] },
];

function metric(extra: Partial<Metric> = {}): Metric {
  return { id: "m", label: "M", value: 1, n: 1, direction: "higher_is_better", provenance: "deterministic", corpus: "synthetic", gate: true, ...extra };
}

function suite(id: string, metrics: () => Metric[], pins = ["synthetic"]): Suite<null> {
  return { id, pins, run: () => Promise.resolve({ metrics: metrics() }) };
}

function project(suites: Suite<null>[], setup: () => Promise<null> = () => Promise.resolve(null)): Project<null> {
  return { id: "demo", pins: PINS, config: {}, setup, suites };
}

async function withPinnedDir(fn: (dir: URL) => Promise<void>): Promise<void> {
  const path = await Deno.makeTempDir({ prefix: "evals-runner-" });
  const dir = new URL(`file:///${path.replace(/\\/g, "/").replace(/^\//, "")}/`);
  try {
    await Deno.mkdir(new URL("corpus/", dir));
    await Deno.writeTextFile(new URL("corpus/x.ts", dir), "x\n");
    await Deno.writeTextFile(new URL("a.json", dir), "[]\n");
    const pinned = updatePins({ format: 1, pins: {} }, await computePins(dir, PINS), "all", { date: "d", user: "u", reason: "r" });
    await Deno.writeTextFile(new URL("pins.json", dir), stableJson(pinned.file));
    await fn(dir);
  } finally {
    await Deno.remove(path, { recursive: true });
  }
}

const opts = (dir: URL) => ({ projectDir: dir, mode: "replay" as const, seed: 1, samples: 1, log: () => {} });

Deno.test("invalid metrics fail only their suite", async () => {
  await withPinnedDir(async (dir) => {
    const results = await runProject(project([
      suite("bad", () => [metric({ id: "bad.corpus", corpus: "dataset.a" }), metric({ id: "bad.value", value: NaN })]),
      suite("good", () => [metric({ id: "good.m" })]),
    ]), opts(dir));
    assertEquals(results.suites.map((s) => s.status), ["error", "ok"]);
    assertStringIncludes(results.suites[0].error!, 'corpus "dataset.a" is not a declared corpus pin');
    assertStringIncludes(results.suites[0].error!, "bad.value: value must be finite");
    assertEquals(results.suites[0].metrics, []);
    assertEquals(results.suites[1].metrics.map((m) => m.id), ["good.m"]);
  });
});

Deno.test("metric ids must be unique across suites", async () => {
  await withPinnedDir(async (dir) => {
    const results = await runProject(project([suite("a", () => [metric()]), suite("b", () => [metric()])]), opts(dir));
    assertEquals(results.suites.map((s) => s.status), ["ok", "error"]);
    assertStringIncludes(results.suites[1].error!, "duplicate id");
  });
});

Deno.test("a thrown suite error is captured and other suites still run", async () => {
  await withPinnedDir(async (dir) => {
    const boom: Suite<null> = { id: "boom", pins: [], run: () => Promise.reject(new Error("kaput")) };
    const results = await runProject(project([boom, suite("ok", () => [metric()])]), opts(dir));
    assertEquals(results.suites.map((s) => [s.id, s.status, s.error]), [["boom", "error", "kaput"], ["ok", "ok", undefined]]);
  });
});

Deno.test("setup failure and pin failure stop before any suite runs", async () => {
  await withPinnedDir(async (dir) => {
    let ran = false;
    const s: Suite<null> = { id: "s", pins: [], run: () => (ran = true, Promise.resolve({ metrics: [] })) };
    const failedSetup = await runProject(project([s], () => Promise.reject(new Error("no corpus"))), opts(dir));
    assertEquals([failedSetup.error, failedSetup.suites], ["setup failed: no corpus", []]);

    await Deno.writeTextFile(new URL("a.json", dir), "[1]\n");
    const stale = await runProject(project([s]), opts(dir));
    assertEquals(stale.integrity.ok, false);
    assertStringIncludes(stale.error!, "pin integrity");
    assert(!ran);
  });
});

Deno.test("suite filters mark the run partial; unknown suites and undeclared pins are config errors", async () => {
  await withPinnedDir(async (dir) => {
    const p = project([suite("a", () => [metric({ id: "a.m" })]), suite("b", () => [metric({ id: "b.m" })])]);
    const partial = await runProject(p, { ...opts(dir), suites: ["b"] });
    assertEquals([partial.partial, partial.suites.map((s) => s.id)], [true, ["b"]]);
    await assertRejects(() => runProject(p, { ...opts(dir), suites: ["zzz"] }), RunConfigError, "unknown suite");
    await assertRejects(() => runProject(project([suite("a", () => [], ["nope"])]), opts(dir)), RunConfigError, "undeclared pin");
  });
});
