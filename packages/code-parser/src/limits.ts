import type { ParseLimits } from "./types.ts";

export const DEFAULT_PARSE_LIMITS: Readonly<ParseLimits> = Object.freeze({
  maxBytes: 512 * 1024,
  timeoutMs: 1000,
  maxNodes: 250_000,
  maxSymbols: 2000,
  maxImports: 500,
  maxExports: 1000,
  maxCalls: 2000,
  maxErrors: 100,
  maxErrorChildren: 256,
});

export function resolveLimits(...overrides: (Partial<ParseLimits> | undefined)[]): ParseLimits {
  const out: ParseLimits = { ...DEFAULT_PARSE_LIMITS };
  for (const o of overrides) {
    if (!o) continue;
    for (const [key, value] of Object.entries(o) as [keyof ParseLimits, number | undefined][]) {
      if (value === undefined) continue;
      if (!Number.isFinite(value) || value <= 0) throw new RangeError(`limit ${key} must be a positive number`);
      out[key] = value;
    }
  }
  return out;
}

/** Exact UTF-8 byte length of a JS string without allocating an encoded copy. */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i++;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

export function countLines(text: string): number {
  if (text.length === 0) return 0;
  let lines = 1;
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) lines++;
  return text.endsWith("\n") ? lines - 1 : lines;
}
