const WINDOW_MS = 60_000;

interface Window {
  startedAt: number;
  count: number;
}

/**
 * Fixed-window request limiter. Counters live in this process's memory, so each server instance
 * enforces its own limit and counts reset on restart.
 */
export class RateLimiter {
  private readonly windows = new Map<string, Window>();

  constructor(private readonly limitPerMinute: number) {}

  allow(clientKey: string, now = Date.now()): boolean {
    const current = this.windows.get(clientKey);
    if (!current || now - current.startedAt >= WINDOW_MS) {
      this.windows.set(clientKey, { startedAt: now, count: 1 });
      return true;
    }
    if (current.count >= this.limitPerMinute) {
      return false;
    }
    current.count++;
    return true;
  }

  reset(clientKey: string): void {
    this.windows.delete(clientKey);
  }
}
