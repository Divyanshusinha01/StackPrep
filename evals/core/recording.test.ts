import { assert, assertEquals, assertNotEquals, assertRejects, assertStringIncludes, assertThrows } from "@std/assert";
import {
  createFileRecorder,
  type FileRecorderOptions,
  keyComponents,
  RECORDING_FORMAT,
  recordingKey,
  ReplayMissError,
} from "./recording.ts";

const PINS = { synthetic: "c0rpus", "dataset.retrieval": "d4ta" };
const COMPONENTS = { model: "m1", reasoningEffort: "low", schema: { name: "s", properties: { score: 1 } }, input: "q" };

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "evals-recording-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

function recorder(dir: string, mode: FileRecorderOptions["mode"], pins: Record<string, string> = PINS) {
  return createFileRecorder({ dir, mode, pins });
}

function counter() {
  let calls = 0;
  return { produce: () => Promise.resolve({ value: ++calls, nested: { b: 2, a: 1 } }), calls: () => calls };
}

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for await (const site of Deno.readDir(dir)) {
    for await (const file of Deno.readDir(`${dir}/${site.name}`)) out.push(`${site.name}/${file.name}`);
  }
  return out.sort();
}

Deno.test("record writes once, then replay serves the same value without producing", async () => {
  await withDir(async (dir) => {
    const c = counter();
    const recorded = await recorder(dir, "record").call({ site: "evaluate", components: COMPONENTS }, c.produce);
    assertEquals(c.calls(), 1);

    const again = recorder(dir, "record");
    assertEquals(await again.call({ site: "evaluate", components: COMPONENTS }, c.produce), recorded);
    assertEquals(c.calls(), 1, "record mode reuses an existing recording");
    assertEquals(again.stats().replayed, 1);

    const replay = recorder(dir, "replay");
    const replayed = await replay.call({ site: "evaluate", components: { ...COMPONENTS } }, () => {
      throw new Error("replay must not produce");
    });
    assertEquals(replayed, recorded);
    assertEquals(replay.stats(), { replayed: 1, recorded: 0, live: 0, misses: [] });
  });
});

Deno.test("stored file holds sorted key components, sample and output", async () => {
  await withDir(async (dir) => {
    await recorder(dir, "record").call({ site: "embed", sample: 2, components: { b: 1, a: 2 } }, () => Promise.resolve([0.5]));
    const [file] = await listFiles(dir);
    const text = await Deno.readTextFile(`${dir}/${file}`);
    const stored = JSON.parse(text);
    assertEquals(Object.keys(stored), ["components", "format", "key", "output", "pins", "sample", "site"]);
    assertEquals(Object.keys(stored.components), ["a", "b"]);
    assertEquals(stored.format, RECORDING_FORMAT);
    assertEquals(stored.sample, 2);
    assertEquals(stored.pins, PINS);
    assertEquals(stored.output, [0.5]);
    assertEquals(file, `embed/${stored.key}.json`);
    assert(text.endsWith("}\n"));
  });
});

Deno.test("key changes with site, sample, pins, format-relevant components; not with key order", async () => {
  const base = await recordingKey(keyComponents({ site: "s", components: COMPONENTS }, PINS));
  const variants = [
    keyComponents({ site: "t", components: COMPONENTS }, PINS),
    keyComponents({ site: "s", sample: 1, components: COMPONENTS }, PINS),
    keyComponents({ site: "s", components: COMPONENTS }, { ...PINS, synthetic: "other" }),
    keyComponents({ site: "s", components: COMPONENTS }, { synthetic: "c0rpus" }),
    keyComponents({ site: "s", components: { ...COMPONENTS, model: "m2" } }, PINS),
    keyComponents({ site: "s", components: { ...COMPONENTS, schema: { name: "s", properties: { score: 2 } } } }, PINS),
    { ...keyComponents({ site: "s", components: COMPONENTS }, PINS), format: RECORDING_FORMAT + 1 },
  ];
  for (const v of variants) assertNotEquals(await recordingKey(v), base);

  const reordered = { input: "q", schema: { properties: { score: 1 }, name: "s" }, reasoningEffort: "low", model: "m1" };
  assertEquals(await recordingKey(keyComponents({ site: "s", sample: 0, components: reordered }, PINS)), base);
});

Deno.test("samples are separate recordings, each produced independently", async () => {
  await withDir(async (dir) => {
    const c = counter();
    const rec = recorder(dir, "record");
    const outputs = [];
    for (let sample = 0; sample < 3; sample++) {
      outputs.push(await rec.call({ site: "evaluate", sample, components: COMPONENTS }, c.produce));
    }
    assertEquals(outputs.map((o) => o.value), [1, 2, 3]);
    assertEquals((await listFiles(dir)).length, 3);
    assertEquals(rec.usedKeys().length, 3);
  });
});

Deno.test("replay miss names the differing component of the nearest recording", async () => {
  await withDir(async (dir) => {
    const rec = recorder(dir, "record");
    await rec.call({ site: "evaluate", components: COMPONENTS }, counter().produce);
    await rec.call({ site: "evaluate", components: { ...COMPONENTS, model: "x", input: "y", system: "z" } }, counter().produce);

    const replay = recorder(dir, "replay");
    const error = await assertRejects(
      () => replay.call({ site: "evaluate", components: { ...COMPONENTS, reasoningEffort: "high" } }, counter().produce),
      ReplayMissError,
    );
    assertEquals(error.diagnostic.nearest?.changes, [{ path: "components.reasoningEffort", kind: "changed" }]);
    assertStringIncludes(error.message, "components.reasoningEffort (changed)");
    assertEquals(replay.stats().misses.length, 1);
  });
});

