export interface RetryOptions {
  attempts: number;
  delayMs: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Calls `fn` until it resolves or `attempts` runs out, waiting `delayMs` between tries. */
export async function withRetry<T>(fn: () => Promise<T>, { attempts, delayMs }: RetryOptions): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < attempts) {
        await sleep(delayMs);
      }
    }
  }
  throw lastError;
}
