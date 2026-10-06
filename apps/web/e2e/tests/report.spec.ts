import { expect, test } from "../support/fixtures";
import { REPORT } from "../support/fixtures/report";
import {
  completeInterview,
  completePlanning,
  markConnected,
  recordTranscript,
  saveReport,
  startInterview,
} from "../support/seed";

const QUESTION = "How does a request reach the database?";
const ANSWER = "Through the API route, which calls the data layer.";

test("a completed interview shows its report once generated, and history links to it", async ({
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
    { role: "ai", content: QUESTION },
    { role: "user", content: ANSWER },
  ]);
  const reportJobId = await completeInterview(admin, user, interviewId);

  // A completed interview no longer opens the room.
  await page.goto(`/interviews/${interviewId}`);
  await expect(page).toHaveURL(new RegExp(`/interviews/${interviewId}/report$`));
  await expect(page.getByText("Generating your report.")).toBeVisible();
  const transcript = page.getByTestId("interview-transcript");
  await expect(transcript).toContainText(QUESTION);
  await expect(transcript).toContainText(ANSWER);

  await page.goto(`/workspaces/${workspace.workspaceId}`);
  const row = page
    .getByTestId("interview-history")
    .getByRole("listitem")
    .filter({ hasText: `Interview ${interview.interviewNumber}` });
  await expect(row).toContainText("Completed");
  await row.getByRole("link", { name: "Report generating…" }).click();
  await expect(page.getByText("Generating your report.")).toBeVisible();

  // The pending page polls until the report job's outcome is stored.
  await saveReport(admin, interviewId, reportJobId, REPORT);
  const report = page.getByTestId("interview-report");
  await expect(report.getByRole("region", { name: "Executive summary" })).toContainText(REPORT.executive_summary);
  await expect(report.getByRole("region", { name: "Category evaluation" })).toContainText("Proficient");
  await expect(page.getByText("Generating your report.")).toBeHidden();

  await page.goto(`/workspaces/${workspace.workspaceId}`);
  await row.getByRole("link", { name: "Report", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/interviews/${interviewId}/report$`));
  await expect(report).toBeVisible();
});
