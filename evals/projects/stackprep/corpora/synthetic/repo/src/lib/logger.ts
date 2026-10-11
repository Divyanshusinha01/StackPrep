type Fields = Record<string, unknown>;

const REDACTED_KEYS = new Set(["password"]);

/** Replaces sensitive values before a log line is written. */
export function redact(fields: Fields): Fields {
  const out: Fields = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = REDACTED_KEYS.has(key) ? "[redacted]" : value;
  }
  return out;
}

export interface Logger {
  info(event: string, fields: Fields): void;
  error(event: string, fields: Fields): void;
}

export function createLogger(scope: string): Logger {
  const write = (level: string, event: string, fields: Fields) =>
    console.log(JSON.stringify({ level, scope, event, ...redact(fields), at: new Date().toISOString() }));
  return {
    info: (event, fields) => write("info", event, fields),
    error: (event, fields) => write("error", event, fields),
  };
}
