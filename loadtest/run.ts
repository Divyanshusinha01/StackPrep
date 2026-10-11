// Orchestrates the pinned interview-events load test on the local Supabase stack.
//
//   deno task build-k6                       # once: k6 + xk6-sse into loadtest/bin
//   deno task baseline                       # every stage x runsPerStage, then summarize
//
// Needs `supabase start`; stop any `supabase functions serve` first, since the harness manages the
// edge runtime container itself (see EdgeTemplate).
// Each run: `supabase db reset`, a fresh edge runtime container (so every run starts from the same
// state), pin container CPU/memory, seed N interviews, warm the function,
// run k6 (readers + writers on one wall clock), sample docker stats and pg_stat_activity during
// the hold window, diff pg_stat_statements across it, then save raw files and metrics.json.
// Flags: --out <dir> (relative to loadtest/), --stages 10,25 --runs 1 (smoke only; results
// produced with overrides are not comparable), --no-reset, --no-extension, --transport <name>.
import { join } from "@std/path";
import postgres from "postgres";
import { analyzeRun, type DbRows, type K6Record, type RunInput, type Sample, type StatementDelta } from "./analyze.ts";
import {
  LOADTEST_DIR,
  LOCAL,
  loadConfig,
  npx,
  readJson,
  run,
  type Schedule,
  type SeededInterview,
  sleep,
  supabaseStatus,
  writeJson,
} from "./lib.ts";
import { seedInterviews } from "./seed.ts";
import { summarize } from "./summarize.ts";

const STREAM_LIFETIME_MS = 140_000;

function flag(name: string): string | undefined {
  const i = Deno.args.indexOf(`--${name}`);
  return i >= 0 ? Deno.args[i + 1] : undefined;
}
const has = (name: string) => Deno.args.includes(`--${name}`);

const config = await loadConfig();
const schedule = await readJson<Schedule>(join(LOADTEST_DIR, "schedule.json"));
const transport = flag("transport") ?? "sse";
const outDir = join(LOADTEST_DIR, flag("out") ?? `results/${transport}`);
const stages = flag("stages")?.split(",").map(Number) ?? config.stages;
const runsPerStage = Number(flag("runs") ?? config.runsPerStage);
const reset = !has("no-reset");
const overridden = flag("stages") !== undefined || flag("runs") !== undefined || !reset;
const k6Bin = join(LOADTEST_DIR, "bin", Deno.build.os === "windows" ? "k6.exe" : "k6");
const tmpDir = join(LOADTEST_DIR, ".tmp");
const containers = Object.keys(config.containers);
const { warmupMs, holdMs, startDelayMs, connectRampMs, drainMs } = config.timing;

if (transport !== "sse") {
  throw new Error(`transport "${transport}" is not implemented in the harness yet`);
}
await Deno.stat(k6Bin).catch(() => {
  throw new Error(`missing ${k6Bin}; run \`deno task build-k6\` first`);
});

function log(message: string) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

async function docker(args: string[], allowFailure = false) {
  return (await run("docker", args, { allowFailure })).stdout.trim();
}

/** Applies config.json limits and returns what Docker reports back. */
async function pinContainers(): Promise<Record<string, { nanoCpus: number; memoryBytes: number }>> {
  const applied: Record<string, { nanoCpus: number; memoryBytes: number }> = {};
  for (const [name, limit] of Object.entries(config.containers)) {
    await docker(["update", "--cpus", String(limit.cpus), "--memory", limit.memory, "--memory-swap", limit.memory, name]);
    const [nanoCpus, memoryBytes] = (await docker(["inspect", "-f", "{{.HostConfig.NanoCpus}} {{.HostConfig.Memory}}", name]))
      .split(" ").map(Number);
    if (nanoCpus !== limit.cpus * 1e9) {
      throw new Error(`${name}: CPU limit did not apply (${nanoCpus})`);
    }
    applied[name] = { nanoCpus, memoryBytes };
  }
  return applied;
}

