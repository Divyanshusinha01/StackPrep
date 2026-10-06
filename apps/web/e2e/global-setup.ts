import { loadE2EEnv } from "./support/env";
import { startFakeInngest } from "./support/fake-inngest";

const STACK_HINT = "Start it with `pnpm e2e:stack:up` (Docker required), then rerun.";

async function expectOk(name: string, url: string, headers: Record<string, string>, hint: string) {
  let res: Response;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
  } catch (err) {
    throw new Error(`E2E: ${name} is unreachable at ${url} (${(err as Error).message}). ${hint}`);
  }
  if (!res.ok) {
    throw new Error(`E2E: ${name} answered ${res.status} at ${url}. ${hint}`);
  }
}

export default async function globalSetup() {
  const env = loadE2EEnv();
  await expectOk("Supabase Auth", `${env.supabaseUrl}/auth/v1/health`, { apikey: env.anonKey }, STACK_HINT);
  // The health function enforces WEB_ORIGIN, so this also proves the functions run with .env.e2e.
  await expectOk(
    "Edge Functions",
    `${env.supabaseUrl}/functions/v1/health`,
    { apikey: env.anonKey, Origin: new URL(env.baseUrl).origin },
    "Serve them with `supabase functions serve --env-file supabase/functions/.env.e2e` " +
      `(WEB_ORIGIN must be ${new URL(env.baseUrl).origin}).`,
  );

  const inngest = await startFakeInngest(env.inngestPort);
  return () => inngest.close();
}
