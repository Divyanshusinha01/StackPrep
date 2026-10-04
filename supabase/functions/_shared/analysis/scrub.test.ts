import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { REDACTED, scrubDeep, scrubSecrets } from "./scrub.ts";

// Built at runtime so this file never contains a literal that looks like a real credential.
const r = (prefix: string, length: number, alphabet = "aB3dE5gH7jK9mN1pQ") =>
  prefix + Array.from({ length }, (_, i) => alphabet[i % alphabet.length]).join("");

const SECRETS: [string, string, string][] = [
  ["AWS access key id", `aws_key_id ${r("AKIA", 16, "ABCDEFGHJKLMNP23")}`, r("AKIA", 16, "ABCDEFGHJKLMNP23")],
  ["Google API key", `const g = "${r("AIza", 35)}";`, r("AIza", 35)],
  ["GitHub installation token", `token ${r("ghs_", 36)}`, r("ghs_", 36)],
  ["GitHub user token", `${r("ghp_", 40)}`, r("ghp_", 40)],
  ["GitHub fine-grained PAT", `${r("github_pat_", 40)}`, r("github_pat_", 40)],
  ["GitLab token", `${r("glpat-", 20)}`, r("glpat-", 20)],
  ["Stripe secret key", `stripe(${JSON.stringify(r("sk_live_", 24))})`, r("sk_live_", 24)],
  ["Stripe webhook secret", `const wh = ${r("whsec_", 32)}`, r("whsec_", 32)],
  ["OpenAI project key", `client = OpenAI(${r("sk-proj-", 48)})`, r("sk-proj-", 48)],
  ["Anthropic key", `${r("sk-ant-api03-", 40)}`, r("sk-ant-api03-", 40)],
  ["Slack token", `${r("xoxb-", 30)}`, r("xoxb-", 30)],
  ["Supabase secret key", `${r("sb_secret_", 30)}`, r("sb_secret_", 30)],
  ["npm token", `${r("npm_", 36)}`, r("npm_", 36)],
  [
    "JWT",
    `anon = ${r("eyJ", 20)}.${r("eyJ", 30)}.${r("", 43)}`,
    `${r("eyJ", 20)}.${r("eyJ", 30)}.${r("", 43)}`,
  ],
  ["Bearer header", `Authorization: Bearer ${r("", 32)}`, r("", 32)],
  ["Postgres URL with password", "postgresql://app:Sup3rS3cretPw@db.example.com:5432/app", "Sup3rS3cretPw"],
  ["Redis URL with password", "redis://default:R3disPassw0rd@cache:6379", "R3disPassw0rd"],
  ["Azure connection string", `AccountName=x;AccountKey=${r("", 40)}==;`, r("", 40)],
  ["env assignment", "DATABASE_PASSWORD=hunter2hunter2", "hunter2hunter2"],
  ["JWT secret assignment", "JWT_SECRET='my-signing-secret-value'", "my-signing-secret-value"],
  ["webhook secret in YAML", "webhook_secret: whk_live_value_123", "whk_live_value_123"],
  ["JSON api key", `{"apiKey": "abc123def456ghi"}`, "abc123def456ghi"],
  ["client secret object", `clientSecret: "cs_value_9876543"`, "cs_value_9876543"],
  ["Ruby hash", `:access_token => "tok_abcdef123456"`, "tok_abcdef123456"],
];

Deno.test("each secret class is redacted and no raw value remains", () => {
  for (const [label, input, secret] of SECRETS) {
    const out = scrubSecrets(input);
    assert(!out.includes(secret), `${label} leaked: ${out}`);
    assertStringIncludes(out, REDACTED, label);
  }
});

Deno.test("private key blocks are removed entirely, even when truncated", () => {
  const body = r("", 64, "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC");
  const pem = `-----BEGIN RSA PRIVATE KEY-----\n${body}\n${body}\n-----END RSA PRIVATE KEY-----`;
  const out = scrubSecrets(`key:\n${pem}\nafter`);
  assert(!out.includes(body));
  assertStringIncludes(out, "after");
  const truncated = scrubSecrets(`-----BEGIN PRIVATE KEY-----\n${body}`);
  assert(!truncated.includes(body));
});

Deno.test("non-secrets are preserved", () => {
  const safe = [
    'import { createClient } from "@supabase/supabase-js";',
    "const apiKey = process.env.OPENAI_API_KEY;",
    "SUPABASE_SERVICE_ROLE_KEY=${SUPABASE_SERVICE_ROLE_KEY}",
    "password: true",
    "token_count: 42",
    '"author": "Alice <alice@example.com>"',
    "https://github.com/acme/app",
    "postgresql://localhost:5432/app",
    "# Getting started\nRun pnpm dev.",
  ];
  for (const text of safe) {
    assertEquals(scrubSecrets(text), text);
  }
});

Deno.test("scrubSecrets is idempotent and scrubDeep reaches nested strings", () => {
  const once = scrubSecrets("DB_PASSWORD=hunter2hunter2");
  assertEquals(scrubSecrets(once), once);

  const value = scrubDeep({
    readme: { excerpt: `token ${r("ghp_", 40)}` },
    list: ["ok", "SECRET_KEY=abcdefghijk"],
    n: 3,
    flag: null,
  });
  const serialized = JSON.stringify(value);
  assert(!serialized.includes(r("ghp_", 40)));
  assert(!serialized.includes("abcdefghijk"));
  assertEquals(value.n, 3);
  assertEquals(value.list[0], "ok");
});