const EDGE_CONTAINER = "supabase_edge_runtime_stackprep";
/**
 * The CLI main service (edge-runtime v1.77.1, CLI 2.119.0) gives each user worker a 1 s soft and
 * 2 s hard CPU limit, accumulated over every request the worker serves (minified as `b`, `E`).
 */
const EDGE_CPU_LIMITS_PATTERN = /\bb=1e3,E=2e3\b/;
/** `--edge-cpu-limit-ms soft,hard`: diagnostic only; the baseline uses the CLI defaults. */
const edgeCpuLimits = flag("edge-cpu-limit-ms")?.split(",").map(Number) as [number, number] | undefined;

/**
 * The edge runtime container as `supabase functions serve` configures it. The CLI restarts the
 * runtime whenever its file watcher fires, and on Windows with NTFS last-access updates enabled a
 * worker boot (reading the module graph through the bind mount) is enough to fire it. A restart
 * kills every open stream, so runs use this captured configuration without the watcher.
 */
interface EdgeTemplate {
  image: string;
  entrypoint: string[];
  cmd: string[];
  workingDir: string;
  binds: string[];
  network: string;
  aliases: string[];
  labels: Record<string, string>;
  /** Kept in memory only; it holds the function secrets from supabase/functions/.env. */
  env: Record<string, string>;
  mainServiceDir: string;
}

async function healthy(): Promise<boolean> {
  const res = await fetch(`${LOCAL.apiUrl}/functions/v1/health`).catch(() => null);
  await res?.body?.cancel();
  return res?.status === 200;
}

async function captureEdgeTemplate(): Promise<EdgeTemplate> {
  await docker(["rm", "-f", EDGE_CONTAINER], true);
  const child = new Deno.Command(npx(), {
    args: ["supabase", "functions", "serve", "--env-file", "supabase/functions/.env"],
    cwd: join(LOADTEST_DIR, ".."),
    stdout: "null",
    stderr: "null",
  }).spawn();
  try {
    await waitFor("supabase functions serve", healthy);
    const [info] = JSON.parse(await docker(["inspect", EDGE_CONTAINER]));
    const mainServiceDir = join(tmpDir, "edge-main");
    await Deno.remove(mainServiceDir, { recursive: true }).catch(() => {});
    await Deno.mkdir(mainServiceDir, { recursive: true });
    // Only the bundled main service; /root/.cache/deno is a volume and stays mounted.
    const mainService = join(mainServiceDir, "index.ts");
    await docker(["cp", `${EDGE_CONTAINER}:/root/index.ts`, mainService]);
    if (edgeCpuLimits) {
      const source = await Deno.readTextFile(mainService);
      const matches = source.match(new RegExp(EDGE_CPU_LIMITS_PATTERN.source, "g")) ?? [];
      if (matches.length !== 1) {
        throw new Error(`expected one worker CPU limit assignment in the main service, found ${matches.length}`);
      }
      await Deno.writeTextFile(mainService, source.replace(EDGE_CPU_LIMITS_PATTERN, `b=${edgeCpuLimits[0]},E=${edgeCpuLimits[1]}`));
    }
    const network = info.HostConfig.NetworkMode as string;
    return {
      image: info.Config.Image,
      entrypoint: info.Config.Entrypoint ?? [],
      cmd: info.Config.Cmd ?? [],
      workingDir: info.Config.WorkingDir,
      binds: info.HostConfig.Binds ?? [],
      network,
      aliases: (info.NetworkSettings.Networks[network]?.Aliases ?? []).filter((a: string) => a !== info.Config.Hostname),
      labels: info.Config.Labels ?? {},
      // PATH stays the image default; passing it through would also replace the host's PATH for `docker`.
      env: Object.fromEntries(
        (info.Config.Env as string[]).map((e) => [e.slice(0, e.indexOf("=")), e.slice(e.indexOf("=") + 1)]).filter(([k]) => k !== "PATH"),
      ),
      mainServiceDir,
    };
  } finally {
    if (Deno.build.os === "windows") {
      await run("taskkill", ["/PID", String(child.pid), "/T", "/F"], { allowFailure: true });
    } else {
      child.kill("SIGTERM");
    }
    await child.status.catch(() => {});
    await docker(["rm", "-f", EDGE_CONTAINER], true);
  }
}

