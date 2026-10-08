import { expect, test } from "../support/fixtures";
import { completeInterview, completePlanning, markConnected, recordTranscript, startInterview } from "../support/seed";

test("an ended interview can be deleted from history and its report is no longer reachable", async ({
  page,
  admin,
  user,
  workspace,
}) => {
  const interview = await startInterview(admin, user, workspace);
  const { interviewId } = interview;
  await completePlanning(admin, interviewId);
  await markConnected(admin, user, interviewId);
  await recordTranscript(admin, user, interviewId, [
    { role: "ai", content: "How does a request reach the database?" },
    { role: "user", content: "Through the API route." },
  ]);
  await completeInterview(admin, user, interviewId);

  await page.goto("/interviews");
  const row = page
    .getByTestId("interview-history")
    .getByRole("listitem")
    .filter({ hasText: `Interview ${interview.interviewNumber}` });
  const deleteButton = row.getByRole("button", { name: `Delete Interview ${interview.interviewNumber}` });

  // Dismissing the confirm keeps the interview.
  page.once("dialog", (dialog) => dialog.dismiss());
  await deleteButton.click();
  await expect(row).toBeVisible();

  page.once("dialog", (dialog) => {
    expect(dialog.message()).toContain("still counts toward your daily interview limit");
    return dialog.accept();
  });
  await deleteButton.click();
  await expect(row).toHaveCount(0);
  await expect(page).toHaveURL(/\/interviews$/);

  await page.goto(`/workspaces/${workspace.workspaceId}`);
  await expect(page.getByText(`Interview ${interview.interviewNumber}`, { exact: true })).toHaveCount(0);

  const report = await page.goto(`/interviews/${interviewId}/report`);
  expect(report?.status()).toBe(404);

  const { data } = await admin.from("interviews").select("deleted_at").eq("id", interviewId).single();
  expect(data?.deleted_at).not.toBeNull();
});
