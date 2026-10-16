import type { OpenAIKeyStatus, OpenAIKeyStatusResponse } from "@stackprep/shared";

// Client-safe: error codes that mean the user's OpenAI key needs attention, and what to tell them.

export const OPENAI_KEY_SETUP_MESSAGES = {
  openai_key_required: "Add your OpenAI API key in Settings to use AI features.",
  openai_key_unavailable: "Add your OpenAI API key in Settings to use AI features.",
  openai_key_invalid: "Your OpenAI API key was rejected or revoked. Replace it in Settings.",
  openai_key_permission_denied: "Your OpenAI API key cannot use a model StackPrep needs. Check its project permissions.",
  openai_quota_exhausted: "Your OpenAI account has no remaining quota. Add credit or raise its limit on OpenAI, then re-check the key.",
} as const;

export type OpenAIKeySetupCode = keyof typeof OPENAI_KEY_SETUP_MESSAGES;

export function isOpenAIKeySetupCode(code: unknown): code is OpenAIKeySetupCode {
  return typeof code === "string" && Object.hasOwn(OPENAI_KEY_SETUP_MESSAGES, code);
}

/** The Settings link label for each key problem; quota is fixed on OpenAI, then re-checked in Settings. */
export const OPENAI_KEY_SETUP_ACTIONS: Record<OpenAIKeySetupCode, string> = {
  openai_key_required: "Add key",
  openai_key_unavailable: "Add key",
  openai_key_invalid: "Replace key",
  openai_key_permission_denied: "Open Settings",
  openai_quota_exhausted: "Re-check key",
};

/** OpenAI-side failures that leave the key untouched; the user only needs to try again. */
export const OPENAI_TRANSIENT_MESSAGES = {
  openai_rate_limited: "Your OpenAI account is rate limited right now. Wait a moment, then try again.",
  openai_unavailable: "OpenAI could not be reached. Your key was not changed; try again in a moment.",
} as const;

const STATUS_CODES: Record<OpenAIKeyStatus, OpenAIKeySetupCode | null> = {
  valid: null,
  invalid: "openai_key_invalid",
  quota_exhausted: "openai_quota_exhausted",
  permission_denied: "openai_key_permission_denied",
};

/** What blocks AI features for this key status, or null when the key works. */
export function keyStatusSetupCode(status: OpenAIKeyStatusResponse): OpenAIKeySetupCode | null {
  return status.configured ? STATUS_CODES[status.status] : "openai_key_required";
}

export const ONBOARDING_STEP_LABELS = ["Sign in with GitHub", "Add your OpenAI API key", "Connect GitHub and choose a repository"] as const;

export type OnboardingStepState = "done" | "current" | "upcoming";

/** First-run progress: signing in is always done, and the key step comes before any repository. */
export function onboardingStepStates(keyReady: boolean): readonly OnboardingStepState[] {
  return keyReady ? ["done", "done", "current"] : ["done", "current", "upcoming"];
}
