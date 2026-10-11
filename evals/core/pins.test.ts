import { assert, assertEquals, assertNotEquals, assertRejects, assertThrows } from "@std/assert";
import { computePins, hashContent, hashFiles, readPinsFile, recorderPins, updatePins, verifyPins, writePinsFile } from "./pins.ts";
import type { PinSpec } from "./types.ts";

const SPECS: PinSpec[] = [
  { id: "synthetic", kind: "corpus", files: ["corpus"] },
  { id: "dataset.cases", kind: "dataset", files: ["data/cases.json"] },
  { id: "recordings", kind: "recordings", files: ["recordings"] },
];
const META = { date: "2026-10-11T00:00:00.000Z", user: "Tester <t@example.com>", reason: "initial labels" };

async function withProject(fn: (dir: URL) => Promise<void>): Promise<void> {
  const path = await Deno.makeTempDir({ prefix: "evals-pins-" });
  const dir = new URL(`file:///${path.replace(/\\/g, "/").replace(/^\//, "")}/`);
  try {
    await Deno.mkdir(new URL("corpus/src/", dir), { recursive: true });
    await Deno.mkdir(new URL("data/", dir), { recursive: true });
    await Deno.mkdir(new URL("recordings/s/", dir), { recursive: true });
    await Deno.writeTextFile(new URL("corpus/src/a.ts", dir), "export const a = 1;\n");
    await Deno.writeTextFile(new URL("corpus/readme.md", dir), "# fixture\n");
    await Deno.writeTextFile(new URL("data/cases.json", dir), '[{"id":"c1"}]\n');
    await Deno.writeTextFile(new URL("recordings/s/k.json", dir), "{}\n");
    await fn(dir);
  } finally {
    await Deno.remove(path, { recursive: true });
  }
}

async function pinned(dir: URL) {
  return updatePins({ format: 1, pins: {} }, await computePins(dir, SPECS), "all", META).file;
}

Deno.test("hashContent folds CRLF to LF for text but not for binary", async () => {
  const enc = new TextEncoder();
  assertEquals(await hashContent(enc.encode("a\r\nb\r\n")), await hashContent(enc.encode("a\nb\n")));
  assertNotEquals(await hashContent(enc.encode("a\rb")), await hashContent(enc.encode("ab")));
  const binary = new Uint8Array([0, 0x0d, 0x0a]);
  assertNotEquals(await hashContent(binary), await hashContent(new Uint8Array([0, 0x0a])));
});

Deno.test("hashFiles walks directories, sorts paths and reports missing ones", async () => {
  await withProject(async (dir) => {
    const { files, missing } = await hashFiles(dir, ["corpus", "./data/cases.json", "nope.json"]);
    assertEquals(Object.keys(files), ["corpus/readme.md", "corpus/src/a.ts", "data/cases.json"]);
    assertEquals(missing, ["nope.json"]);
  });
});

Deno.test("hashFiles rejects paths that leave the project directory", async () => {
  await withProject(async (dir) => {
    for (const bad of ["../x", "/etc/passwd", "C:/x", "a/../../b", ""]) {
      await assertRejects(() => hashFiles(dir, [bad]), Error, "must be relative");
    }
  });
});

Deno.test("pin hash changes with content and with renames", async () => {
  await withProject(async (dir) => {
    const before = (await computePins(dir, SPECS))[0].hash;
    await Deno.writeTextFile(new URL("corpus/src/a.ts", dir), "export const a = 2;\n");
    const edited = (await computePins(dir, SPECS))[0].hash;
    assertNotEquals(edited, before);
    await Deno.rename(new URL("corpus/src/a.ts", dir), new URL("corpus/src/b.ts", dir));
    assertNotEquals((await computePins(dir, SPECS))[0].hash, edited);
  });
});

Deno.test("verifyPins passes when pins.json matches the files", async () => {
  await withProject(async (dir) => {
    const result = verifyPins(await computePins(dir, SPECS), await pinned(dir));
    assert(result.ok);
    assertEquals(result.checks.map((c) => c.status), ["ok", "ok", "ok"]);
  });
});

Deno.test("editing a dataset without updating pins.json fails integrity and names the file", async () => {
  await withProject(async (dir) => {
    const file = await pinned(dir);
    await Deno.writeTextFile(new URL("data/cases.json", dir), '[{"id":"c1"},{"id":"c2"}]\n');
    const result = verifyPins(await computePins(dir, SPECS), file);
    assertEquals(result.ok, false);
    const stale = result.checks.find((c) => c.id === "dataset.cases")!;
    assertEquals(stale.status, "stale");
    assertEquals(stale.files, [{ path: "data/cases.json", change: "changed" }]);
  });
});

