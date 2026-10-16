import { describe, expect, it } from "vitest";
import {
  isOpenAIKeySetupCode,
  keyStatusSetupCode,
  ONBOARDING_STEP_LABELS,
  OPENAI_KEY_SETUP_ACTIONS,
  OPENAI_KEY_SETUP_MESSAGES,
  OPENAI_TRANSIENT_MESSAGES,
  onboardingStepStates,
} from "./openai-key-setup";

describe("keyStatusSetupCode", () => {
  it("asks for a key when none is saved and clears once it works", () => {
    expect(keyStatusSetupCode({ configured: false })).toBe("openai_key_required");
    expect(
      keyStatusSetupCode({ configured: true, status: "valid", key_hint: "sk-...abcd", validated_at: null, last_error_code: null }),
    ).toBeNull();
  });

  it("maps each failing status to its own setup code", () => {
    const base = { configured: true, key_hint: "sk-...abcd", validated_at: null, last_error_code: null } as const;
    expect(keyStatusSetupCode({ ...base, status: "invalid" })).toBe("openai_key_invalid");
    expect(keyStatusSetupCode({ ...base, status: "quota_exhausted" })).toBe("openai_quota_exhausted");
    expect(keyStatusSetupCode({ ...base, status: "permission_denied" })).toBe("openai_key_permission_denied");
  });
});

describe("setup prompts", () => {
  it("gives every key problem an action label", () => {
    expect(Object.keys(OPENAI_KEY_SETUP_ACTIONS).sort()).toEqual(Object.keys(OPENAI_KEY_SETUP_MESSAGES).sort());
  });

  it("does not send transient OpenAI failures to Settings", () => {
    for (const code of Object.keys(OPENAI_TRANSIENT_MESSAGES)) {
      expect(isOpenAIKeySetupCode(code)).toBe(false);
    }
  });
});

describe("onboardingStepStates", () => {
  it("puts the key step before the repository step", () => {
    expect(ONBOARDING_STEP_LABELS[1]).toMatch(/OpenAI API key/);
    expect(onboardingStepStates(false)).toEqual(["done", "current", "upcoming"]);
    expect(onboardingStepStates(true)).toEqual(["done", "done", "current"]);
  });
});
