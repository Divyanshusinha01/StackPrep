import { z } from "zod";
import { storedInterviewReportSchema } from "./reports.ts";

// Read-only report links (architecture "Report sharing"). A link is a bearer token to one
// completed interview's report: report content only, never the transcript, and never any user,
// workspace or interview id.

/** 32 random bytes, base64url without padding. */
export const SHARE_TOKEN_LENGTH = 43;

export const shareTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

const timestampSchema = z.iso.datetime({ offset: true });

/** GET /report-shares/:interview_id. The token is never returned again after creation. */
export const reportShareStatusSchema = z.object({
  active: z.boolean(),
  created_at: timestampSchema.nullable(),
});

/** POST /report-shares/:interview_id. The only response that carries the token. */
export const createReportShareResponseSchema = z.object({
  token: shareTokenSchema,
  created_at: timestampSchema,
});

export const reportShareParamSchema = z.uuid();

/** GET /shared-reports/:token */
export const sharedReportResponseSchema = z.object({
  /** Null for a private repository, whose name is not shared. */
  repository: z.string().min(1).nullable(),
  interview_number: z.int().min(1),
  generated_at: timestampSchema,
  report: storedInterviewReportSchema,
});

export type ReportShareStatus = z.infer<typeof reportShareStatusSchema>;
export type CreateReportShareResponse = z.infer<typeof createReportShareResponseSchema>;
export type SharedReportResponse = z.infer<typeof sharedReportResponseSchema>;
