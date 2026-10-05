"use server";

import { interviewIdParamSchema } from "@stackprep/shared";
import { redirect } from "next/navigation";
import { retryInterviewReport } from "@/lib/api";
import { requireUser } from "@/lib/auth";

export async function retryReport(formData: FormData) {
  const parsed = interviewIdParamSchema.safeParse(formData.get("interview_id"));
  if (!parsed.success) {
    redirect("/interviews");
  }
  const path = `/interviews/${encodeURIComponent(parsed.data)}/report`;
  await requireUser(path);

  const result = await retryInterviewReport(parsed.data);
  if (!result.ok) {
    redirect(`${path}?retry_error=${result.code}`);
  }
  redirect(path);
}
