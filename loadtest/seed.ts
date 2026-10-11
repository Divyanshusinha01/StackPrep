// Seeds N identical in-progress interviews on a freshly reset local stack. Users are created
// through the Auth admin API with ids from the seeded RNG, so every run gets the same ids; the
// rest goes through the same SQL functions the app uses (start_interview, record_voice_event).
import postgres from "postgres";
import { createRng, LOCAL, mintAccessToken, type SeededInterview, seededUuid } from "./lib.ts";

const COMMIT_SHA = "1".repeat(40);
const TOKEN_TTL_SECONDS = 2 * 60 * 60;

export interface SeedOptions {
  count: number;
  seed: number;
  serviceRoleKey: string;
  jwtSecret: string;
}

interface SeedIds {
  userId: string;
  repositoryId: string;
  workspaceId: string;
  connectEventId: string;
}

function seedIds(seed: number, count: number): SeedIds[] {
  const rng = createRng(seed ^ 0x5eed);
  return Array.from({ length: count }, () => ({
    userId: seededUuid(rng),
    repositoryId: seededUuid(rng),
    workspaceId: seededUuid(rng),
    connectEventId: seededUuid(rng),
  }));
}

async function createUser(serviceRoleKey: string, index: number, ids: SeedIds): Promise<string> {
  const login = `loadtest-${String(index).padStart(4, "0")}`;
  const email = `${login}@stackprep.test`;
  const res = await fetch(`${LOCAL.apiUrl}/auth/v1/admin/users`, {
    method: "POST",
    headers: { Authorization: `Bearer ${serviceRoleKey}`, apikey: serviceRoleKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      id: ids.userId,
      email,
      password: `pw-${ids.userId}`,
      email_confirm: true,
      user_metadata: { user_name: login, full_name: "Load Test Candidate" },
    }),
  });
  const body = await res.json();
  if (!res.ok || body.id !== ids.userId) {
    throw new Error(`seed: create user ${index} failed (${res.status}): ${JSON.stringify(body)}`);
  }
  return email;
}

async function inBatches<T>(items: T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  for (let i = 0; i < items.length; i += size) {
    await Promise.all(items.slice(i, i + size).map(fn));
  }
}

export async function seedInterviews({ count, seed, serviceRoleKey, jwtSecret }: SeedOptions): Promise<SeededInterview[]> {
  const ids = seedIds(seed, count);
  const sql = postgres(LOCAL.dbUrl, { max: 8, onnotice: () => {} });
  const seeded: SeededInterview[] = new Array(count);
  try {
    await inBatches(ids.map((id, index) => ({ id, index })), 10, async ({ id, index }) => {
      const email = await createUser(serviceRoleKey, index, id);
      await sql.begin(async (tx) => {
        await tx`
          insert into public.repositories (id, user_id, github_repo_id, owner, name, full_name, is_private, default_branch)
          values (${id.repositoryId}, ${id.userId}, ${100_000 + index}, ${`loadtest-${index}`}, 'repo',
                  ${`loadtest-${index}/repo`}, false, 'main')`;
        await tx`
          insert into public.workspaces (id, user_id, repository_id, status, target_commit_sha, indexed_commit_sha, ready_at)
          values (${id.workspaceId}, ${id.userId}, ${id.repositoryId}, 'ready', ${COMMIT_SHA}, ${COMMIT_SHA}, now())`;
      });
      const [started] = await sql`
        select interview_id from public.start_interview(${id.workspaceId}, ${id.userId}, ${COMMIT_SHA})`;
      const interviewId = started.interview_id as string;
      // The first `connected` moves the interview to in_progress and writes the `start` status row.
      await sql`
        select status from public.record_voice_event(${interviewId}, ${id.userId}, ${id.connectEventId}, 'connected', '{}'::jsonb)`;
      seeded[index] = {
        index,
        userId: id.userId,
        interviewId,
        token: await mintAccessToken(jwtSecret, id.userId, email, TOKEN_TTL_SECONDS),
      };
    });
    const [{ in_progress }] = await sql`
      select count(*)::int as in_progress from public.interviews where status = 'in_progress'`;
    if (in_progress !== count) {
      throw new Error(`seed: expected ${count} in_progress interviews, found ${in_progress}`);
    }
  } finally {
    await sql.end();
  }
  return seeded;
}