/** A fresh edge runtime container per run, created with its CPU and memory limits. */
async function startEdgeRuntime(t: EdgeTemplate): Promise<void> {
  await docker(["rm", "-f", EDGE_CONTAINER], true);
  const limit = config.containers[EDGE_CONTAINER];
  const args = [
    "create",
    "--name",
    EDGE_CONTAINER,
    "--network",
    t.network,
    ...t.aliases.flatMap((a) => ["--network-alias", a]),
    ...Object.entries(t.labels).flatMap(([k, v]) => ["--label", `${k}=${v}`]),
    ...t.binds.flatMap((b) => ["-v", b]),
    // Values come from this process's environment, so secrets never appear in arguments or files.
    ...Object.keys(t.env).flatMap((k) => ["-e", k]),
    "--cpus",
    String(limit.cpus),
    "--memory",
    limit.memory,
    "--memory-swap",
    limit.memory,
    "-w",
    t.workingDir,
    "--entrypoint",
    t.entrypoint[0],
    t.image,
    ...t.entrypoint.slice(1),
    ...t.cmd,
  ];
  const created = await new Deno.Command("docker", { args, env: t.env, stdout: "piped", stderr: "piped" }).output();
  if (created.code !== 0) {
    throw new Error(`docker create edge runtime failed: ${new TextDecoder().decode(created.stderr)}`);
  }
  await docker(["cp", join(t.mainServiceDir, "index.ts"), `${EDGE_CONTAINER}:/root/index.ts`]);
  await docker(["start", EDGE_CONTAINER]);
  await waitFor("edge runtime", healthy);
}

async function edgeRuntimeState(): Promise<{ running: boolean; oomKilled: boolean; exitCode: number; restarts: number } | null> {
  const out = await docker(["inspect", "-f", "{{.State.Running}} {{.State.OOMKilled}} {{.State.ExitCode}} {{.RestartCount}}", EDGE_CONTAINER], true);
  const [running, oom, exit, restarts] = out.split(" ");
  return running === undefined || out.includes("No such") ? null : {
    running: running === "true",
    oomKilled: oom === "true",
    exitCode: Number(exit),
    restarts: Number(restarts),
  };
}

async function waitFor(what: string, check: () => Promise<boolean>, timeoutMs = 120_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await check().catch(() => false)) {
      return;
    }
    await sleep(2_000);
  }
  throw new Error(`timed out waiting for ${what}`);
}

function parseMiB(value: string): number {
  const m = value.trim().match(/^([\d.]+)\s*([KMG]i?B|B)$/i);
  if (!m) {
    return NaN;
  }
  const n = Number(m[1]);
  const unit = m[2].toUpperCase();
  return unit.startsWith("G") ? n * 1024 : unit.startsWith("M") ? n : unit.startsWith("K") ? n / 1024 : n / 1048576;
}

/** docker stats and pg_stat_activity every ~2 s until `stop` resolves. */
async function sampleResources(sql: postgres.Sql, file: string, stop: Promise<void>) {
  let stopped = false;
  stop.then(() => (stopped = true));
  const lines: string[] = [];
  while (!stopped) {
    const t = Date.now();
    const [statsOut, [pg]] = await Promise.all([
      docker(["stats", "--no-stream", "--format", "{{json .}}", ...containers], true),
      sql`
        select count(*) filter (where state = 'active' and pid <> pg_backend_pid())::int as active,
               count(*)::int as total
        from pg_stat_activity where datname = 'postgres'`,
    ]);
    const sample: Sample = { t, containers: {}, pg: { active: pg.active, total: pg.total } };
    for (const line of statsOut.split("\n").filter((l) => l.startsWith("{"))) {
      const s = JSON.parse(line);
      sample.containers[s.Name] = { cpuPct: parseFloat(s.CPUPerc), memMiB: parseMiB(String(s.MemUsage).split("/")[0]) };
    }
    lines.push(JSON.stringify(sample));
    await sleep(Math.max(0, 2_000 - (Date.now() - t)));
  }
  await Deno.writeTextFile(file, lines.join("\n") + "\n");
}

