import { describe, expect, it } from "vitest";
import {
  apiErrorSchema,
  connectGithubRequestSchema,
  connectGithubResponseSchema,
  connectionStatusSchema,
  repositoryListQuerySchema,
  repositoryListResponseSchema,
  repositorySchema,
} from "./github.ts";

const connId = "aaaaaaaa-0000-4000-8000-000000000001";

describe("connectGithubRequestSchema", () => {
  it("accepts a valid body and trims the code", () => {
    expect(connectGithubRequestSchema.parse({ code: " abc_DEF-123 ", installation_id: 42 })).toEqual({
      code: "abc_DEF-123",
      installation_id: 42,
    });
  });

  it.each([
    ["missing code", { installation_id: 1 }],
    ["missing installation_id", { code: "abc" }],
    ["empty code", { code: "  ", installation_id: 1 }],
    ["bad code charset", { code: "abc def", installation_id: 1 }],
    ["code too long", { code: "a".repeat(513), installation_id: 1 }],
    ["zero installation_id", { code: "abc", installation_id: 0 }],
    ["negative installation_id", { code: "abc", installation_id: -1 }],
    ["fractional installation_id", { code: "abc", installation_id: 1.5 }],
    ["string installation_id", { code: "abc", installation_id: "1" }],
    ["unsafe installation_id", { code: "abc", installation_id: 2 ** 53 }],
    ["extra key", { code: "abc", installation_id: 1, user_id: connId }],
  ])("rejects %s", (_label, body) => {
    expect(connectGithubRequestSchema.safeParse(body).success).toBe(false);
  });
});

describe("connectGithubResponseSchema", () => {
  const connection = {
    id: connId,
    account_login: "alice",
    account_type: "User",
    repository_selection: "all",
    suspended: false,
  };

  it("accepts a connection and strips unknown fields", () => {
    expect(connectGithubResponseSchema.parse({ connection: { ...connection, token: "ghs_x" } })).toEqual({
      connection,
    });
  });

  it("rejects an unsupported account type", () => {
    expect(
      connectGithubResponseSchema.safeParse({ connection: { ...connection, account_type: "Enterprise" } }).success,
    ).toBe(false);
  });
});

describe("repositoryListQuerySchema", () => {
  it("applies defaults", () => {
    expect(repositoryListQuerySchema.parse({})).toEqual({ page: 1, per_page: 30 });
  });

  it("parses valid values", () => {
    expect(repositoryListQuerySchema.parse({ page: "1000", per_page: "100", connection_id: connId })).toEqual({
      page: 1000,
      per_page: 100,
      connection_id: connId,
    });
  });

  it.each([
    { page: "0" },
    { page: "1001" },
    { page: "abc" },
    { page: "1.5" },
    { page: "01" },
    { page: "" },
    { per_page: "0" },
    { per_page: "101" },
    { connection_id: "not-a-uuid" },
    { foo: "bar" },
  ])("rejects %o", (query) => {
    expect(repositoryListQuerySchema.safeParse(query).success).toBe(false);
  });
});

describe("repositorySchema", () => {
  const repo = {
    id: 1,
    connection_id: connId,
    owner: "alice",
    name: "app",
    full_name: "alice/app",
    is_private: false,
    default_branch: "main",
    html_url: "https://github.com/alice/app",
  };

  it("accepts a repository", () => {
    expect(repositorySchema.parse(repo)).toEqual(repo);
  });

  it("rejects a non-https url and a non-positive id", () => {
    expect(repositorySchema.safeParse({ ...repo, html_url: "javascript:alert(1)" }).success).toBe(false);
    expect(repositorySchema.safeParse({ ...repo, id: 0 }).success).toBe(false);
  });
});

describe("connectionStatusSchema", () => {
  it("accepts lifecycle statuses and errors with a code", () => {
    expect(connectionStatusSchema.parse({ id: connId, account_login: "a", status: "removed" })).toEqual({
      id: connId,
      account_login: "a",
      status: "removed",
    });
    expect(
      connectionStatusSchema.parse({ id: connId, account_login: "a", status: "error", code: "github_unavailable" }),
    ).toMatchObject({ code: "github_unavailable" });
  });

  it("requires a known code for errors", () => {
    expect(connectionStatusSchema.safeParse({ id: connId, account_login: "a", status: "error" }).success).toBe(false);
    expect(
      connectionStatusSchema.safeParse({ id: connId, account_login: "a", status: "error", code: "internal_error" })
        .success,
    ).toBe(false);
  });

  it("strips a code from non-error statuses", () => {
    expect(
      connectionStatusSchema.parse({ id: connId, account_login: "a", status: "ok", code: "github_unavailable" }),
    ).toEqual({ id: connId, account_login: "a", status: "ok" });
  });
});

describe("repositoryListResponseSchema", () => {
  it("accepts an empty, disconnected response", () => {
    const body = {
      connected: false,
      repositories: [],
      connections: [],
      page: 1,
      per_page: 30,
      total: 0,
      has_more: false,
      truncated: false,
    };
    expect(repositoryListResponseSchema.parse(body)).toEqual(body);
  });

  it("rejects a missing field", () => {
    expect(repositoryListResponseSchema.safeParse({ connected: true }).success).toBe(false);
  });
});

describe("apiErrorSchema", () => {
  it("accepts known codes and rejects unknown ones", () => {
    expect(apiErrorSchema.parse({ error: "Unauthorized", code: "unauthorized" })).toEqual({
      error: "Unauthorized",
      code: "unauthorized",
    });
    expect(apiErrorSchema.safeParse({ error: "x", code: "nope" }).success).toBe(false);
  });
});
