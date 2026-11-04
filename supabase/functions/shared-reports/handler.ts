import {
  type SharedReportResponse,
  sharedReportResponseSchema,
  shareTokenSchema,
  storedInterviewReportSchema,
} from "@stackprep/shared";
import type { SupabaseClient } from "@supabase/supabase-js";
import { apiError, logGithubError } from "../_shared/github-errors.ts";
import { createCors, json } from "../_shared/http.ts";
import { hashShareToken } from "../_shared/share-token.ts";

const FN = "shared-reports";

export interface SharedReportRecord {
  interview_number: number;
  repository_full_name: string;
  is_private: boolean;
  generated_at: string;
  content: unknown;
}

export interface SharedReportStore {
  /** The report behind an active share, or null for an unknown, revoked or deleted one. */
  resolve(tokenHash: string): Promise<SharedReportRecord | null>;
}

export interface SharedReportsHandlerOptions {
  webOrigin: string;
  store: SharedReportStore;
}

export function createSharedReportStore(
  serviceClient: SupabaseClient,
): SharedReportStore {
  return {
    async resolve(tokenHash) {
      const { data, error } = await serviceClient.rpc("resolve_report_share", {
        p_token_hash: tokenHash,
      });
      if (error) {
        throw new Error(`resolve_report_share failed: ${error.message}`);
      }
      return ((data as SharedReportRecord[] | null) ?? [])[0] ?? null;
    },
  };
}

const ROUTE = /\/shared-reports\/([^/]+)\/?$/;

/**
 * Public and unauthenticated: the unguessable token is the credential. Every miss (malformed,
 * unknown, revoked, deleted interview) is the same 404, so a response never confirms that a link
 * once existed. It returns report content only, never the transcript or any identifier.
 */
export function createSharedReportsHandler(
  { webOrigin, store }: SharedReportsHandlerOptions,
) {
  const cors = createCors(webOrigin, ["GET"]);
  const privacyHeaders = {
    "X-Robots-Tag": "noindex, nofollow",
    "Referrer-Policy": "no-referrer",
  };

  return async (req: Request): Promise<Response> => {
    const rejected = cors.rejectOrigin(req);
    if (rejected) {
      return rejected;
    }
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors.headers });
    }
    if (req.method !== "GET") {
      return apiError("method_not_allowed", cors, { Allow: "GET, OPTIONS" });
    }

    const match = new URL(req.url).pathname.match(ROUTE);
    const token = match ? shareTokenSchema.safeParse(match[1]) : null;
    if (!token?.success) {
      return apiError("not_found", cors, privacyHeaders);
    }

    try {
      const record = await store.resolve(await hashShareToken(token.data));
      const report = record ? storedInterviewReportSchema.safeParse(record.content) : null;
      if (!record || !report?.success) {
        return apiError("not_found", cors, privacyHeaders);
      }
      const body: SharedReportResponse = {
        repository: record.is_private ? null : record.repository_full_name,
        interview_number: record.interview_number,
        generated_at: new Date(record.generated_at).toISOString(),
        report: report.data,
      };
      return json(sharedReportResponseSchema.parse(body), {
        headers: { ...cors.headers, ...privacyHeaders },
      });
    } catch (err) {
      logGithubError(FN, err, { code: "internal_error" });
      return apiError("internal_error", cors, privacyHeaders);
    }
  };
}
