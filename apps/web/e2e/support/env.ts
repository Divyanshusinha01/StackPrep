import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

export const WEB_DIR = path.resolve(__dirname, "../..");
export const REPO_ROOT = path.resolve(WEB_DIR, "../..");
export const AUTH_FILE = path.join(WEB_DIR, "e2e/.auth/user.json");

const DEFAULTS = {
  E2E_SUPABASE_URL: "http://127.0.0.1:54321",
  // Must equal WEB_ORIGIN in supabase/functions/.env.e2e: the Edge Functions reject other origins.
  E2E_BASE_URL: "http://localhost:3000",
  E2E_USER_EMAIL: "e2e-user@stackprep.test",
  E2E_USER_PASSWORD: "e2e-password-not-a-secret",
  E2E_INNGEST_PORT: "8289",
  // Must equal OPENAI_KEY_ENCRYPTION_KEYS in supabase/functions/.env.e2e, or seeded keys cannot be decrypted.
  E2E_OPENAI_KEY_ENCRYPTION_KEYS: "1:hzoD/xxTZycp8U3IFrR+9ZyasS7CgdWxAmYmqzvH+tY=",
} as const;

export interface E2EEnv {
  supabaseUrl: string;
  anonKey: string;
  serviceRoleKey: string;
  baseUrl: string;
  userEmail: string;
  userPassword: string;
  inngestPort: number;
  /** Test-only keyring (version 1 active) used to seed encrypted OpenAI keys. */
  openAIKeyEncryptionKeys: string;
}

/** `KEY="value"` lines printed by `supabase status -o env`. */
function readSupabaseStatus(): Record<string, string> {
  let output: string;
  try {
    output = execSync("pnpm exec supabase status -o env", {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    throw new Error(
      "E2E: could not read keys from `supabase status`. Start the local stack (`pnpm e2e:stack:up`) " +
        "or set E2E_SUPABASE_ANON_KEY and E2E_SUPABASE_SERVICE_ROLE_KEY in apps/web/.env.e2e.",
    );
  }
  const values: Record<string, string> = {};
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^([A-Z_]+)="?(.*?)"?$/);
    if (match) {
      values[match[1]] = match[2];
    }
  }
  return values;
}

let loaded = false;

/**
 * Loads `apps/web/.env.e2e` (if present), applies defaults, and fills missing Supabase keys from
 * the running local stack. Results are written to `process.env`, so Playwright workers and the
 * web server inherit them without re-running the CLI.
 */
export function loadE2EEnv(): E2EEnv {
  if (!loaded) {
    loaded = true;
    const file = path.join(WEB_DIR, ".env.e2e");
    if (existsSync(file)) {
      process.loadEnvFile(file);
    }
    for (const [key, value] of Object.entries(DEFAULTS)) {
      process.env[key] ||= value;
    }
    if (!process.env.E2E_SUPABASE_ANON_KEY || !process.env.E2E_SUPABASE_SERVICE_ROLE_KEY) {
      const status = readSupabaseStatus();
      process.env.E2E_SUPABASE_ANON_KEY ||= status.ANON_KEY || status.PUBLISHABLE_KEY;
      process.env.E2E_SUPABASE_SERVICE_ROLE_KEY ||= status.SERVICE_ROLE_KEY || status.SECRET_KEY;
    }
  }

  const required = (key: string) => {
    const value = process.env[key];
    if (!value) {
      throw new Error(`E2E: ${key} is not set.`);
    }
    return value;
  };
  return {
    supabaseUrl: required("E2E_SUPABASE_URL"),
    anonKey: required("E2E_SUPABASE_ANON_KEY"),
    serviceRoleKey: required("E2E_SUPABASE_SERVICE_ROLE_KEY"),
    baseUrl: required("E2E_BASE_URL"),
    userEmail: required("E2E_USER_EMAIL"),
    userPassword: required("E2E_USER_PASSWORD"),
    inngestPort: Number(required("E2E_INNGEST_PORT")),
    openAIKeyEncryptionKeys: required("E2E_OPENAI_KEY_ENCRYPTION_KEYS"),
  };
}
