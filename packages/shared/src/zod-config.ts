import { z } from "zod";

// Zod probes for JIT support with `Function("")` when an object schema is built, which a browser CSP
// without 'unsafe-eval' reports as a violation. Must run before any schema below is constructed, so
// index.ts imports it first. Server runtimes keep the faster JIT path.
if ("document" in globalThis) {
  z.config({ jitless: true });
}
