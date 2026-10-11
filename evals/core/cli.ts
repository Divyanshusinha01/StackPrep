import { approve, ApprovalError, compare, readBaseline, writeBaseline } from "./baseline.ts";
import { computePins, describeCheck, readPinsFile, updatePins, verifyPins, writePinsFile } from "./pins.ts";
import { readResults, renderComparison, renderReport, resultsJson } from "./report.ts";
import { RunConfigError, runProject, urlToPath } from "./runner.ts";
import type { EvalMode, Project } from "./types.ts";

/** Exit codes CI relies on. When several apply, run reports the first of integrity, replay miss, suite error, nondeterminism, regression. */
export const EXIT = {
  ok: 0,
  regression: 1,
  integrity: 2,
  replayMiss: 3,
  suiteError: 4,
  nondeterministic: 5,
  refused: 6,
  usage: 64,
} as const;

const USAGE = `eval <command> [options]

Commands:
  run        Replay recorded outputs (no network, no API key). Writes latest.json and report.md.
             Fails on a regression against baseline.json, a pin mismatch, a replay miss or a suite error.
  record     Like run, but records any missing model output. Re-pin recordings afterwards.
  live       Calls models without reading or writing recordings. Not approvable.
  compare    Prints latest.json against baseline.json: deltas, intervals, statuses, pin and config changes.
  approve    The only command that writes baseline.json. Refuses in CI and on pin mismatch.
  pin        Records the current hashes of pins in pins.json, bumping versions with a changelog entry.
  verify     Checks pins only (datasets, corpora, recordings) against pins.json.

Options:
  --suite <a,b>            run, record, live: run only these suites
  --seed <n>               run, record, live: bootstrap and sampling seed (default 1)
  --samples <k>            run, record, live: K samples per live-captured case (default from the project)
  --check-determinism      run: run twice and fail unless latest.json is byte-identical
  --out <dir>              where latest.json and report.md live (default evals/results/<project>)
  --metrics <ids|all>      approve: comma-separated metric ids, or all
  --pins <ids|all>         pin: comma-separated pin ids, or all
  --reason "<text>"        approve, pin: required explanation, stored in the history
  --allow-regression       approve: accept worse, removed or incompatible metrics
  --yes                    approve: skip the confirmation prompt

Exit codes: 0 ok, 1 regression, 2 pin integrity, 3 replay miss, 4 suite error, 5 nondeterministic,
6 refused, 64 usage.`;

const BOOLEAN_FLAGS = new Set(["check-determinism", "allow-regression", "yes", "help"]);
const VALUE_FLAGS = new Set(["suite", "seed", "samples", "out", "metrics", "pins", "reason"]);

interface Parsed {
  command: string;
  flags: Map<string, string | true>;
}

class UsageError extends Error {}

export function parseArgs(args: readonly string[]): Parsed {
  const [command = "help", ...rest] = args;
  const flags = new Map<string, string | true>();
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg.startsWith("--")) throw new UsageError(`unexpected argument "${arg}"`);
    const eq = arg.indexOf("=");
    const name = arg.slice(2, eq === -1 ? undefined : eq);
    if (BOOLEAN_FLAGS.has(name)) {
      if (eq !== -1) throw new UsageError(`--${name} takes no value`);
      flags.set(name, true);
    } else if (VALUE_FLAGS.has(name)) {
      const value = eq === -1 ? rest[++i] : arg.slice(eq + 1);
      if (value === undefined || (eq === -1 && value.startsWith("--"))) throw new UsageError(`--${name} needs a value`);
      flags.set(name, value);
    } else {
      throw new UsageError(`unknown option --${name}`);
    }
  }
  return { command, flags };
}

function str(p: Parsed, name: string): string | undefined {
  const v = p.flags.get(name);
  return typeof v === "string" ? v : undefined;
}

function list(p: Parsed, name: string): string[] | "all" | undefined {
  const v = str(p, name);
  if (v === undefined) return undefined;
  if (v.trim() === "all") return "all";
  const ids = v.split(",").map((s) => s.trim()).filter(Boolean);
  if (ids.length === 0) throw new UsageError(`--${name} is empty`);
  return ids;
}

