import { fromFileUrl, join } from "@std/path";

export const LOADTEST_DIR = fromFileUrl(new URL(".", import.meta.url));
export const REPO_DIR = join(LOADTEST_DIR, "..");

export interface ContainerLimit {
  cpus: number;
  memory: string;
}

export interface LoadtestConfig {
  seed: number;
  stages: number[];
  extensionStages: number[];
  runsPerStage: number;
  timing: {
    startDelayMs: number;
    connectRampMs: number;
    warmupMs: number;
    holdMs: number;
    reportAfterCompleteMs: number;
    drainMs: number;
  };
  workload: { turnIntervalMs: number; voiceEventIntervalMs: number; turnContentChars: number };
  bottleneck: { p95FrameDelayMs: number; errorRate: number; cpuSaturationShare: number };
  containers: Record<string, ContainerLimit>;
  pins: Record<string, string>;
}

export interface ScheduleAction {
  atMs: number;
  kind: "transcript_turn" | "connected" | "disconnected";
  role?: "ai" | "user";
}

export interface Schedule {
  seed: number;
  maxInterviews: number;
  /** Per-interview start offset, so writers do not fire in lockstep. */
  offsetsMs: number[];
  /** Same for every interview, relative to its offset. */
  actions: ScheduleAction[];
  /** Relative to the run start: completion, then the report `reportAfterMs` later. */
  completeAtMs: number;
  reportAfterMs: number;
  turnContentChars: number;
}

export interface SeededInterview {
  index: number;
  userId: string;
  interviewId: string;
  token: string;
}

export const LOCAL = {
  apiUrl: "http://127.0.0.1:54321",
  dbUrl: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
};

export async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await Deno.readTextFile(path)) as T;
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await Deno.writeTextFile(path, JSON.stringify(value, null, 2) + "\n");
}

export function loadConfig(): Promise<LoadtestConfig> {
  return readJson<LoadtestConfig>(join(LOADTEST_DIR, "config.json"));
}

/** mulberry32: small, fast, and identical on every platform for a given seed. */
export function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** RFC 4122 v4-shaped UUID drawn from the seeded RNG. */
export function seededUuid(rng: () => number): string {
  const bytes = Array.from({ length: 16 }, () => Math.floor(rng() * 256));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function base64url(data: Uint8Array | string): string {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** An HS256 access token for a seeded user, signed with the local stack's JWT secret. */
export async function mintAccessToken(secret: string, userId: string, email: string, ttlSeconds: number): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({
    iss: `${LOCAL.apiUrl}/auth/v1`,
    sub: userId,
    aud: "authenticated",
    role: "authenticated",
    email,
    aal: "aal1",
    amr: [{ method: "password", timestamp: now }],
    is_anonymous: false,
    iat: now,
    exp: now + ttlSeconds,
  }));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${header}.${payload}`)));
  return `${header}.${payload}.${base64url(signature)}`;
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export async function run(cmd: string, args: string[], opts: { cwd?: string; allowFailure?: boolean } = {}): Promise<CommandResult> {
  const out = await new Deno.Command(cmd, { args, cwd: opts.cwd ?? REPO_DIR, stdout: "piped", stderr: "piped" }).output();
  const result = {
    code: out.code,
    stdout: new TextDecoder().decode(out.stdout),
    stderr: new TextDecoder().decode(out.stderr),
  };
  if (result.code !== 0 && !opts.allowFailure) {
    throw new Error(`${cmd} ${args.join(" ")} exited ${result.code}: ${result.stderr || result.stdout}`);
  }
  return result;
}

/** `supabase status -o json`; the CLI also prints update notices, so take the JSON object only. */
export async function supabaseStatus(): Promise<Record<string, string>> {
  const { stdout } = await run(npx(), ["supabase", "status", "-o", "json"]);
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  return JSON.parse(stdout.slice(start, end + 1));
}

export function npx(): string {
  return Deno.build.os === "windows" ? "npx.cmd" : "npx";
}

export function quantile(sorted: number[], q: number): number | null {
  if (sorted.length === 0) {
    return null;
  }
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function median(values: number[]): number | null {
  return quantile([...values].sort((a, b) => a - b), 0.5);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}
