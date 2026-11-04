import { createReportShareResponseSchema, reportShareParamSchema, reportShareStatusSchema } from "@stackprep/shared";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Authenticate } from "../_shared/auth.ts";
import { apiError, logGithubError } from "../_shared/github-errors.ts";
import { createCors, json } from "../_shared/http.ts";
import { generateShareToken, hashShareToken } from "../_shared/share-token.ts";

const FN = "report-shares";

/** Read with the caller's client, so RLS hides other users' and deleted interviews. */
export interface ReportShareReader {
  /** The interview's status, or null when it is not the caller's (or was deleted). */
  getInterviewStatus(interviewId: string): Promise<string | null>;
}

/** Service-role operations. Every call is scoped to the authenticated user's id. */
export interface ReportShareStore {
  /** When the share was created; null when the interview is not completed or has no report. */
  create(
    userId: string,
    interviewId: string,
    tokenHash: string,
  ): Promise<string | null>;
  revoke(userId: string, interviewId: string): Promise<boolean>;
  /** When the active share was created, or null. */
  getActive(userId: string, interviewId: string): Promise<string | null>;
}

export interface ReportSharesHandlerOptions {
  webOrigin: string;
  authenticate: Authenticate;
  reader: (client: SupabaseClient) => ReportShareReader;
  store: ReportShareStore;
}

export function createReportShareReader(
  client: SupabaseClient,
): ReportShareReader {
  return {
    async getInterviewStatus(interviewId) {
      const { data, error } = await client.from("interviews").select("status")
        .eq("id", interviewId).maybeSingle();
      if (error) {
        throw new Error(`Failed to load interview: ${error.message}`);
      }
      return (data as { status: string } | null)?.status ?? null;
    },
  };
}

export function createReportShareStore(
  serviceClient: SupabaseClient,
): ReportShareStore {
  async function rpc<T>(
    fn: string,
    args: Record<string, string>,
  ): Promise<T | null> {
    const { data, error } = await serviceClient.rpc(fn, args);
    if (error) {
      throw new Error(`${fn} failed: ${error.message}`);
    }
    return (data ?? null) as T | null;
  }

  return {
    create: (userId, interviewId, tokenHash) =>
      rpc<string>("create_report_share", {
        p_interview_id: interviewId,
        p_user_id: userId,
        p_token_hash: tokenHash,
      }),
    async revoke(userId, interviewId) {
      return (await rpc<boolean>("revoke_report_share", {
        p_interview_id: interviewId,
        p_user_id: userId,
      })) === true;
    },
    getActive: (userId, interviewId) =>
      rpc<string>("get_report_share", {
        p_interview_id: interviewId,
        p_user_id: userId,
      }),
  };
}

const ROUTE = /\/report-shares\/([^/]+)\/?$/;

export function createReportSharesHandler(
  { webOrigin, authenticate, reader, store }: ReportSharesHandlerOptions,
) {
  const cors = createCors(webOrigin, ["GET", "POST", "DELETE"]);

  return async (req: Request): Promise<Response> => {
    const rejected = cors.rejectOrigin(req);
    if (rejected) {
      return rejected;
    }
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors.headers });
    }

    const match = new URL(req.url).pathname.match(ROUTE);
    if (!match) {
      return apiError("not_found", cors);
    }
    if (!["GET", "POST", "DELETE"].includes(req.method)) {
      return apiError("method_not_allowed", cors, {
        Allow: "GET, POST, DELETE, OPTIONS",
      });
    }

    try {
      const ctx = await authenticate(req);
      if (!ctx) {
        return apiError("unauthorized", cors);
      }
      const interviewId = match[1];
      if (!reportShareParamSchema.safeParse(interviewId).success) {
        return apiError("interview_not_found", cors);
      }
      // Ownership comes from the caller's RLS client; the service role is used only afterwards.
      const status = await reader(ctx.supabase).getInterviewStatus(interviewId);
      if (status === null) {
        return apiError("interview_not_found", cors);
      }
      const userId = ctx.user.id;

      if (req.method === "GET") {
        const createdAt = await store.getActive(userId, interviewId);
        return json(
          reportShareStatusSchema.parse({
            active: createdAt !== null,
            created_at: createdAt,
          }),
          {
            headers: cors.headers,
          },
        );
      }

      if (req.method === "DELETE") {
        await store.revoke(userId, interviewId);
        return json(
          reportShareStatusSchema.parse({ active: false, created_at: null }),
          { headers: cors.headers },
        );
      }

      if (status !== "completed") {
        return apiError("interview_not_completed", cors);
      }
      const token = generateShareToken();
      const createdAt = await store.create(
        userId,
        interviewId,
        await hashShareToken(token),
      );
      if (createdAt === null) {
        return apiError("report_not_ready", cors);
      }
      // The only response that ever carries the token.
      return json(
        createReportShareResponseSchema.parse({ token, created_at: createdAt }),
        {
          status: 201,
          headers: cors.headers,
        },
      );
    } catch (err) {
      logGithubError(FN, err, { code: "internal_error" });
      return apiError("internal_error", cors);
    }
  };
}
