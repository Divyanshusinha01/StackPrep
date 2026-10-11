import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { type CliIo, EXIT, isCi, main, parseArgs } from "./cli.ts";
import type { Project } from "./types.ts";

interface Ctx {
  cases: Array<{ id: string; text: string }>;
}

/** A throwaway project: one corpus, one dataset, recordings, and a suite whose score comes from a recorded "model". */
function fakeProject(dir: URL, state: { model: (text: string) => number; produced: number; extraMetric?: boolean }): Project<Ctx> {
  return {
    id: "demo",
    pins: [
      { id: "synthetic", kind: "corpus", files: ["corpus"] },
      { id: "dataset.cases", kind: "dataset", files: ["data/cases.json"] },
      { id: "recordings", kind: "recordings", files: ["recordings"] },
    ],
    config: { model: "fake-1" },
    samples: 2,
    async setup() {
      return { cases: JSON.parse(await Deno.readTextFile(new URL("data/cases.json", dir))) };
    },
    suites: [{
      id: "alpha",
      pins: ["synthetic", "dataset.cases"],
      async run(ctx, env) {
        const scores: number[] = [];
        for (const c of ctx.cases) {
          for (let sample = 0; sample < env.samples; sample++) {
            scores.push(
              await env.recorder.call({ site: "score", sample, components: { model: "fake-1", input: c.text } }, () => {
                state.produced++;
                return Promise.resolve(state.model(c.text));
              }),
            );
          }
        }
        const value = scores.reduce((a, b) => a + b, 0) / scores.length;
        const metrics = [{
          id: "alpha.score",
          label: "Score",
          value,
          n: scores.length,
          direction: "higher_is_better" as const,
          provenance: "recorded_live" as const,
          corpus: "synthetic",
          gate: true,
        }];
        if (state.extraMetric) metrics.push({ ...metrics[0], id: "alpha.extra", gate: false });
        return { metrics, cases: ctx.cases.map((c) => ({ id: c.id, ok: true })), caveats: ["fake caveat"] };
      },
    }],
  };
}

interface Harness {
  dir: URL;
  out: string[];
  err: string[];
  env: Record<string, string>;
  confirmAnswer: boolean | undefined;
  state: { model: (text: string) => number; produced: number; extraMetric?: boolean };
  eval: (...args: string[]) => Promise<number>;
  read: (path: string) => Promise<string>;
  exists: (path: string) => Promise<boolean>;
}

