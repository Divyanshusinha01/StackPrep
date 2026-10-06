import { randomBytes, randomInt, randomUUID } from "node:crypto";
import type { InterviewReport, Json } from "@stackprep/shared";
import { PLANNING_OUTPUT } from "./fixtures/plan";
import type { AdminClient } from "./supabase";

/**
 * Service-role seeding. Rows mirror what the GitHub connect flow, the repository analysis job,
 * the planning job, and the report job write, so the app reads them through its normal paths.
 * Keep in sync with the migrations (typed against database.types.ts).
 */

export interface TestUser {
  id: string;
  email: string;
  password: string;
  login: string;
}

export interface SeededWorkspace {
  workspaceId: string;
  repositoryFullName: string;
  commitSha: string;
}

export interface StartedInterview {
  interviewId: string;
  interviewNumber: number;
  planningJobId: string;
}

type OkData<R> = Exclude<R, { error: object }> extends { data: infer D } ? NonNullable<D> : never;

function must<R extends { data: unknown; error: { message: string } | null }>(action: string, result: R): OkData<R> {
  if (result.error) {
    throw new Error(`E2E seed: failed to ${action}: ${result.error.message}`);
  }
  if (result.data === null || result.data === undefined) {
    throw new Error(`E2E seed: failed to ${action}: no data returned`);
  }
  return result.data as OkData<R>;
}

function check(action: string, result: { error: { message: string } | null }): void {
  if (result.error) {
    throw new Error(`E2E seed: failed to ${action}: ${result.error.message}`);
  }
}

/** A unique, email-confirmed user; `handle_new_user` creates the profile with this GitHub login. */
export async function createTestUser(admin: AdminClient, label: string): Promise<TestUser> {
  const login = `e2e-${label}-${randomUUID().slice(0, 8)}`;
  const email = `${login}@stackprep.test`;
  const password = `pw-${randomUUID()}`;
  const { user } = must(
    "create user",
    await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { user_name: login, full_name: "E2E Candidate" },
    }),
  );
  return { id: user.id, email, password, login };
}

/** The fixed setup-project user: created once, its password reset on every run. */
export async function ensureUser(admin: AdminClient, email: string, password: string): Promise<string> {
  const { users } = must("list users", await admin.auth.admin.listUsers({ perPage: 1000 }));
  const existing = users.find((u) => u.email === email);
  if (existing) {
    check("reset user password", await admin.auth.admin.updateUserById(existing.id, { password }));
    return existing.id;
  }
  const login = email.split("@")[0];
  const { user } = must(
    "create user",
    await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { user_name: login } }),
  );
  return user.id;
}

/** Deleting the auth user cascades to the profile and everything it owns. */
export async function deleteTestUser(admin: AdminClient, userId: string): Promise<void> {
  check("delete user", await admin.auth.admin.deleteUser(userId));
}

/** A connected GitHub installation, one repository, and a workspace whose analysis has finished. */
export async function seedReadyWorkspace(admin: AdminClient, user: TestUser): Promise<SeededWorkspace> {
  const commitSha = randomBytes(20).toString("hex");
  const name = "e2e-repo";
  const fullName = `${user.login}/${name}`;

  const connection = must(
    "insert github connection",
    await admin
      .from("github_connections")
      .insert({
        user_id: user.id,
        github_user_id: randomInt(1, 2 ** 31),
        installation_id: randomInt(1, 2 ** 31),
        account_login: user.login,
        account_type: "User",
        repository_selection: "selected",
      })
      .select("id")
      .single(),
  );
  const repository = must(
    "insert repository",
    await admin
      .from("repositories")
      .insert({
        user_id: user.id,
        github_connection_id: connection.id,
        github_repo_id: randomInt(1, 2 ** 31),
        owner: user.login,
        name,
        full_name: fullName,
        is_private: false,
        default_branch: "main",
      })
      .select("id")
      .single(),
  );
  const now = new Date().toISOString();
  const workspace = must(
    "insert workspace",
    await admin
      .from("workspaces")
      .insert({
        user_id: user.id,
        repository_id: repository.id,
        status: "ready",
        target_commit_sha: commitSha,
        indexed_commit_sha: commitSha,
        ready_at: now,
      })
      .select("id")
      .single(),
  );
  check(
    "insert analysis job",
    await admin.from("jobs").insert({
      user_id: user.id,
      workspace_id: workspace.id,
      type: "repository_indexing",
      status: "succeeded",
      progress: 100,
      repository_commit_sha: commitSha,
      started_at: now,
      finished_at: now,
    }),
  );
  const memory = (kind: string, content: string) => ({
    workspace_id: workspace.id,
    repository_id: repository.id,
    user_id: user.id,
    repository_commit_sha: commitSha,
    kind,
    content,
  });
  check(
    "insert repository memory",
    await admin.from("repository_memory").insert([
      memory("architecture_summary", "A Next.js web app backed by serverless functions and Postgres."),
      memory("technologies", "TypeScript, Next.js, PostgreSQL"),
      memory("key_files", "src/server/index.ts: request entry point"),
    ]),
  );
  return { workspaceId: workspace.id, repositoryFullName: fullName, commitSha };
}

