import { describe, expect, it } from "vitest";
import { Constants } from "./database.types.ts";
import { apiErrorCodeSchema } from "./github.ts";
import {
  analysisStateSchema,
  createWorkspaceRequestSchema,
  createWorkspaceResponseSchema,
  gitCommitShaSchema,
  interviewStatusSchema,
  repositoryHtmlUrl,
  retryAnalysisResponseSchema,
  workspaceDetailResponseSchema,
  workspaceIdParamSchema,
  workspaceListResponseSchema,
  workspaceSchema,
  workspaceStatusSchema,
} from "./workspaces.ts";

const connId = "aaaaaaaa-0000-4000-8000-000000000001";
const sha = "a".repeat(40);

const repository = {
  id: "bbbbbbbb-0000-4000-8000-000000000002",
  github_repo_id: 42,
  owner: "alice",
  name: "app",
  full_name: "alice/app",
  is_private: true,
  default_branch: "main",
  html_url: "https://github.com/alice/app",
};

const workspace = {
  id: "cccccccc-0000-4000-8000-000000000003",
  status: "analyzing",
  repository,
  target_commit_sha: sha,
  indexed_commit_sha: null,
  created_at: "2026-10-04T10:00:00.123456+00:00",
  ready_at: null,
  analysis: { state: "running", stage: "scanning", error_code: null, retryable: false },
};

describe("createWorkspaceRequestSchema", () => {
  it("accepts a valid body", () => {
    expect(createWorkspaceRequestSchema.parse({ connection_id: connId, github_repo_id: 42 })).toEqual({
      connection_id: connId,
      github_repo_id: 42,
    });
  });

  it.each([
    ["missing connection_id", { github_repo_id: 1 }],
    ["missing github_repo_id", { connection_id: connId }],
    ["bad connection_id", { connection_id: "nope", github_repo_id: 1 }],
    ["zero github_repo_id", { connection_id: connId, github_repo_id: 0 }],
    ["fractional github_repo_id", { connection_id: connId, github_repo_id: 1.5 }],
    ["string github_repo_id", { connection_id: connId, github_repo_id: "1" }],
    ["unsafe github_repo_id", { connection_id: connId, github_repo_id: 2 ** 53 }],
    ["owner/name from the browser", { connection_id: connId, github_repo_id: 1, full_name: "evil/repo" }],
  ])("rejects %s", (_label, body) => {
    expect(createWorkspaceRequestSchema.safeParse(body).success).toBe(false);
  });
});

describe("workspaceSchema", () => {
  it("accepts a workspace with Postgres timestamps and strips unknown fields", () => {
    expect(workspaceSchema.parse({ ...workspace, user_id: connId })).toEqual(workspace);
  });

  it("accepts a ready workspace", () => {
    const ready = { ...workspace, status: "ready", indexed_commit_sha: sha, ready_at: "2026-10-04T11:00:00Z" };
    expect(workspaceSchema.parse(ready)).toEqual(ready);
  });

  it.each([
    ["unknown status", { status: "pending" }],
    ["short sha", { target_commit_sha: "abc" }],
    ["uppercase sha", { target_commit_sha: "A".repeat(40) }],
    ["non-https repository url", { repository: { ...repository, html_url: "http://github.com/alice/app" } }],
    ["timestamp without offset", { created_at: "2026-10-04T10:00:00" }],
    ["missing analysis", { analysis: undefined }],
    ["unknown analysis stage", { analysis: { ...workspace.analysis, stage: "uploading" } }],
    ["unknown analysis error code", { analysis: { state: "failed", stage: null, error_code: "boom", retryable: true } }],
  ])("rejects %s", (_label, patch) => {
    expect(workspaceSchema.safeParse({ ...workspace, ...patch }).success).toBe(false);
  });

  it("accepts a workspace with no analysis yet and a failed analysis", () => {
    expect(workspaceSchema.parse({ ...workspace, analysis: null }).analysis).toBeNull();
    const failed = { state: "failed", stage: null, error_code: "github_unavailable", retryable: true };
    expect(workspaceSchema.parse({ ...workspace, status: "failed", analysis: failed }).analysis).toEqual(failed);
  });
});

describe("retryAnalysisResponseSchema", () => {
  it("wraps the updated workspace", () => {
    expect(retryAnalysisResponseSchema.parse({ workspace })).toEqual({ workspace });
    expect(apiErrorCodeSchema.safeParse("analysis_not_retryable").success).toBe(true);
  });
});

describe("response schemas", () => {
  it("parse create, list, and detail responses", () => {
    expect(createWorkspaceResponseSchema.parse({ workspace, created: true })).toEqual({ workspace, created: true });
    expect(workspaceListResponseSchema.parse({ workspaces: [workspace] })).toEqual({ workspaces: [workspace] });
    const detail = { workspace, repository, interviews: [] };
    expect(workspaceDetailResponseSchema.parse(detail)).toEqual(detail);
  });

  it("requires created and interviews", () => {
    expect(createWorkspaceResponseSchema.safeParse({ workspace }).success).toBe(false);
    expect(workspaceDetailResponseSchema.safeParse({ workspace, repository }).success).toBe(false);
  });
});

describe("helpers", () => {
  it("validates workspace ids", () => {
    expect(workspaceIdParamSchema.safeParse(connId).success).toBe(true);
    expect(workspaceIdParamSchema.safeParse("123").success).toBe(false);
  });

  it("accepts SHA-1 and SHA-256 commit ids", () => {
    expect(gitCommitShaSchema.safeParse("b".repeat(40)).success).toBe(true);
    expect(gitCommitShaSchema.safeParse("b".repeat(64)).success).toBe(true);
    expect(gitCommitShaSchema.safeParse("b".repeat(50)).success).toBe(false);
  });

  it("derives the GitHub URL from the full name", () => {
    expect(repositoryHtmlUrl("alice/app")).toBe("https://github.com/alice/app");
    expect(repositoryHtmlUrl("acme/my.repo-1")).toBe("https://github.com/acme/my.repo-1");
  });

  it("includes the workspace error codes", () => {
    expect(apiErrorCodeSchema.safeParse("workspace_not_found").success).toBe(true);
    expect(apiErrorCodeSchema.safeParse("repository_not_accessible").success).toBe(true);
  });

  it("status enums match the database", () => {
    expect(workspaceStatusSchema.options).toEqual([...Constants.public.Enums.workspace_status]);
    expect(interviewStatusSchema.options).toEqual([...Constants.public.Enums.interview_status]);
    expect(analysisStateSchema.options).toEqual([...Constants.public.Enums.job_status]);
  });
});
