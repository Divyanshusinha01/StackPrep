import Link from "next/link";
import { ExternalLink, KeyRound } from "lucide-react";
import { Notice } from "@/components/app/notice";
import { Button } from "@/components/ui/button";
import { OPENAI_KEY_SETUP_ACTIONS, OPENAI_KEY_SETUP_MESSAGES, type OpenAIKeySetupCode } from "@/lib/openai-key-setup";
import { openAIKeySetupHref } from "@/lib/return-to";

/** A key problem with a direct link to Settings that comes back to `returnTo`. */
export function OpenAIKeyNotice({ code, returnTo, detail, className }: {
  code: OpenAIKeySetupCode;
  returnTo?: string;
  /** What happens to the user's work meanwhile, shown under the message. */
  detail?: string;
  className?: string;
}) {
  return (
    <Notice tone="warning" className={className}>
      <span className="min-w-0 flex-1">
        <span className="block" data-testid="openai-key-notice">
          {OPENAI_KEY_SETUP_MESSAGES[code]}
        </span>
        {detail ? <span className="mt-1 block text-xs opacity-90">{detail}</span> : null}
      </span>
      {code === "openai_quota_exhausted" ? (
        <Button asChild variant="ghost" size="sm">
          <a href="https://platform.openai.com/settings/organization/billing/overview" target="_blank" rel="noreferrer">
            OpenAI billing
            <ExternalLink aria-hidden />
            <span className="sr-only">(opens in a new tab)</span>
          </a>
        </Button>
      ) : null}
      <Button asChild variant="outline" size="sm">
        <Link href={openAIKeySetupHref(returnTo)}>
          <KeyRound aria-hidden />
          {OPENAI_KEY_SETUP_ACTIONS[code]}
        </Link>
      </Button>
    </Notice>
  );
}
