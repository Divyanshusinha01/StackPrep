import { expect, test } from "../support/fixtures";
import { LEARNING_REPORT, REPORT } from "../support/fixtures/report";
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
  // Reports stored before learning reports keep their original sections.
  await expect(report.getByRole("region", { name: "Question-by-question review" })).toHaveCount(0);
  await expect(
    page.getByRole("navigation", { name: "Report sections" }).getByRole("link", { name: "Category evaluation" }),
  ).toBeVisible();

  await page.goto(`/workspaces/${workspace.workspaceId}`);
  await row.getByRole("link", { name: "Report", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/interviews/${interviewId}/report$`));
  await expect(report).toBeVisible();
});

test("a legacy report can be regenerated as a learning report after confirmation", async ({
  page,
  admin,
  user,
  workspace,
}) => {
  const { interviewId } = await startInterview(admin, user, workspace);
  await completePlanning(admin, interviewId);
  await markConnected(admin, user, interviewId);
  await recordTranscript(admin, user, interviewId, [
    { role: "ai", content: QUESTION },
    { role: "user", content: ANSWER },
  ]);
  const firstJobId = await completeInterview(admin, user, interviewId);
  await saveReport(admin, interviewId, firstJobId, REPORT);

  await page.goto(`/interviews/${interviewId}/report`);
  const report = page.getByTestId("interview-report");
  await expect(report.getByRole("region", { name: "Category evaluation" })).toBeVisible();
  await expect(page.getByText("This report was generated before answer-by-answer reviews")).toBeVisible();

  // Cancelling the confirmation queues nothing.
  await page.getByRole("button", { name: "Regenerate report" }).click();
  const dialog = page.getByRole("alertdialog", { name: "Regenerate this report?" });
  await expect(dialog).toContainText("uses your OpenAI API key");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();

  await page.getByRole("button", { name: "Regenerate report" }).click();
  await dialog.getByRole("button", { name: "Regenerate report" }).click();
  await expect(page.getByText("Regenerating this report with answer reviews")).toBeVisible();
  // The legacy report stays readable while the new one is generated.
  await expect(report.getByRole("region", { name: "Category evaluation" })).toBeVisible();

  const { data: job, error } = await admin
    .from("jobs")
    .select("id")
    .eq("interview_id", interviewId)
    .eq("type", "report_generation")
    .eq("status", "queued")
    .single();
  expect(error).toBeNull();
  await saveReport(admin, interviewId, job!.id as string, LEARNING_REPORT);

  await expect(report).toHaveAttribute("data-report-version", "2");
  await expect(report.getByRole("region", { name: "Question-by-question review" })).toBeVisible();
  await expect(page.getByText("Regenerating this report with answer reviews")).toBeHidden();
  await expect(page.getByRole("button", { name: "Regenerate report" })).toHaveCount(0);
});

test("a learning report reviews each answer, links resources and fits a phone screen", async ({
  page,
  admin,
  user,
  workspace,
}) => {
  const { interviewId } = await startInterview(admin, user, workspace);
  await completePlanning(admin, interviewId);
  await markConnected(admin, user, interviewId);
  await recordTranscript(admin, user, interviewId, [
    { role: "ai", content: QUESTION },
    { role: "user", content: ANSWER },
  ]);
  const reportJobId = await completeInterview(admin, user, interviewId);
  await saveReport(admin, interviewId, reportJobId, LEARNING_REPORT);

  await page.goto(`/interviews/${interviewId}/report`);
  const report = page.getByTestId("interview-report");
  await expect(report).toHaveAttribute("data-report-version", "2");
  const toc = page.getByRole("navigation", { name: "Report sections" });
  for (const label of ["Question-by-question review", "Concepts to learn", "Prioritized learning plan"]) {
    await expect(toc.getByRole("link", { name: label })).toBeVisible();
  }

  const questions = report.getByRole("region", { name: "Question-by-question review" });
  const reviews = questions.locator("details");
  await expect(reviews).toHaveCount(4);
  for (const [i, label] of ["Correct", "Partially correct", "Incorrect", "Unanswered"].entries()) {
    await expect(reviews.nth(i).locator("summary")).toContainText(label);
  }

  // The first answer that was not fully correct starts open; the others are collapsed.
  await expect(reviews.nth(1).getByText("Reference answer 2.")).toBeVisible();
  await expect(reviews.nth(1)).toContainText("From your transcript");
  await expect(reviews.nth(1)).toContainText("AI-generated reference");
  await expect(reviews.nth(1)).toContainText("Retry with backoff for idempotent reads");
  await expect(reviews.nth(0).getByText("Reference answer 1.")).toBeHidden();

  const firstSummary = reviews.nth(0).locator("summary");
  await firstSummary.focus();
  await page.keyboard.press("Enter");
  await expect(reviews.nth(0).getByText("Reference answer 1.")).toBeVisible();
  await expect(reviews.nth(0)).toContainText(ANSWER);
  await page.keyboard.press("Enter");
  await expect(reviews.nth(0).getByText("Reference answer 1.")).toBeHidden();

  await reviews.nth(3).locator("summary").click();
  await expect(reviews.nth(3).getByText("No answer was recorded for this question.")).toBeVisible();

  const examples = report.getByRole("region", { name: "Improved answer examples" });
  const code = examples.getByRole("figure").filter({ hasText: "step.run" });
  await expect(code).toBeVisible();
  await expect(code).toContainText("ts");
  await expect(code.getByRole("button", { name: "Copy" })).toBeVisible();

  const concepts = report.getByRole("region", { name: "Concepts to learn" });
  const link = concepts.getByRole("link", { name: /Idempotent - MDN Web Docs Glossary/ });
  await expect(link).toHaveAttribute("href", "https://developer.mozilla.org/en-US/docs/Glossary/Idempotent");
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", "noopener noreferrer");
  await expect(concepts).toContainText("No reliable resources could be found for this concept right now.");

  const plan = report.getByRole("region", { name: "Prioritized learning plan" }).getByRole("listitem");
  await expect(plan).toHaveCount(2);
  await expect(plan.first()).toContainText("Write a two-step job");
  await expect(plan.first()).toContainText("45 min");

  await page.setViewportSize({ width: 375, height: 800 });
  await reviews.nth(2).locator("summary").click();
  await expect(reviews.nth(2)).toContainText("Steps are memoized");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
});
