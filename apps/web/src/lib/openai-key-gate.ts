import "server-only";
import { redirect } from "next/navigation";
import { getOpenAIKeyStatus } from "@/lib/api";
import { keyStatusSetupCode, type OpenAIKeySetupCode } from "@/lib/openai-key-setup";
import { onboardingSetupHref } from "@/lib/return-to";

/** What blocks AI features for the saved key; null when it works or its status could not be loaded. */
export async function currentKeySetupCode(): Promise<OpenAIKeySetupCode | null> {
  const status = await getOpenAIKeyStatus();
  return status.ok ? keyStatusSetupCode(status.data) : null;
}

/**
 * First-run gate: without a working key, send the user to Settings before any repository step.
 * Fails open when the status cannot be loaded; the API still refuses AI work without a key.
 */
export async function requireWorkingKey(returnTo: string): Promise<void> {
  if (await currentKeySetupCode()) {
    redirect(onboardingSetupHref(returnTo));
  }
}
