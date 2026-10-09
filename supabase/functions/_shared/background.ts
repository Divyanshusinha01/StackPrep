interface EdgeRuntimeGlobal {
  EdgeRuntime?: { waitUntil(promise: Promise<unknown>): void };
}

/**
 * Lets `promise` finish after the response is sent. On Supabase Edge the worker is kept alive
 * until it settles; elsewhere (tests, local scripts) it simply runs. A rejection is logged, never thrown.
 */
export function runInBackground(event: string, promise: Promise<unknown>): void {
  const settled = promise.catch((err) => {
    console.error(JSON.stringify({ event, reason: err instanceof Error ? err.name : "unknown" }));
  });
  (globalThis as EdgeRuntimeGlobal).EdgeRuntime?.waitUntil(settled);
}