interface StatementRow {
  queryid: string;
  query: string;
  calls: number;
  total_exec_time: number;
}

async function snapshotStatements(sql: postgres.Sql): Promise<Map<string, StatementRow>> {
  const rows = await sql<StatementRow[]>`
    select queryid::text, query, calls::float8 as calls, total_exec_time
    from extensions.pg_stat_statements s
    join pg_database d on d.oid = s.dbid
    where d.datname = 'postgres'`;
  return new Map(rows.map((r) => [`${r.queryid}`, r]));
}

function categorize(query: string): string {
  const q = query.toLowerCase();
  if (/^\s*(with pgrst_source as \(\s*)?select/.test(q) || q.includes("pgrst_source")) {
    if (q.includes('"interview_events"') || q.includes('"interview_messages"') || q.includes('"reports"')) {
      return "stream_poll";
    }
    if (q.includes('"interviews"')) {
      return "interview_lookup";
    }
  }
  if (q.includes("record_transcript_turn") || q.includes("record_voice_event")) {
    return "event_write";
  }
  if (q.includes("auth.") || q.includes('"auth"')) {
    return "auth";
  }
  return "other";
}

function diffStatements(before: Map<string, StatementRow>, after: Map<string, StatementRow>): StatementDelta[] {
  const deltas: StatementDelta[] = [];
  for (const [id, row] of after) {
    const prev = before.get(id);
    const calls = row.calls - (prev?.calls ?? 0);
    if (calls > 0) {
      deltas.push({
        category: categorize(row.query),
        query: row.query.replace(/\s+/g, " ").slice(0, 400),
        calls,
        totalMs: Math.round((row.total_exec_time - (prev?.total_exec_time ?? 0)) * 1000) / 1000,
      });
    }
  }
  return deltas.sort((a, b) => b.calls - a.calls);
}

/** Database clock minus host clock, from the lowest-latency of several round trips. */
async function clockOffset(sql: postgres.Sql): Promise<number> {
  let best = { rtt: Infinity, offset: 0 };
  for (let i = 0; i < 20; i++) {
    const t0 = Date.now();
    const [{ ms }] = await sql`select (extract(epoch from clock_timestamp()) * 1000)::float8 as ms`;
    const t1 = Date.now();
    if (t1 - t0 < best.rtt) {
      best = { rtt: t1 - t0, offset: ms - (t0 + t1) / 2 };
    }
  }
  return Math.round(best.offset * 10) / 10;
}

async function readDbRows(sql: postgres.Sql, offset: number): Promise<DbRows> {
  const iso = (rows: Record<string, unknown>[], key: string) => rows.map((r) => ({ ...r, [key]: (r[key] as Date).toISOString() }));
  const statuses = await sql`
    select interview_id::text, sequence, event_type::text, created_at from public.interview_events
    where event_type in ('start', 'completion', 'termination') order by interview_id, sequence`;
  const turns = await sql`
    select interview_id::text, sequence, role::text, client_event_id::text, created_at from public.interview_messages
    where role in ('ai', 'user') order by interview_id, sequence`;
  const reports = await sql`select interview_id::text, generated_at from public.reports`;
  return {
    clockOffsetMs: offset,
    statuses: iso(statuses, "created_at") as DbRows["statuses"],
    turns: iso(turns, "created_at") as DbRows["turns"],
    reports: iso(reports, "generated_at") as DbRows["reports"],
  };
}

const ERROR_LINE = /error|failed|exception|panic|cancel/i;
/** The edge runtime retiring a worker; requests then wait for a fresh worker to boot. */
const WORKER_LIMIT_LINE = /soft limit|hard limit|wall ?clock|memory limit|early.?drop|worker.*(shut|retir|terminat)/i;

async function runOnce(count: number, rep: number, status: Record<string, string>, edge: EdgeTemplate) {
  const runDir = join(outDir, "runs", `n${String(count).padStart(3, "0")}-r${rep}`);
  await Deno.mkdir(runDir, { recursive: true });
  log(`run n=${count} rep=${rep}: ${runDir}`);

  await docker(["rm", "-f", EDGE_CONTAINER], true);
  if (reset) {
    log("supabase db reset");
    await run(npx(), ["supabase", "db", "reset"]);
  }
  await waitFor("database", async () => {
    const sql = postgres(LOCAL.dbUrl, { max: 1, onnotice: () => {} });
    try {
      await sql`select 1`;
      return true;
    } finally {
      await sql.end();
    }
  });
  await startEdgeRuntime(edge);
  try {
    return await measure(count, rep, runDir, status);
  } finally {
    await docker(["rm", "-f", EDGE_CONTAINER], true);
  }
}

async function measure(count: number, rep: number, runDir: string, status: Record<string, string>) {
  const limits = await pinContainers();
  await writeJson(join(runDir, "limits.json"), limits);

  log(`seeding ${count} interviews`);
  const fixtures: SeededInterview[] = await seedInterviews({
    count,
    seed: config.seed,
    serviceRoleKey: status.SERVICE_ROLE_KEY,
    jwtSecret: status.JWT_SECRET,
  });
  await Deno.mkdir(tmpDir, { recursive: true });
  const fixturesPath = join(tmpDir, "fixtures.json");
  await writeJson(fixturesPath, fixtures);

  // Boot the interviews worker before the clock starts; a cold start is not what is measured.
  const warm = await fetch(`${LOCAL.apiUrl}/functions/v1/interviews/${fixtures[0].interviewId}/events?last_event_id=bad`, {
    headers: { Authorization: `Bearer ${fixtures[0].token}`, apikey: status.ANON_KEY },
  });
  await warm.body?.cancel();
  if (warm.status !== 400) {
    throw new Error(`warm-up request returned ${warm.status}, expected 400 invalid_cursor`);
  }

  const startAt = Date.now() + startDelayMs;
  const deadlineAt = startAt + schedule.completeAtMs + schedule.reportAfterMs + Math.max(...schedule.offsetsMs) + drainMs;
  const eventsPath = join(runDir, "k6-events.ndjson");
  const k6 = new Deno.Command(k6Bin, {
    args: [
      "run",
      "--quiet",
      "--no-color",
      "--log-format",
      "raw",
      "--console-output",
      eventsPath,
      "--summary-export",
      join(runDir, "k6-summary.json"),
      join(LOADTEST_DIR, "k6", "interview-stream.js"),
    ],
    env: {
      API_URL: LOCAL.apiUrl,
      ANON_KEY: status.ANON_KEY,
      SERVICE_ROLE_KEY: status.SERVICE_ROLE_KEY,
      START_AT: String(startAt),
      CONNECT_RAMP_MS: String(connectRampMs),
      DEADLINE_AT: String(deadlineAt),
      COUNT: String(count),
      SEED: String(config.seed),
      FIXTURES_PATH: fixturesPath,
      SCHEDULE_PATH: join(LOADTEST_DIR, "schedule.json"),
    },
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const k6Done = k6.output();

  const sql = postgres(LOCAL.dbUrl, { max: 2, onnotice: () => {} });
  try {
    await sleep(startAt + warmupMs - Date.now());
    const before = await snapshotStatements(sql);
    const stopSampling = Promise.withResolvers<void>();
    const sampling = sampleResources(sql, join(runDir, "samples.ndjson"), stopSampling.promise);
    await sleep(startAt + warmupMs + holdMs - Date.now());
    const after = await snapshotStatements(sql);
    stopSampling.resolve();
    await sampling;
    const statements = diffStatements(before, after);
    await writeJson(join(runDir, "pg-stat-statements.json"), statements);

    const k6Out = await k6Done;
    const k6Stderr = new TextDecoder().decode(k6Out.stderr);
    await Deno.writeTextFile(join(runDir, "k6-stdout.txt"), new TextDecoder().decode(k6Out.stdout) + k6Stderr);
    log(`k6 exited ${k6Out.code}`);

    const edgeState = await edgeRuntimeState();
    let edgeCrash: string | null = null;
    if (!edgeState?.running) {
      edgeCrash = edgeState ? `exit ${edgeState.exitCode}${edgeState.oomKilled ? " (OOM-killed)" : ""}` : "container missing";
      log(`edge runtime stopped during the run: ${edgeCrash}`);
    }

    const offset = await clockOffset(sql);
    const db = await readDbRows(sql, offset);
    await writeJson(join(runDir, "db-rows.json"), db);

    const edgeLog = await run("docker", [
      "logs",
      "--since",
      new Date(startAt - 1_000).toISOString(),
      "supabase_edge_runtime_stackprep",
    ], { allowFailure: true });
    const edgeLines = (edgeLog.stdout + "\n" + edgeLog.stderr).split("\n");
    const errorLines = edgeLines.filter((l) => ERROR_LINE.test(l) && !WORKER_LIMIT_LINE.test(l));
    const limitLines = edgeLines.filter((l) => WORKER_LIMIT_LINE.test(l));
    await Deno.writeTextFile(
      join(runDir, "edge-runtime-events.log"),
      [...limitLines, ...errorLines.slice(0, 500)].join("\n") + "\n",
    );

    const records = (await Deno.readTextFile(eventsPath)).split("\n").filter((l) => l.startsWith("{")).map((l) =>
      JSON.parse(l) as K6Record
    );
    const samples = (await Deno.readTextFile(join(runDir, "samples.ndjson"))).split("\n").filter((l) => l.startsWith("{"))
      .map((l) => JSON.parse(l) as Sample);
    const input: Omit<RunInput, "records" | "samples" | "db" | "statements"> = {
      count,
      startAt,
      warmupMs,
      holdMs,
      streamLifetimeMs: STREAM_LIFETIME_MS,
      interviewIds: fixtures.map((f) => f.interviewId),
      scheduledWritesPerInterview: schedule.actions.length + 2,
      containerCpus: Object.fromEntries(Object.entries(config.containers).map(([n, l]) => [n, l.cpus])),
      edgeErrorLines: errorLines.length,
      edgeWorkerLimitLines: limitLines.length,
      edgeRuntimeCrash: edgeCrash,
      thresholds: config.bottleneck,
    };
    await writeJson(join(runDir, "run-input.json"), input);
    const metrics = analyzeRun({ ...input, records, samples, db, statements });
    await writeJson(join(runDir, "metrics.json"), metrics);
    log(
      `n=${count} rep=${rep}: connected p95 ${metrics.connectedFrameDelayMs.p95} ms, all-rows p95 ${metrics.frameDelayMs.p95} ms, errors ${(metrics.errorRate * 100).toFixed(2)}%, ` +
        `dropped ${metrics.frames.dropped}, dup ${metrics.frames.duplicates}, breaches: ${metrics.breaches.join("; ") || "none"}`,
    );
    return metrics;
  } finally {
    await sql.end();
    await Deno.remove(fixturesPath).catch(() => {});
  }
}

async function environment(status: Record<string, string>) {
  const text = async (cmd: string, args: string[]) => (await run(cmd, args, { allowFailure: true })).stdout.trim();
  const images: Record<string, string> = {};
  for (const name of containers) {
    images[name] = await text("docker", ["inspect", "-f", "{{.Config.Image}}", name]);
  }
  const windows = Deno.build.os === "windows";
  return {
    recordedAt: new Date().toISOString(),
    transport,
    overridden,
    edgeWorkerCpuLimitsMs: edgeCpuLimits
      ? { soft: edgeCpuLimits[0], hard: edgeCpuLimits[1], source: "--edge-cpu-limit-ms (diagnostic)" }
      : { soft: 1000, hard: 2000, source: "CLI main service default" },
    host: {
      os: `${Deno.build.os} ${Deno.osRelease()}`,
      cpu: windows
        ? await text("powershell", ["-NoProfile", "-Command", "(Get-CimInstance Win32_Processor).Name"])
        : await text("uname", ["-p"]),
      logicalCpus: navigator.hardwareConcurrency,
      ramGiB: Math.round((Deno.systemMemoryInfo().total / 2 ** 30) * 10) / 10,
    },
    docker: {
      server: await text("docker", ["info", "--format", "{{.ServerVersion}}"]),
      vmCpus: Number(await text("docker", ["info", "--format", "{{.NCPU}}"])),
      vmMemGiB: Math.round((Number(await text("docker", ["info", "--format", "{{.MemTotal}}"])) / 2 ** 30) * 10) / 10,
    },
    versions: {
      supabaseCli: (await text(npx(), ["supabase", "--version"])).split("\n").find((l) => /^\d+\.\d+\.\d+/.test(l.trim()))?.trim(),
      k6: (await text(k6Bin, ["version"])).replace(/\r/g, ""),
      deno: Deno.version.deno,
      images,
    },
    git: {
      commit: await text("git", ["rev-parse", "HEAD"]),
      dirtyFiles: (await text("git", ["status", "--porcelain"])).split("\n").filter(Boolean).length,
    },
    apiUrl: status.API_URL,
    notes: [
      "Edge runtime: the container `supabase functions serve` creates (same image, command, mounts, env; default " +
      "per_worker policy), started per run without the CLI file watcher. With NTFS last-access updates enabled, the " +
      "watcher fired on worker boots and restarted the runtime mid-run, killing every open stream.",
      "Access tokens are HS256, minted with the local JWT secret (the gateway logs 'Legacy token type'); browser " +
      "sessions on this stack are ES256. The handler still verifies every token with Supabase Auth getUser.",
      "Writers use POST /interviews/:id/events (the browser path) for turns and voice events, and the service-role " +
      "RPCs complete_interview, request_report, save_report (the server-side path) for the terminal rows.",
      "Frame delay is client receipt minus the row's created_at, corrected by the measured database-host clock offset.",
    ],
    config,
  };
}

const status = await supabaseStatus();
await Deno.mkdir(outDir, { recursive: true });
await Deno.mkdir(tmpDir, { recursive: true });
log("capturing the edge runtime configuration from `supabase functions serve`");
const edgeTemplate = await captureEdgeTemplate();
await writeJson(join(outDir, "environment.json"), await environment(status));

const passed = (m: { breaches: string[] }[]) => m.every((r) => r.breaches.length === 0);
let allPassed = true;
const planned = [...stages];
for (let s = 0; s < planned.length; s++) {
  const count = planned[s];
  const results = [];
  for (let rep = 1; rep <= runsPerStage; rep++) {
    results.push(await runOnce(count, rep, status, edgeTemplate));
  }
  allPassed &&= passed(results);
  if (s === planned.length - 1 && allPassed && !has("no-extension") && !overridden) {
    // Extend only while nothing has broken; Phase 6 must use the same extension.
    const next = config.extensionStages.find((n) => n > count);
    if (next) {
      log(`all stages passed; extending to ${next}`);
      planned.push(next);
    }
  }
}
await summarize(outDir);
log(`done: ${join(outDir, "summary.md")}`);
