import type { PauseReason } from "@stackprep/shared";
import { DEVICE_ROOM_ERRORS } from "@/components/app/device-copy";
import type { RealtimeErrorCode } from "@/components/app/use-realtime-interview";

export const ROOM_ERRORS: Partial<Record<RealtimeErrorCode, string>> = {
  ...DEVICE_ROOM_ERRORS,
  connection_failed: "Could not connect to the voice interviewer. Check your connection and try again.",
  connection_lost:
    "We could not reconnect automatically. Your voice time is paused and your answers are saved; reconnect to continue.",
  idle_timeout:
    "We didn't hear anything for 3 minutes, so the voice session was closed. Your voice time is paused and your answers are saved; reconnect when you're ready.",
  realtime_unavailable: "The voice interviewer is unavailable right now. Try again in a moment.",
  openai_rate_limited: "Your OpenAI account is rate limited right now. Your answers are saved; wait a moment, then reconnect.",
  openai_unavailable: "OpenAI could not be reached. Your answers are saved and your key was not changed; reconnect in a moment.",
  interview_preparing: "The interview is still being prepared. Retrying shortly…",
  interview_planning_failed: "This interview could not be prepared. Start a new interview from the workspace.",
  interview_not_active: "This interview has ended.",
  interview_not_found: "This interview could not be found.",
  unauthorized: "Your session expired. Sign in again to continue.",
};

export const PAUSE_REASONS: Record<PauseReason, string> = {
  camera: "Your camera stopped",
  microphone: "Your microphone stopped",
  network: "Your network connection dropped",
  connection: "The connection to the interviewer dropped",
};

export const SYNC_ERROR_MESSAGE = "Some interview updates could not be saved. You can keep going.";
