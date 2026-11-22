"use server";

import { interviewIdParamSchema } from "@stackprep/shared";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createReportShare, retryInterviewReport, revokeReportShare, upgradeInterviewReport } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { SITE_URL } from "@/lib/site";

async function reportAction(
  formData: FormData,
  request: typeof retryInterviewReport,
  errorParam: "retry_error" | "upgrade_error",
) {
  const parsed = interviewIdParamSchema.safeParse(formData.get("interview_id"));
  if (!parsed.success) {
    redirect("/interviews");
  }
  const path = `/interviews/${encodeURIComponent(parsed.data)}/report`;
  await requireUser(path);

  const result = await request(parsed.data);
  if (!result.ok) {
    redirect(`${path}?${errorParam}=${result.code}`);
  }
  redirect(path);
}

export async function retryReport(formData: FormData) {
  await reportAction(formData, retryInterviewReport, "retry_error");
}

/** Regenerates a legacy report as a learning report; the page asks for confirmation first. */
export async function upgradeReport(formData: FormData) {
  await reportAction(formData, upgradeInterviewReport, "upgrade_error");
}

export type ShareState =
  | { status: "idle" }
  /** The link is only ever visible in this state; it cannot be fetched again. */
  | { status: "created"; url: string }
  | { status: "revoked" }
  | { status: "error"; code: string };

async function shareAction(
  formData: FormData,
  run: (interviewId: string, path: string) => Promise<ShareState>,
): Promise<ShareState> {
  const parsed = interviewIdParamSchema.safeParse(formData.get("interview_id"));
  if (!parsed.success) {
    return { status: "error", code: "interview_not_found" };
  }
  const path = `/interviews/${encodeURIComponent(parsed.data)}/report`;
  await requireUser(path);
  const state = await run(parsed.data, path);
  revalidatePath(path);
  return state;
}

/** Creates a read-only link, replacing any active one. The previous link stops working. */
export async function createShareLink(_previous: ShareState, formData: FormData): Promise<ShareState> {
  return shareAction(formData, async (interviewId) => {
    const result = await createReportShare(interviewId);
    return result.ok
      ? { status: "created", url: `${SITE_URL}/r/${result.data.token}` }
      : { status: "error", code: result.code };
  });
}

export async function revokeShareLink(_previous: ShareState, formData: FormData): Promise<ShareState> {
  return shareAction(formData, async (interviewId) => {
    const result = await revokeReportShare(interviewId);
    return result.ok ? { status: "revoked" } : { status: "error", code: result.code };
  });
}