async function withHarness(fn: (h: Harness) => Promise<void>): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "evals-cli-" });
  const rootUrl = new URL(`file:///${root.replace(/\\/g, "/").replace(/^\//, "")}/`);
  const dir = new URL("projects/demo/", rootUrl);
  await Deno.mkdir(new URL("corpus/", dir), { recursive: true });
  await Deno.mkdir(new URL("data/", dir), { recursive: true });
  await Deno.mkdir(new URL("recordings/", dir), { recursive: true });
  await Deno.writeTextFile(new URL("corpus/a.ts", dir), "export const a = 1;\n");
  await Deno.writeTextFile(new URL("data/cases.json", dir), JSON.stringify([{ id: "c1", text: "good" }, { id: "c2", text: "fine" }]));

  const h: Harness = {
    dir,
    out: [],
    err: [],
    env: {},
    confirmAnswer: true,
    state: { model: () => 0.8, produced: 0 },
    eval: (...args) => {
      const project = fakeProject(dir, h.state);
      const io: CliIo = {
        out: (t) => h.out.push(t),
        err: (t) => h.err.push(t),
        env: (name) => h.env[name],
        now: () => new Date("2026-10-11T06:00:00.000Z"),
        git: (args) => Promise.resolve(({ "config user.name": "Tester", "config user.email": "t@example.com", "rev-parse HEAD": "deadbeef", "status --porcelain": "" } as Record<string, string>)[args.join(" ")]),
        confirm: () => h.confirmAnswer,
      };
      return main(project, dir, args, io);
    },
    read: (path) => Deno.readTextFile(new URL(path, dir)),
    exists: async (path) => {
      try {
        await Deno.stat(new URL(path, dir));
        return true;
      } catch {
        return false;
      }
    },
  };
  try {
    await fn(h);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

const RESULTS = "../../results/demo/";

/** Pins, records, pins the recordings, and approves an initial baseline. */
async function bootstrap(h: Harness): Promise<void> {
  assertEquals(await h.eval("pin", "--pins", "all", "--reason", "initial fixture"), EXIT.ok);
  assertEquals(await h.eval("record"), EXIT.ok);
  assertEquals(await h.eval("pin", "--pins", "recordings", "--reason", "first recording"), EXIT.ok);
  assertEquals(await h.eval("run"), EXIT.ok);
  assertEquals(await h.eval("approve", "--metrics", "all", "--reason", "initial baseline"), EXIT.ok);
}

Deno.test("parseArgs handles values, equals form and booleans, and rejects unknowns", () => {
  const p = parseArgs(["approve", "--metrics=a,b", "--reason", "why", "--yes"]);
  assertEquals([p.command, p.flags.get("metrics"), p.flags.get("reason"), p.flags.get("yes")], ["approve", "a,b", "why", true]);
  for (const bad of [["run", "--nope"], ["run", "stray"], ["approve", "--reason"], ["run", "--yes=1"]]) {
    let threw = false;
    try {
      parseArgs(bad);
    } catch {
      threw = true;
    }
    assert(threw, bad.join(" "));
  }
});

Deno.test("isCi recognises CI environments", () => {
  assertEquals([isCi("true"), isCi("1"), isCi(undefined), isCi(""), isCi("false"), isCi("0")], [true, true, false, false, false, false]);
});

Deno.test("full flow: pin, record, replay, approve, then a regression fails the gate", async () => {
  await withHarness(async (h) => {
    await bootstrap(h);
    assertEquals(h.state.produced, 4, "K=2 samples for each of 2 cases, recorded once");
    const baseline = JSON.parse(await h.read("baseline.json"));
    assertEquals(baseline.metrics["alpha.score"].value, 0.8);
    assertEquals(baseline.approvals[0].user, "Tester <t@example.com>");
    assertEquals(baseline.approvals[0].gitSha, "deadbeef");
    assertEquals(baseline.approvals[0].samples, 2);
    assertEquals(baseline.approvals[0].config, { model: "fake-1" });
    assertEquals(baseline.approvals[0].pins.recordings.version, 2);

    h.state.model = () => {
      throw new Error("replay must not call the model");
    };
    assertEquals(await h.eval("run"), EXIT.ok);

    // A worse re-recording is a regression.
    await Deno.remove(new URL("recordings/", h.dir), { recursive: true });
    h.state.model = () => 0.4;
    assertEquals(await h.eval("record"), EXIT.regression);
    assertEquals(await h.eval("pin", "--pins", "recordings", "--reason", "re-record"), EXIT.ok);
    assertEquals(await h.eval("run"), EXIT.regression);
    assertStringIncludes(h.err.at(-1)!, "alpha.score (regression)");
    const report = await h.read(`${RESULTS}report.md`);
    assertStringIncludes(report, "- `alpha.score`: regression (0.8 to 0.4)");
  });
});

Deno.test("run never writes baseline.json, and writes byte-identical results on replay", async () => {
  await withHarness(async (h) => {
    assertEquals(await h.eval("pin", "--pins", "all", "--reason", "initial"), EXIT.ok);
    assertEquals(await h.eval("record"), EXIT.ok);
    assertEquals(await h.eval("pin", "--pins", "recordings", "--reason", "rec"), EXIT.ok);
    assertEquals(await h.eval("run", "--check-determinism"), EXIT.ok);
    const first = await h.read(`${RESULTS}latest.json`);
    const firstReport = await h.read(`${RESULTS}report.md`);
    assertEquals(await h.eval("run"), EXIT.ok);
    assertEquals(await h.read(`${RESULTS}latest.json`), first);
    assertEquals(await h.read(`${RESULTS}report.md`), firstReport);
    assertEquals(await h.exists("baseline.json"), false);
    assert(!first.includes("2026-10-11"), "no timestamps in results");
  });
});

Deno.test("editing a dataset without re-pinning fails integrity; a missing recording is a replay miss", async () => {
  await withHarness(async (h) => {
    await bootstrap(h);
    const original = await h.read("data/cases.json");
    await Deno.writeTextFile(new URL("data/cases.json", h.dir), JSON.stringify([{ id: "c1", text: "edited" }]));
    assertEquals(await h.eval("run"), EXIT.integrity);
    assertEquals(await h.eval("verify"), EXIT.integrity);
    assert(h.err.some((l) => l.includes("dataset.cases: stale")));

    assertEquals(await h.eval("pin", "--pins", "dataset.cases", "--reason", "new case text"), EXIT.ok);
    assertEquals(await h.eval("run"), EXIT.replayMiss);
    assert(h.err.some((l) => l.includes('replay miss at site "score"') && l.includes("pins.dataset.cases (changed)")));

    await Deno.writeTextFile(new URL("data/cases.json", h.dir), original);
    assertEquals(await h.eval("pin", "--pins", "dataset.cases", "--reason", "revert"), EXIT.ok);
    assertEquals(await h.eval("verify"), EXIT.ok);
  });
});

Deno.test("approve refuses in CI, without a reason, on pin drift, and without confirmation", async () => {
  await withHarness(async (h) => {
    await bootstrap(h);
    const before = await h.read("baseline.json");

    h.env.CI = "true";
    assertEquals(await h.eval("approve", "--metrics", "all", "--reason", "x"), EXIT.refused);
    assertEquals(await h.eval("pin", "--pins", "all", "--reason", "x"), EXIT.refused);
    delete h.env.CI;

    assertEquals(await h.eval("approve", "--metrics", "all"), EXIT.refused);
    assertEquals(await h.eval("approve", "--reason", "x"), EXIT.usage);

    await Deno.writeTextFile(new URL("corpus/a.ts", h.dir), "export const a = 2;\n");
    assertEquals(await h.eval("approve", "--metrics", "all", "--reason", "x"), EXIT.refused);
    assertStringIncludes(h.err.at(-1)!, "pins on disk do not match");
    await Deno.writeTextFile(new URL("corpus/a.ts", h.dir), "export const a = 1;\n");

    h.confirmAnswer = false;
    assertEquals(await h.eval("approve", "--metrics", "all", "--reason", "x"), EXIT.refused);
    h.confirmAnswer = undefined;
    assertEquals(await h.eval("approve", "--metrics", "all", "--reason", "x"), EXIT.refused);
    assertStringIncludes(h.err.at(-1)!, "--yes");

    assertEquals(await h.read("baseline.json"), before);
    assertEquals(await h.eval("approve", "--metrics", "all", "--reason", "scripted", "--yes"), EXIT.ok);
    assertEquals(JSON.parse(await h.read("baseline.json")).approvals.length, 2);
  });
});

Deno.test("approve after a regression needs --allow-regression", async () => {
  await withHarness(async (h) => {
    await bootstrap(h);
    await Deno.remove(new URL("recordings/", h.dir), { recursive: true });
    h.state.model = () => 0.1;
    await h.eval("record");
    await h.eval("pin", "--pins", "recordings", "--reason", "re-record");
    assertEquals(await h.eval("run"), EXIT.regression);

    assertEquals(await h.eval("approve", "--metrics", "alpha.score", "--reason", "accept"), EXIT.refused);
    assertStringIncludes(h.err.at(-1)!, "--allow-regression");
    assertEquals(await h.eval("approve", "--metrics", "alpha.score", "--reason", "model swap trades score for cost", "--allow-regression"), EXIT.ok);
    assertEquals(await h.eval("run"), EXIT.ok);
  });
});

Deno.test("approve refuses results recorded before the recordings were pinned", async () => {
  await withHarness(async (h) => {
    await bootstrap(h);
    h.state.extraMetric = true;
    h.state.model = () => 0.9;
    await Deno.remove(new URL("recordings/", h.dir), { recursive: true });
    await h.eval("record");
    await h.eval("pin", "--pins", "recordings", "--reason", "re-record");
    assertEquals(await h.eval("approve", "--metrics", "all", "--reason", "x"), EXIT.refused);
    assertStringIncludes(h.err.at(-1)!, "different pins");
  });
});

Deno.test("compare prints deltas and caveats; a suite filter only compares suites that ran", async () => {
  await withHarness(async (h) => {
    await bootstrap(h);
    h.out.length = 0;
    assertEquals(await h.eval("compare"), EXIT.ok);
    const text = h.out.join("\n");
    assertStringIncludes(text, "## Comparison with baseline");
    assertStringIncludes(text, "| `alpha.score` | synthetic | 0.8 | 0.8 |");
    assertStringIncludes(text, "alpha: fake caveat");

    assertEquals(await h.eval("run", "--suite", "nope"), EXIT.usage);
  });
});

Deno.test("compare without results asks for a run; help prints usage", async () => {
  await withHarness(async (h) => {
    assertEquals(await h.eval("compare"), EXIT.usage);
    assertStringIncludes(h.err.at(-1)!, 'run "eval run" first');
    assertEquals(await h.eval("help"), EXIT.ok);
    assertStringIncludes(h.out.at(-1)!, "Exit codes");
  });
});
