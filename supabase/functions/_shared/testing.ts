import { assert } from "@std/assert";
import type { AIProvider, AIUsage, StructuredRequest } from "./ai/provider.ts";

export interface FakeAIProvider extends AIProvider {
  calls: StructuredRequest<unknown>[];
}

/**
 * Returns `respond(request)` validated against the request's schema, like the real provider.
 * A thrown error (or returned Error) is rethrown as-is.
 */
export function createFakeAIProvider(
  respond: (request: StructuredRequest<unknown>) => unknown,
  usage: AIUsage = { input_tokens: 100, cached_input_tokens: 0, output_tokens: 50 },
): FakeAIProvider {
  const calls: StructuredRequest<unknown>[] = [];
  return {
    calls,
    generateStructured<T>(request: StructuredRequest<T>) {
      calls.push(request as StructuredRequest<unknown>);
      try {
        const value = respond(request as StructuredRequest<unknown>);
        if (value instanceof Error) {
          return Promise.reject(value);
        }
        return Promise.resolve({ output: request.schema.parse(value), usage });
      } catch (err) {
        return Promise.reject(err);
      }
    },
  };
}

const FORBIDDEN = ["token", "access_token", "refresh_token", "client_secret", "private_key", "ghs_", "ghu_", "gho_"];

/** Fails if the response body or headers contain anything token-like. Consumes a clone of the body. */
export async function assertNoSecrets(res: Response): Promise<void> {
  const body = await res.clone().text();
  const headers = JSON.stringify([...res.headers.entries()]);
  for (const haystack of [body, headers]) {
    const lower = haystack.toLowerCase();
    for (const needle of FORBIDDEN) {
      assert(!lower.includes(needle), `response leaks "${needle}": ${haystack}`);
    }
  }
}
