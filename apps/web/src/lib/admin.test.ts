import { parseAdminUserIds } from "@stackprep/shared";
import type { User } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const adminId = "aaaaaaaa-0000-4000-8000-000000000001";
const otherId = "bbbbbbbb-0000-4000-8000-000000000002";

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  invoke: vi.fn(),
  createSupabaseServerClient: vi.fn(),
  adminUserIds: { current: new Set<string>() as ReadonlySet<string> },
}));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("@/lib/auth", () => ({ getUser: mocks.getUser }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: mocks.createSupabaseServerClient }));
vi.mock("@/env", () => ({
  adminEnv: {
    get ADMIN_USER_IDS() {
      return mocks.adminUserIds.current;
    },
  },
}));

const { authorizeAdmin, getAdminMetrics, requireAdmin } = await import("./admin");

const user = (id: string, email = "admin@example.com") => ({ id, email }) as User;

const metrics = {
  window_days: 30,
  interview_cost: [],
  voice_text_split: [],
  cache_hit_rate: [{ channel: "text", calls: 1, input_tokens: "10", cached_input_tokens: "5", hit_rate: 0.5 }],
  tool_latency: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.adminUserIds.current = parseAdminUserIds(adminId);
  mocks.createSupabaseServerClient.mockResolvedValue({ functions: { invoke: mocks.invoke } });
  mocks.invoke.mockResolvedValue({ data: metrics, error: null });
});

describe("authorizeAdmin", () => {
  it("passes an allowlisted id and denies everyone else", () => {
    const ids = parseAdminUserIds(adminId);
    expect(authorizeAdmin(user(adminId), ids)?.id).toBe(adminId);
    expect(authorizeAdmin(user(otherId), ids)).toBeNull();
    expect(authorizeAdmin(null, ids)).toBeNull();
    expect(authorizeAdmin(user(adminId), new Set())).toBeNull();
  });

  it("never authorizes by email", () => {
    const ids = parseAdminUserIds("admin@example.com");
    expect(authorizeAdmin(user(otherId, "admin@example.com"), ids)).toBeNull();
  });
});

describe("requireAdmin", () => {
  it("returns 404 for an unauthenticated visitor", async () => {
    mocks.getUser.mockResolvedValue(null);
    await expect(requireAdmin()).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("returns 404 for a signed-in non-admin", async () => {
    mocks.getUser.mockResolvedValue(user(otherId));
    await expect(requireAdmin()).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("returns 404 for everyone when the allowlist is empty or malformed", async () => {
    mocks.getUser.mockResolvedValue(user(adminId));
    for (const raw of [undefined, "", `${adminId},nope`]) {
      mocks.adminUserIds.current = parseAdminUserIds(raw);
      await expect(requireAdmin()).rejects.toThrow("NEXT_NOT_FOUND");
    }
  });

  it("returns the verified admin", async () => {
    mocks.getUser.mockResolvedValue(user(adminId));
    await expect(requireAdmin()).resolves.toMatchObject({ id: adminId });
  });
});

describe("getAdminMetrics", () => {
  it("fetches nothing unless the caller is an admin", async () => {
    for (const caller of [null, user(otherId)]) {
      mocks.getUser.mockResolvedValue(caller);
      await expect(getAdminMetrics(7)).rejects.toThrow("NEXT_NOT_FOUND");
    }
    expect(mocks.createSupabaseServerClient).not.toHaveBeenCalled();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("calls only the admin metrics endpoint with the requested window", async () => {
    mocks.getUser.mockResolvedValue(user(adminId));
    const result = await getAdminMetrics(30);
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith("admin/metrics?days=30", { method: "GET" });
    expect(result?.cache_hit_rate[0]?.cached_input_tokens).toBe(5);
  });

  it("returns null when the backend refuses or answers garbage", async () => {
    mocks.getUser.mockResolvedValue(user(adminId));
    mocks.invoke.mockResolvedValueOnce({ data: null, error: new Error("404") });
    expect(await getAdminMetrics(7)).toBeNull();
    mocks.invoke.mockResolvedValueOnce({ data: { window_days: 7 }, error: null });
    expect(await getAdminMetrics(7)).toBeNull();
  });
});
