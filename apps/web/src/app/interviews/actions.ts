"use server";

import { interviewIdParamSchema } from "@stackprep/shared";
import { redirect } from "next/navigation";
import { deleteInterview as deleteInterviewRequest } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { historyReturnPath } from "@/lib/return-to";

export async function deleteInterview(formData: FormData) {
  const returnTo = historyReturnPath(formData.get("return_to"));
  const parsed = interviewIdParamSchema.safeParse(formData.get("interview_id"));
  if (!parsed.success) {
    redirect(returnTo);
  }
  await requireUser(returnTo);

  const result = await deleteInterviewRequest(parsed.data);
  if (!result.ok) {
    redirect(`${returnTo}?delete_error=${result.code}`);
  }
  redirect(returnTo);
}
