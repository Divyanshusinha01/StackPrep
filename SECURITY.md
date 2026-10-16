# Security policy

## Reporting a vulnerability

Please do not open a public issue for security problems.

Report vulnerabilities privately through GitHub: go to the [Security tab](https://github.com/Divyanshusinha01/StackPrep/security) and choose **Report a vulnerability**. Include the affected component (web app, an Edge Function, a migration), steps to reproduce, and the impact you expect.

You should get an acknowledgement within 7 days. Once a fix is released, the advisory will be published with credit, unless you ask to stay anonymous.

## Supported versions

Only the `main` branch and the current production deployment receive security fixes.

## Scope

In scope:

- The Next.js app in `apps/web`
- Supabase Edge Functions in `supabase/functions`
- Database schema, row-level security and SQL functions in `supabase/migrations`

Out of scope:

- Vulnerabilities in third-party services (Supabase, Vercel, OpenAI, Inngest, GitHub, Sentry); report those to the vendor
- Denial of service through volume alone, and findings from automated scanners without a demonstrated impact
- Missing hardening that does not lead to an exploitable issue

## Handling secrets

The repository contains no real credentials. Every `.env*` file except the `*.example` files is gitignored, and [`.gitleaks.toml`](.gitleaks.toml) lists the deliberately fake secrets used by the scrubber tests. If you find a real credential anywhere in the repository or its history, report it as described above.

The test-only keyring in `supabase/functions/.env.e2e.example` (and the matching `E2E_OPENAI_KEY_ENCRYPTION_KEYS` default) is public on purpose. It only ever encrypts dummy keys in local E2E runs and must never be used in any other environment.

## Users' OpenAI API keys

StackPrep has no platform OpenAI key. Each user adds their own key on `/settings`, and every OpenAI request for that user's workspaces and interviews uses it. Design details are in [architecture.md](architecture.md#user-openai-keys-bring-your-own-key).

- **At rest.** Keys are encrypted in Edge Functions with AES-256-GCM before they reach Postgres. The additional authenticated data binds each ciphertext to its user and credential id, so a row cannot be decrypted as someone else's key. The `openai_credentials` table has RLS with no policies and no `anon` / `authenticated` grants; only the service role can read it.
- **Master keys.** `OPENAI_KEY_ENCRYPTION_KEYS` and `OPENAI_KEY_ENCRYPTION_ACTIVE_VERSION` live only in Supabase function secrets (plus an offline copy in a password manager), never in the database, the repository, Vercel, or logs. Each environment has its own keyring.
- **In transit and in use.** The key is sent once, in a server action's form body, to `PUT /me/openai-key`. After that it is only decrypted inside Edge Functions for the request or Inngest step that needs it. It is never returned to the browser (only `sk-...` plus the last four characters), never put in a URL, event payload, step output, or log line, and `sk-` values are redacted from Sentry events.
- **Abuse.** Validation requires a signed-in user, is limited to 5 attempts per 10 minutes per user, and returns generic error codes, so it cannot be used to test keys in bulk.
- **Known limit.** Deleting or replacing a key does not end a voice session that is already connected to OpenAI; the next request that needs the key is refused.

### Rotating the master key

1. Generate a new 32-byte key (`openssl rand -base64 32`) and append it with the next version number, for example `OPENAI_KEY_ENCRYPTION_KEYS=1:<old>,2:<new>`.
2. Set `OPENAI_KEY_ENCRYPTION_ACTIVE_VERSION=2` and run `supabase secrets set` with both values. `me`, `interviews`, and `inngest` load the keyring when an instance boots; redeploy them to make sure no instance keeps the old one.
3. New and replaced keys are now encrypted with version 2; existing rows keep decrypting with version 1. Never remove a version while any `openai_credentials.enc_key_version` row still uses it (`select enc_key_version, count(*) from public.openai_credentials group by 1`).
4. There is no automated re-encryption routine yet. To retire an old version, existing rows must be re-encrypted with a one-off service-role job that decrypts with the old version and calls `upsert_openai_credential` with the active one, or the affected users must re-save their keys. Only then remove the old version from the keyring.

### If a master key or the credentials table may be exposed

- **Master key only.** Rotate as above, re-encrypt or delete every row that used the exposed version, then remove it from the keyring.
- **Master key and database together.** Treat every key encrypted with that version as disclosed: delete those rows (`delete_openai_credential`), tell the affected users to revoke the key in their OpenAI dashboard and add a new one, and rotate the master key.
- **Database only.** Ciphertext is not usable without the master key, but rotate it anyway if there is any doubt about the function secrets.
