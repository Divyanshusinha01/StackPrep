import type { ReportErrorCode } from "@stackprep/shared";
import type { SupabaseClient } from "@supabase/supabase-js";
import { logGithubError } from "../_shared/github-errors.ts";
import type { JobQueue } from "../_shared/jobs.ts";

const FN = "interviews";

export const REPORT_ENQUEUE_FAILED_MESSAGE = "The interview report could not be queued";

/** Service-role writes for report jobs. Every call is keyed by an interview the caller owns. */
export interface ReportJobStore {
  /**
   * Queues a report_generation job. Null when the interview is not the user's, is not completed,
   * already has a report, or already has an active report job.
   */
  requestReportJob(interviewId: string, userId: string): Promise<string | null>;
  setReportJobEventId(jobId: string, eventId: string): Promise<void>;
  failReportJob(jobId: string, code: ReportErrorCode, message: string): Promise<void>;
}

export interface ReportInterview {
  id: string;
  workspace_id: string;
}

/** `skipped`: nothing to queue (see `requestReportJob`); `failed`: the job could not be queued. */
export type ReportRequestOutcome = "queued" | "skipped" | "failed";

function check(action: string, error: { message: string } | null): void {
  if (error) {
    throw new Error(`Failed to ${action}: ${error.message}`);
  }
}

export function createReportJobStore(serviceClient: SupabaseClient): ReportJobStore {
  return {
    async requestReportJob(interviewId, userId) {
      const { data, error } = await serviceClient.rpc("request_report", {
        p_interview_id: interviewId,
        p_user_id: userId,
      });
      check("request report", error);
      return typeof data === "string" ? data : null;
    },
    async setReportJobEventId(jobId, eventId) {
      const { error } = await serviceClient
        .from("jobs")
        .update({ inngest_event_id: eventId })
        .eq("id", jobId)
        .eq("type", "report_generation");
      check("record report event id", error);
    },
    async failReportJob(jobId, code, message) {
      const { error } = await serviceClient
        .from("jobs")
        .update({ status: "failed", error_code: code, error_message: message, finished_at: new Date().toISOString() })
        .eq("id", jobId)
        .eq("type", "report_generation")
        .neq("status", "succeeded");
      check("record report failure", error);
    },
  };
}

/**
 * Queues report generation for a completed interview. Best effort and never throws: if the event
 * cannot be sent, the job is marked failed (`enqueue_failed`) so the user can retry instead of
 * waiting on a run that never starts.
 */
export async function requestReport(
  deps: { jobs: JobQueue; store: ReportJobStore },
  interview: ReportInterview,
  userId: string,
): Promise<ReportRequestOutcome> {
  const logCtx = { workspace_id: interview.workspace_id, interview_id: interview.id };
  let jobId: string | null;
  try {
    jobId = await deps.store.requestReportJob(interview.id, userId);
  } catch (err) {
    logGithubError(FN, err, { ...logCtx, event: "report_request_failed", code: "internal_error" });
    return "failed";
  }
  if (jobId === null) {
    return "skipped";
  }

  let eventId: string | null;
  try {
    ({ eventId } = await deps.jobs.enqueue("interview.report.requested", {
      interview_id: interview.id,
      workspace_id: interview.workspace_id,
      job_id: jobId,
    }));
  } catch (err) {
    logGithubError(FN, err, { ...logCtx, event: "report_enqueue_failed", code: "internal_error" });
    try {
      await deps.store.failReportJob(jobId, "enqueue_failed", REPORT_ENQUEUE_FAILED_MESSAGE);
    } catch (failErr) {
      logGithubError(FN, failErr, { ...logCtx, event: "report_fail_record_failed", code: "internal_error" });
    }
    return "failed";
  }
  if (eventId !== null) {
    try {
      await deps.store.setReportJobEventId(jobId, eventId);
    } catch (err) {
      logGithubError(FN, err, { ...logCtx, event: "report_job_event_id_failed", code: "internal_error" });
    }
  }
  return "queued";
}
