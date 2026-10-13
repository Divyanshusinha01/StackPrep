import { expect, test } from "../support/fixtures";
import { loadE2EEnv } from "../support/env";
import { receivedInngestEvents } from "../support/fake-inngest";
import { installFakeRealtime } from "../support/fake-realtime";
import { passDeviceCheck } from "../support/lobby";
import { completePlanning, listTranscript, recordEvaluation, startInterview } from "../support/seed";

const ANSWER = "Requests hit the Next.js server first, then the functions read Postgres.";

test("ending from the live room saves the last answer and generates a report", async ({
  page,
  context,
  admin,
  user,
  workspace,
}) => {
  const realtime = await installFakeRealtime(context);
  const { interviewId } = await startInterview(admin, user, workspace);
  await completePlanning(admin, interviewId);

  await page.goto(`/interviews/${interviewId}`);
  await passDeviceCheck(page);
  await page.getByRole("button", { name: "Enter interview" }).click();
  await realtime.waitForOpen(page);

  await realtime.speak(page, "item_user_1");
  await realtime.transcribe(page, ANSWER);
  await expect.poll(async () => (await listTranscript(admin, interviewId)).length).toBe(1);
  await recordEvaluation(admin, user, interviewId);

  await page.getByRole("button", { name: "End interview" }).click();
  const confirm = page.getByRole("status").filter({ hasText: "Your report will be generated from the answers so far." });
  await confirm.getByRole("button", { name: "End interview" }).click();

  await expect(page.getByText("The interview is complete.")).toBeVisible();
  const { data } = await admin.from("interviews").select("status, termination_reason").eq("id", interviewId).single();
  expect(data).toEqual({ status: "completed", termination_reason: "user_ended" });

  const events = await receivedInngestEvents(loadE2EEnv().inngestPort);
  expect(events).toContainEqual(
    expect.objectContaining({
      name: "interview.report.requested",
      data: expect.objectContaining({ interview_id: interviewId }),
    }),
  );
  await expect(page).toHaveURL(new RegExp(`/interviews/${interviewId}/report$`));
});

test("ending from the paused screen before any answer was evaluated gives no report", async ({
  page,
  context,
  admin,
  user,
  workspace,
}) => {
  const realtime = await installFakeRealtime(context);
  const { interviewId } = await startInterview(admin, user, workspace);
  await completePlanning(admin, interviewId);

  await page.goto(`/interviews/${interviewId}`);
  await passDeviceCheck(page);
  await page.getByRole("button", { name: "Enter interview" }).click();
  await realtime.waitForOpen(page);

  await page.getByRole("button", { name: "Stop interview" }).click();
  await page.getByRole("status").getByRole("button", { name: "Stop interview" }).click();
  const paused = page.getByRole("region", { name: "Interview paused" });
  await expect(paused).toBeVisible();

  await paused.getByRole("button", { name: "End interview" }).click();
  await paused.getByRole("status").getByRole("button", { name: "End interview" }).click();

  await expect(paused.getByText("there is no report for it")).toBeVisible();
  await expect(paused.getByRole("button", { name: "Resume interview" })).toHaveCount(0);
  const { data } = await admin.from("interviews").select("status, termination_reason").eq("id", interviewId).single();
  expect(data).toEqual({ status: "terminated", termination_reason: "user_abandoned" });
});
