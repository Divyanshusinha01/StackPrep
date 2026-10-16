"use server";

import { interviewIdParamSchema } from "@stackprep/shared";
import { redirect } from "next/navigation";
import { retryInterviewReport, upgradeInterviewReport } from "@/lib/api";
import { requireUser } from "@/lib/auth";

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