function int(p: Parsed, name: string, fallback: number, min: number): number {
  const v = str(p, name);
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min) throw new UsageError(`--${name} must be an integer >= ${min}`);
  return n;
}

/** CI providers set CI=true (or 1); anything else non-empty except false/0 is treated as CI too. */
export function isCi(value: string | undefined): boolean {
  return value !== undefined && value !== "" && value !== "false" && value !== "0";
}

/** Process-level effects, injectable so the CLI can be tested without git, a TTY or a real clock. */
export interface CliIo {
  out: (text: string) => void;
  err: (text: string) => void;
  env: (name: string) => string | undefined;
  now: () => Date;
  git: (args: string[]) => Promise<string | undefined>;
  confirm: (question: string) => boolean | undefined;
}

export const defaultIo: CliIo = {
  out: (text) => console.log(text),
  err: (text) => console.error(text),
  env: (name) => Deno.env.get(name),
  now: () => new Date(),
  git: async (args) => {
    try {
      const { success, stdout } = await new Deno.Command("git", { args, stdout: "piped", stderr: "null" }).output();
      return success ? new TextDecoder().decode(stdout).trim() : undefined;
    } catch {
      return undefined;
    }
  },
  confirm: (question) => (Deno.stdin.isTerminal() ? confirm(question) : undefined),
};

/**
 * Entry point. A project calls this from a small module that imports its Project statically, e.g.
 * `if (import.meta.main) Deno.exit(await main(project, new URL(".", import.meta.url), Deno.args));`
 */
export async function main<Ctx>(
  project: Project<Ctx>,
  projectDir: URL,
  args: readonly string[],
  io: CliIo = defaultIo,
): Promise<number> {
  let parsed: Parsed;
  try {
    parsed = parseArgs(args);
  } catch (error) {
    io.err(`${(error as Error).message}\n\n${USAGE}`);
    return EXIT.usage;
  }
  if (parsed.flags.has("help") || parsed.command === "help") {
    io.out(USAGE);
    return EXIT.ok;
  }
  const out = str(parsed, "out");
  const outDir = out ? dirUrl(out) : new URL(`../../results/${project.id}/`, projectDir);
  const ctx: CommandContext<Ctx> = { project, projectDir, outDir, parsed, io };
  try {
    switch (parsed.command) {
      case "run":
        return await runCommand(ctx, "replay");
      case "record":
        return await runCommand(ctx, "record");
      case "live":
        return await runCommand(ctx, "live");
      case "compare":
        return await compareCommand(ctx);
      case "approve":
        return await approveCommand(ctx);
      case "pin":
        return await pinCommand(ctx);
      case "verify":
        return await verifyCommand(ctx);
      default:
        throw new UsageError(`unknown command "${parsed.command}"`);
    }
  } catch (error) {
    if (error instanceof UsageError || error instanceof RunConfigError) {
      io.err(`${error.message}\n\n${USAGE}`);
      return EXIT.usage;
    }
    if (error instanceof ApprovalError) {
      io.err(`refused: ${error.message}`);
      return EXIT.refused;
    }
    throw error;
  }
}

