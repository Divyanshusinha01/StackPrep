/** Redacts credentials from repository text before anything derived from it is stored or logged. */

export const REDACTED = "[REDACTED_SECRET]";

const SECRET_KEY_WORDS =
  "secret|password|passwd|pwd|passphrase|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|" +
  "auth[_-]?token|credentials?|signing[_-]?key|webhook[_-]?secret|encryption[_-]?key|session[_-]?key|dsn|salt";

/** Values that reference a secret rather than contain it. */
const REFERENCE_VALUE =
  /^(process\.env|Deno\.env|import\.meta\.env|os\.environ|os\.getenv|env\(|ENV\[|\$\{|\$[A-Z_]|<|\[REDACTED_SECRET|true$|false$|null$|undefined$|none$)/i;

type Replacer = (match: string, ...groups: string[]) => string;

const PATTERNS: [RegExp, string | Replacer][] = [
  // PEM private keys (RSA, EC, OpenSSH, PKCS#8, encrypted).
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, REDACTED],
  // Credentials embedded in connection URLs: scheme://user:password@host
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s:@/"'`]+:[^\s@/"'`]+@/gi, `$1${REDACTED}@`],
  // JWTs (Supabase keys, session tokens, signed payloads).
  [/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, REDACTED],
  // Provider-specific key formats.
  [/\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA)[0-9A-Z]{16}\b/g, REDACTED],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, REDACTED],
  [/\bya29\.[0-9A-Za-z_-]{20,}/g, REDACTED],
  [/\b(?:gh[pousr])_[A-Za-z0-9]{36,}\b/g, REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{22,}\b/g, REDACTED],
  [/\bglpat-[A-Za-z0-9_-]{20,}\b/g, REDACTED],
  [/\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{10,}\b/g, REDACTED],
  [/\bwhsec_[A-Za-z0-9+/=]{10,}/g, REDACTED],
  [/\bsk-(?:proj-|svcacct-|admin-|ant-[a-z0-9]+-)?[A-Za-z0-9_-]{20,}/g, REDACTED],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/\bhooks\.slack\.com\/services\/[A-Za-z0-9/]+/g, `hooks.slack.com/services/${REDACTED}`],
  [/\b(?:sb_secret|sb_publishable)_[A-Za-z0-9_-]{10,}/g, REDACTED],
  [/\bnpm_[A-Za-z0-9]{36}\b/g, REDACTED],
  [/\b(AccountKey|SharedAccessKey|SharedAccessSignature|sig)=[A-Za-z0-9+/%=]{16,}/g, `$1=${REDACTED}`],
  // Authorization header values.
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/-]{16,}=*/g, `$1 ${REDACTED}`],
  // key = value / key: value / "key": "value" where the key names a secret.
  [
    new RegExp(
      `(["']?)([A-Za-z0-9_.-]*(?:${SECRET_KEY_WORDS})[A-Za-z0-9_.-]*)\\1(\\s*(?:=>|=|:)\\s*)(["'\`]?)([^\\s"'\`,;)}\\]]+)\\4`,
      "gi",
    ),
    (match, keyQuote, key, separator, valueQuote, value) =>
      value.length < 4 || REFERENCE_VALUE.test(value)
        ? match
        : `${keyQuote}${key}${keyQuote}${separator}${valueQuote}${REDACTED}${valueQuote}`,
  ],
];

export function scrubSecrets(text: string): string {
  let result = text;
  for (const [pattern, replacement] of PATTERNS) {
    result = typeof replacement === "string"
      ? result.replace(pattern, replacement)
      : result.replace(pattern, replacement as (substring: string, ...args: unknown[]) => string);
  }
  return result;
}

/** Recursively scrubs every string in a JSON-like value. */
export function scrubDeep<T>(value: T): T {
  if (typeof value === "string") {
    return scrubSecrets(value) as T;
  }
  if (Array.isArray(value)) {
    return value.map(scrubDeep) as T;
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [scrubSecrets(k), scrubDeep(v)]),
    ) as T;
  }
  return value;
}