Deno.test("record mode tolerates stale recordings but never stale datasets", async () => {
  await withProject(async (dir) => {
    const file = await pinned(dir);
    await Deno.writeTextFile(new URL("recordings/s/k2.json", dir), "{}\n");
    const computed = await computePins(dir, SPECS);
    assertEquals(verifyPins(computed, file).ok, false);
    const tolerant = verifyPins(computed, file, { tolerate: ["recordings"] });
    assert(tolerant.ok);
    assertEquals(tolerant.checks.find((c) => c.id === "recordings")?.files, [{ path: "recordings/s/k2.json", change: "added" }]);

    await Deno.writeTextFile(new URL("data/cases.json", dir), "[]\n");
    assertEquals(verifyPins(await computePins(dir, SPECS), file, { tolerate: ["recordings"] }).ok, false);
  });
});

Deno.test("unpinned, missing, empty and kind-changed pins fail; orphaned pins only warn", async () => {
  await withProject(async (dir) => {
    const file = await pinned(dir);
    await Deno.mkdir(new URL("empty/", dir));
    const specs: PinSpec[] = [
      { id: "synthetic", kind: "dataset", files: ["corpus"] },
      { id: "fresh", kind: "dataset", files: ["data/cases.json"] },
      { id: "gone", kind: "dataset", files: ["data/gone.json"] },
      { id: "hollow", kind: "dataset", files: ["empty"] },
    ];
    const result = verifyPins(await computePins(dir, specs), file);
    assertEquals(result.ok, false);
    assertEquals(
      result.checks.map((c) => [c.id, c.status, c.blocking]),
      [
        ["synthetic", "kind_changed", true],
        ["fresh", "unpinned", true],
        ["gone", "missing_files", true],
        ["hollow", "empty", true],
        ["dataset.cases", "orphaned", false],
        ["recordings", "orphaned", false],
      ],
    );
  });
});

Deno.test("updatePins bumps only changed pins and appends a changelog entry", async () => {
  await withProject(async (dir) => {
    const first = await pinned(dir);
    assertEquals(first.pins.synthetic.version, 1);
    assertEquals(first.pins.synthetic.changelog, [{ ...META, version: 1, hash: first.pins.synthetic.hash }]);

    await Deno.writeTextFile(new URL("data/cases.json", dir), "[]\n");
    const computed = await computePins(dir, SPECS);
    const { file, updates } = updatePins(first, computed, "all", { ...META, reason: "  relabel c1  " });
    assertEquals(updates.map((u) => [u.id, u.from?.version, u.to.version]), [["dataset.cases", 1, 2]]);
    assertEquals(file.pins["dataset.cases"].changelog.map((e) => [e.version, e.reason]), [[1, "initial labels"], [2, "relabel c1"]]);
    assertEquals(file.pins.synthetic, first.pins.synthetic);
    assert(verifyPins(computed, file).ok);

    assertEquals(updatePins(file, computed, ["synthetic"], META).updates, []);
  });
});

Deno.test("updatePins requires a reason and known, non-empty pins", async () => {
  await withProject(async (dir) => {
    const computed = await computePins(dir, SPECS);
    assertThrows(() => updatePins({ format: 1, pins: {} }, computed, "all", { ...META, reason: " " }), Error, "reason");
    assertThrows(() => updatePins({ format: 1, pins: {} }, computed, ["nope"], META), Error, "unknown pin");
    const missing = await computePins(dir, [{ id: "x", kind: "dataset", files: ["data/gone.json"] }]);
    assertThrows(() => updatePins({ format: 1, pins: {} }, missing, "all", META), Error, "missing files");
  });
});

Deno.test("recorderPins leaves out recordings pins", async () => {
  await withProject(async (dir) => {
    assertEquals(Object.keys(recorderPins(await computePins(dir, SPECS))), ["synthetic", "dataset.cases"]);
  });
});

Deno.test("pins.json round-trips with sorted keys, and a missing file reads as empty", async () => {
  await withProject(async (dir) => {
    const url = new URL("pins.json", dir);
    assertEquals(await readPinsFile(url), { format: 1, pins: {} });
    const file = await pinned(dir);
    await writePinsFile(url, file);
    assertEquals(await readPinsFile(url), file);
    const text = await Deno.readTextFile(url);
    assert(text.indexOf('"dataset.cases"') < text.indexOf('"recordings"'));
    await Deno.writeTextFile(url, '{"format":9,"pins":{}}');
    await assertRejects(() => readPinsFile(url), Error, "format");
  });
});

Deno.test("duplicate pin ids are rejected", async () => {
  await withProject(async (dir) => {
    await assertRejects(() => computePins(dir, [SPECS[0], SPECS[0]]), Error, "duplicate");
  });
});