Deno.test("replay miss reports pin and sample differences", async () => {
  await withDir(async (dir) => {
    await recorder(dir, "record").call({ site: "evaluate", components: COMPONENTS }, counter().produce);

    const stalePins = await assertRejects(
      () => recorder(dir, "replay", { ...PINS, "dataset.retrieval": "new" }).call({ site: "evaluate", components: COMPONENTS }, counter().produce),
      ReplayMissError,
    );
    assertEquals(stalePins.diagnostic.nearest?.changes, [{ path: "pins.dataset.retrieval", kind: "changed" }]);

    const newSample = await assertRejects(
      () => recorder(dir, "replay").call({ site: "evaluate", sample: 4, components: COMPONENTS }, counter().produce),
      ReplayMissError,
    );
    assertEquals(newSample.diagnostic.nearest?.changes, [{ path: "sample", kind: "changed" }]);
  });
});

Deno.test("replay miss on an unrecorded site says so", async () => {
  await withDir(async (dir) => {
    const error = await assertRejects(
      () => recorder(dir, "replay").call({ site: "judge", components: COMPONENTS }, counter().produce),
      ReplayMissError,
    );
    assertEquals(error.diagnostic.nearest, undefined);
    assertStringIncludes(error.message, "no recordings exist");
  });
});

Deno.test("live mode always produces and never touches the store", async () => {
  await withDir(async (dir) => {
    const c = counter();
    await recorder(dir, "record").call({ site: "evaluate", components: COMPONENTS }, c.produce);
    const live = recorder(dir, "live");
    const out = await live.call({ site: "evaluate", components: COMPONENTS }, c.produce);
    assertEquals(out.value, 2);
    assertEquals(live.stats().live, 1);
    assertEquals((await listFiles(dir)).length, 1);
  });
});

Deno.test("record returns the JSON round-trip so record and replay agree", async () => {
  await withDir(async (dir) => {
    const produce = () => Promise.resolve({ keep: 1, drop: undefined });
    const recorded = await recorder(dir, "record").call({ site: "s", components: {} }, produce);
    assertEquals(Object.keys(recorded), ["keep"]);
    assertEquals(await recorder(dir, "replay").call({ site: "s", components: {} }, produce), recorded);

    await assertRejects(() => recorder(dir, "record").call({ site: "u", components: {} }, () => Promise.resolve(undefined)), TypeError);
    await assertRejects(() => recorder(dir, "record").call({ site: "n", components: {} }, () => Promise.resolve(NaN)), TypeError);
  });
});

Deno.test("concurrent record calls for one key produce once", async () => {
  await withDir(async (dir) => {
    const c = counter();
    const rec = recorder(dir, "record");
    const [a, b] = await Promise.all([
      rec.call({ site: "s", components: COMPONENTS }, c.produce),
      rec.call({ site: "s", components: COMPONENTS }, c.produce),
    ]);
    assertEquals(a, b);
    assertEquals(c.calls(), 1);
  });
});

Deno.test("forPins injects only the named pins and shares stats", async () => {
  await withDir(async (dir) => {
    const root = recorder(dir, "record");
    const scoped = root.forPins(["synthetic"]);
    await scoped.call({ site: "s", components: COMPONENTS }, counter().produce);
    const [file] = await listFiles(dir);
    assertEquals(JSON.parse(await Deno.readTextFile(`${dir}/${file}`)).pins, { synthetic: "c0rpus" });
    assertEquals(root.stats().recorded, 1);

    const otherDataset = createFileRecorder({ dir, mode: "replay", pins: { ...PINS, "dataset.retrieval": "changed" } });
    await otherDataset.forPins(["synthetic"]).call({ site: "s", components: COMPONENTS }, counter().produce);
    assertThrows(() => root.forPins(["missing"]), Error, "unknown pin");
  });
});

Deno.test("hand-edited recordings are rejected", async () => {
  await withDir(async (dir) => {
    await recorder(dir, "record").call({ site: "s", components: COMPONENTS }, counter().produce);
    const [file] = await listFiles(dir);
    const stored = JSON.parse(await Deno.readTextFile(`${dir}/${file}`));
    stored.components.model = "edited";
    await Deno.writeTextFile(`${dir}/${file}`, JSON.stringify(stored));
    await assertRejects(
      () => recorder(dir, "replay").call({ site: "s", components: COMPONENTS }, counter().produce),
      Error,
      "corrupt",
    );
  });
});

Deno.test("invalid sites and samples are rejected before any I/O", async () => {
  await withDir(async (dir) => {
    for (const site of ["", "../escape", "a/b", "a b"]) {
      await assertRejects(() => recorder(dir, "record").call({ site, components: {} }, counter().produce), Error, "invalid site");
    }
    for (const sample of [-1, 1.5]) {
      await assertRejects(() => recorder(dir, "record").call({ site: "s", sample, components: {} }, counter().produce), Error, "sample");
    }
    assertEquals([...Deno.readDirSync(dir)].length, 0);
  });
});