/** A directory path (absolute, or relative to the working directory) as a file URL ending in a slash. */
function dirUrl(path: string): URL {
  const p = path.replace(/\\/g, "/").replace(/\/?$/, "/");
  if (/^[A-Za-z]:\//.test(p)) return new URL(`file:///${p}`);
  if (p.startsWith("/")) return new URL(`file://${p}`);
  const cwd = Deno.cwd().replace(/\\/g, "/");
  return new URL(p, cwd.startsWith("/") ? `file://${cwd}/` : `file:///${cwd}/`);
}

interface CommandContext<Ctx> {
  project: Project<Ctx>;
  projectDir: URL;
  outDir: URL;
  parsed: Parsed;
  io: CliIo;
}

async function runCommand<Ctx>(c: CommandContext<Ctx>, mode: EvalMode): Promise<number> {
  const { project, parsed, io } = c;
  const suitesFlag = list(parsed, "suite");
  if (suitesFlag === "all") throw new UsageError("--suite takes suite ids; omit it to run every suite");
  if (parsed.flags.has("check-determinism") && mode !== "replay") throw new UsageError("--check-determinism applies to run (replay) only");
  const options = {
    projectDir: c.projectDir,
    mode,
    seed: int(parsed, "seed", 1, 0),
    samples: int(parsed, "samples", project.samples ?? 1, 1),
    suites: suitesFlag,
    log: (line: string) => io.err(line),
  };

  const results = await runProject(project, options);
  const json = resultsJson(results);
  let nondeterministic = false;
  if (parsed.flags.has("check-determinism")) {
    const again = resultsJson(await runProject(project, options));
    nondeterministic = again !== json;
    if (nondeterministic) io.err("determinism check failed: two replays produced different latest.json");
  }

  const baseline = await readBaseline(new URL("baseline.json", c.projectDir));
  const comparison = compare(results, baseline);
  await Deno.mkdir(c.outDir, { recursive: true });
  await Deno.writeTextFile(new URL("latest.json", c.outDir), json);
  await Deno.writeTextFile(new URL("report.md", c.outDir), renderReport(results, comparison));

  io.out(renderComparison(comparison));
  io.out(`Wrote ${urlToPath(new URL("latest.json", c.outDir))} and report.md`);
  for (const p of results.integrity.problems) io.err(`pin problem: ${p}`);
  for (const w of results.integrity.warnings) io.err(`pin warning: ${w}`);
  for (const m of results.recordings.misses) io.err(m);
  if (results.error) io.err(results.error);
  for (const s of results.suites.filter((s) => s.status === "error")) io.err(`suite ${s.id} failed: ${s.error}`);
  if (mode === "record" && results.recordings.recorded > 0) {
    io.err(`recorded ${results.recordings.recorded} new output(s); review them, then run "eval pin --pins <recordings pin> --reason ..."`);
  }

  if (!results.integrity.ok) return EXIT.integrity;
  if (results.recordings.misses.length > 0) return EXIT.replayMiss;
  if (results.error || results.suites.some((s) => s.status === "error")) return EXIT.suiteError;
  if (nondeterministic) return EXIT.nondeterministic;
  if (comparison.blocking.length > 0) {
    io.err(`${comparison.blocking.length} blocking change(s) against baseline.json: ${comparison.blocking.map((m) => `${m.id} (${m.status})`).join(", ")}`);
    return EXIT.regression;
  }
  return EXIT.ok;
}

async function loadLatest<Ctx>(c: CommandContext<Ctx>) {
  const url = new URL("latest.json", c.outDir);
  try {
    return await readResults(url);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) throw new UsageError(`no results at ${urlToPath(url)}; run "eval run" first`);
    throw error;
  }
}

async function compareCommand<Ctx>(c: CommandContext<Ctx>): Promise<number> {
  const results = await loadLatest(c);
  const comparison = compare(results, await readBaseline(new URL("baseline.json", c.projectDir)));
  c.io.out(renderComparison(comparison));
  const caveats = results.suites.flatMap((s) => s.caveats.map((text) => `- ${s.id}: ${text}`));
  if (caveats.length > 0) c.io.out(`Caveats (including unlabelled coverage):\n\n${caveats.join("\n")}\n`);
  if (!results.integrity.ok) c.io.out(`These results failed pin integrity:\n${results.integrity.problems.map((p) => `- ${p}`).join("\n")}`);
  return EXIT.ok;
}