/** Same RPC as `POST /workspaces/:id/interviews`, without the planning enqueue. */
export async function startInterview(
  admin: AdminClient,
  user: TestUser,
  workspace: SeededWorkspace,
): Promise<StartedInterview> {
  const rows = must(
    "start interview",
    await admin.rpc("start_interview", {
      p_workspace_id: workspace.workspaceId,
      p_user_id: user.id,
      p_commit_sha: workspace.commitSha,
    }),
  );
  const row = rows[0];
  return { interviewId: row.interview_id, interviewNumber: row.interview_number, planningJobId: row.job_id };
}

/** What the planning job does on success (`planning-store.ts` completePlanning). */
export async function completePlanning(admin: AdminClient, interviewId: string): Promise<void> {
  const job = must(
    "load planning job",
    await admin
      .from("jobs")
      .select("id")
      .eq("interview_id", interviewId)
      .eq("type", "interview_planning")
      .order("created_at", { ascending: false })
      .limit(1)
      .single(),
  );
  check(
    "write interview plan",
    await admin.rpc("update_interview_state", {
      p_interview_id: interviewId,
      p_expected_version: 1,
      p_coverage_map: PLANNING_OUTPUT.coverage_map as unknown as Json,
      p_plan: PLANNING_OUTPUT.plan as unknown as Json,
      p_strategy: PLANNING_OUTPUT.strategy as unknown as Json,
    }),
  );
  check(
    "mark planning succeeded",
    await admin
      .from("jobs")
      .update({
        status: "succeeded",
        progress: 100,
        stage: null,
        error_code: null,
        error_message: null,
        finished_at: new Date().toISOString(),
      })
      .eq("id", job.id),
  );
}

/** Stores transcript turns the way `POST /interviews/:id/events` does. */
export async function recordTranscript(
  admin: AdminClient,
  user: TestUser,
  interviewId: string,
  turns: { role: "ai" | "user"; content: string }[],
): Promise<void> {
  for (const turn of turns) {
    check(
      "record transcript turn",
      await admin.rpc("record_transcript_turn", {
        p_interview_id: interviewId,
        p_user_id: user.id,
        p_client_event_id: randomUUID(),
        p_role: turn.role,
        p_content: turn.content,
        p_metadata: { item_id: `item_${randomUUID()}` },
      }),
    );
  }
}

/** A first `connected` voice event moves the interview to in_progress (`record_voice_event`). */
export async function markConnected(admin: AdminClient, user: TestUser, interviewId: string): Promise<void> {
  check(
    "record connected event",
    await admin.rpc("record_voice_event", {
      p_interview_id: interviewId,
      p_user_id: user.id,
      p_client_event_id: randomUUID(),
      p_event_type: "connected",
      p_payload: {},
    }),
  );
}

/**
 * Completes an in-progress interview and queues its report job, as `end_interview` does. The
 * report itself is saved separately with `saveReport`, so the "generating" state is observable.
 */
export async function completeInterview(admin: AdminClient, user: TestUser, interviewId: string): Promise<string> {
  const completed = must(
    "complete interview",
    await admin.rpc("complete_interview", {
      p_interview_id: interviewId,
      p_user_id: user.id,
      p_reason: "completed_early",
    }),
  );
  if (!completed) {
    throw new Error("E2E seed: complete_interview returned false (interview was not in progress).");
  }
  return must(
    "request report",
    await admin.rpc("request_report", { p_interview_id: interviewId, p_user_id: user.id }),
  );
}

/** What the report job does on success (`save_report`). */
export async function saveReport(
  admin: AdminClient,
  interviewId: string,
  jobId: string,
  report: InterviewReport,
): Promise<void> {
  check(
    "save report",
    await admin.rpc("save_report", {
      p_interview_id: interviewId,
      p_job_id: jobId,
      p_content: report as unknown as Json,
    }),
  );
}

/** Stored transcript rows, in sequence order. */
export async function listTranscript(admin: AdminClient, interviewId: string) {
  return must(
    "load transcript",
    await admin
      .from("interview_messages")
      .select("role, content, sequence")
      .eq("interview_id", interviewId)
      .in("role", ["ai", "user"])
      .order("sequence"),
  );
}
