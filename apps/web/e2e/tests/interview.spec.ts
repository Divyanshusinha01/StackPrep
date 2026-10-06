import { expect, test } from "../support/fixtures";
import { loadE2EEnv } from "../support/env";
import { receivedInngestEvents } from "../support/fake-inngest";
import { installFakeRealtime } from "../support/fake-realtime";
import { passDeviceCheck } from "../support/lobby";
import { completePlanning, listTranscript, startInterview } from "../support/seed";

const QUESTION = "Give me a quick tour of how a request flows through this repository.";
const ANSWER = "Requests hit the Next.js server first, then the functions read Postgres.";

const INTERVIEW_URL = /\/interviews\/([0-9a-f-]{36})$/;

test("starting an interview opens the lobby, which waits for the plan and the device check", async ({
  page,
  admin,
  workspace,
}) => {
  await page.goto(`/workspaces/${workspace.workspaceId}`);
  await page.getByRole("button", { name: "Start Interview" }).click();
  await expect(page).toHaveURL(INTERVIEW_URL);
  const interviewId = INTERVIEW_URL.exec(page.url())![1];

  // The backend really enqueued planning (to the fake Inngest event API).
  const events = await receivedInngestEvents(loadE2EEnv().inngestPort);
  expect(events).toContainEqual(
    expect.objectContaining({
      name: "interview.planning.requested",
      data: expect.objectContaining({ interview_id: interviewId, workspace_id: workspace.workspaceId }),
    }),
  );

  const planning = page.getByRole("region", { name: "Interview plan" });
  const enter = page.getByRole("button", { name: "Enter interview" });
  await expect(planning).toContainText("Preparing your interview…");
  await expect(enter).toBeDisabled();

  await completePlanning(admin, interviewId);
  await expect(planning).toContainText("Ready");
  await expect(enter).toBeDisabled();

  await passDeviceCheck(page);
  await expect(enter).toBeEnabled();
  await expect(page.getByText("Ready. The interviewer will speak first; answer out loud.")).toBeVisible();
});

test("the live room shows both sides of the conversation and stores each turn", async ({
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
  await expect(page.getByText("Live", { exact: true })).toBeVisible();
  expect(realtime.sessionRequests).toBe(1);

  await realtime.emit(page, { type: "response.output_audio_transcript.delta", item_id: "item_ai_1", delta: "Give me a quick tour" });
  await realtime.emit(page, { type: "response.output_audio_transcript.done", item_id: "item_ai_1", transcript: QUESTION });
  await realtime.emit(page, { type: "input_audio_buffer.speech_started", item_id: "item_user_1" });
  await realtime.emit(page, {
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "item_user_1",
    transcript: ANSWER,
  });

  await expect(page.getByRole("region", { name: "Interviewer" }).getByRole("log")).toContainText(QUESTION);
  await expect(page.getByRole("region", { name: "You" }).getByRole("log")).toContainText(ANSWER);

  // Persisted through the real outbox and POST /interviews/:id/events.
  await expect
    .poll(async () => (await listTranscript(admin, interviewId)).map(({ role, content }) => ({ role, content })))
    .toEqual([
      { role: "ai", content: QUESTION },
      { role: "user", content: ANSWER },
    ]);
  // The stored `connected` event started the interview.
  await expect
    .poll(async () => (await admin.from("interviews").select("status").eq("id", interviewId).single()).data?.status)
    .toBe("in_progress");
});