async function approveCommand<Ctx>(c: CommandContext<Ctx>): Promise<number> {
  const { parsed, io } = c;
  if (isCi(io.env("CI"))) throw new ApprovalError("eval approve refuses to run in CI; baselines change only through a reviewed local approval");
  const metrics = list(parsed, "metrics");
  if (!metrics) throw new UsageError('approve needs --metrics <ids|all> and --reason "<text>"');
  const reason = str(parsed, "reason") ?? "";

  const results = await loadLatest(c);
  const computed = await computePins(c.projectDir, c.project.pins);
  const verification = verifyPins(computed, await readPinsFile(new URL("pins.json", c.projectDir)));
  if (!verification.ok) {
    throw new ApprovalError(`pins on disk do not match pins.json: ${verification.checks.filter((x) => x.blocking).map(describeCheck).join("; ")}`);
  }
  const baselineUrl = new URL("baseline.json", c.projectDir);
  const baseline = await readBaseline(baselineUrl);
  const outcome = approve(results, baseline, {
    metrics,
    reason,
    allowRegression: parsed.flags.has("allow-regression"),
    ci: false,
    currentPins: Object.fromEntries(computed.map((p) => [p.id, p.hash])),
    date: io.now().toISOString(),
    user: await gitUser(io),
    gitSha: (await io.git(["rev-parse", "HEAD"])) ?? "unknown",
    gitDirty: ((await io.git(["status", "--porcelain"])) ?? "") !== "",
  });

  io.out(renderComparison(compare(results, baseline), { onlyIds: outcome.selected.map((m) => m.id) }));
  io.out(`Approving ${outcome.selected.length} metric(s) as ${outcome.approval.user} at ${outcome.approval.gitSha.slice(0, 12)}${outcome.approval.gitDirty ? " (uncommitted changes)" : ""}.`);
  io.out(`Reason: ${outcome.approval.reason}`);
  if (!parsed.flags.has("yes")) {
    const answer = io.confirm("Write baseline.json?");
    if (answer === undefined) throw new ApprovalError("no terminal to confirm on; re-run interactively or pass --yes");
    if (!answer) {
      io.err("Not approved; baseline.json unchanged.");
      return EXIT.refused;
    }
  }
  await writeBaseline(baselineUrl, outcome.baseline);
  io.out(`Wrote ${urlToPath(baselineUrl)}. Review and commit it yourself.`);
  return EXIT.ok;
}

async function pinCommand<Ctx>(c: CommandContext<Ctx>): Promise<number> {
  const { parsed, io } = c;
  if (isCi(io.env("CI"))) throw new ApprovalError("eval pin refuses to run in CI; pins change only through a reviewed local update");
  const ids = list(parsed, "pins");
  if (!ids) throw new UsageError('pin needs --pins <ids|all> and --reason "<text>"');
  const reason = str(parsed, "reason") ?? "";
  if (!reason.trim()) throw new UsageError('pin needs --reason "<what changed and why>"');

  const url = new URL("pins.json", c.projectDir);
  const computed = await computePins(c.projectDir, c.project.pins);
  let next;
  try {
    next = updatePins(await readPinsFile(url), computed, ids, { date: io.now().toISOString(), user: await gitUser(io), reason });
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
  if (next.updates.length === 0) {
    io.out("Nothing changed; pins.json is current.");
    return EXIT.ok;
  }
  await writePinsFile(url, next.file);
  for (const u of next.updates) {
    const from = u.from ? `v${u.from.version}` : "unpinned";
    io.out(`${u.id}: ${from} to v${u.to.version} (${u.files.length} file change(s))`);
  }
  io.out("Recordings keyed on changed corpora or datasets must be re-recorded, and affected metrics re-approved.");
  return EXIT.ok;
}

async function verifyCommand<Ctx>(c: CommandContext<Ctx>): Promise<number> {
  const computed = await computePins(c.projectDir, c.project.pins);
  const verification = verifyPins(computed, await readPinsFile(new URL("pins.json", c.projectDir)));
  for (const check of verification.checks) (check.blocking ? c.io.err : c.io.out)(describeCheck(check));
  return verification.ok ? EXIT.ok : EXIT.integrity;
}

async function gitUser(io: CliIo): Promise<string> {
  const name = await io.git(["config", "user.name"]);
  const email = await io.git(["config", "user.email"]);
  if (!name && !email) return "unknown";
  return email ? `${name ?? ""} <${email}>`.trim() : name!;
}
