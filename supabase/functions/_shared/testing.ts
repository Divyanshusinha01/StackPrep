import { assert } from "@std/assert";

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
