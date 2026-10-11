/**
 * Serializes a JSON-compatible value with object keys sorted at every depth, so equal values always
 * produce equal strings regardless of key insertion order.
 *
 * Throws on values that JSON would silently drop or distort (non-finite numbers, bigints, functions,
 * symbols, Maps, Sets, class instances), because a key that loses information cannot detect a change.
 * `undefined` object properties are omitted, matching JSON.
 */
export function canonicalJson(value: unknown): string {
  return serialize(value, "$");
}

function serialize(value: unknown, path: string): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) throw new TypeError(`canonicalJson: non-finite number at ${path}`);
      return JSON.stringify(value);
    case "object":
      break;
    default:
      throw new TypeError(`canonicalJson: unsupported ${typeof value} at ${path}`);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item, i) => serialize(item, `${path}[${i}]`)).join(",")}]`;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new TypeError(`canonicalJson: unsupported ${proto?.constructor?.name ?? "object"} at ${path}`);
  }
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${serialize(record[key], `${path}.${key}`)}`);
  return `{${entries.join(",")}}`;
}

/** Canonical JSON indented by two spaces with a trailing newline, for committed and compared files. */
export function stableJson(value: unknown): string {
  return `${JSON.stringify(JSON.parse(canonicalJson(value)), null, 2)}\n`;
}

/** Lowercase hex SHA-256 of a string (UTF-8) or raw bytes. */
export async function sha256(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** SHA-256 of the canonical JSON of a value. */
export function hashCanonical(value: unknown): Promise<string> {
  return sha256(canonicalJson(value));
}

export interface ComponentChange {
  /** Dotted path into the components, e.g. "model" or "schema.properties.score". */
  path: string;
  kind: "added" | "removed" | "changed";
}

/**
 * Lists where two component objects differ, descending into nested plain objects. Arrays and scalars
 * are compared whole by canonical JSON. Sorted by path so diagnostics are stable.
 */
export function componentDiff(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): ComponentChange[] {
  const changes: ComponentChange[] = [];
  diffInto(before, after, "", changes);
  return changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function diffInto(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  prefix: string,
  out: ComponentChange[],
): void {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    const path = prefix ? `${prefix}.${key}` : key;
    const a = before[key];
    const b = after[key];
    if (a === undefined && b === undefined) continue;
    if (a === undefined) {
      out.push({ path, kind: "added" });
    } else if (b === undefined) {
      out.push({ path, kind: "removed" });
    } else if (isPlainObject(a) && isPlainObject(b)) {
      diffInto(a, b, path, out);
    } else if (canonicalJson(a) !== canonicalJson(b)) {
      out.push({ path, kind: "changed" });
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
