"use client";

import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";

/** A fenced code sample from an AI-written answer: monospace, horizontally scrollable, copyable. */
export function CodeBlock({ code, language }: { code: string; language: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) {
      return;
    }
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <figure className="my-3 overflow-hidden rounded-lg border border-border-strong/60 bg-background/70 print:break-inside-avoid">
      <figcaption className="flex items-center justify-between gap-2 border-b border-border/70 bg-panel-raised/50 px-3 py-1.5">
        <span className="font-mono text-[11px] tracking-wider text-muted-foreground uppercase">
          {language || "code"}
        </span>
        <button
          type="button"
          onClick={copy}
          className="focus-ring inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground print:hidden"
        >
          {copied ? <Check className="size-3.5 text-success" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
          {copied ? "Copied" : "Copy"}
        </button>
      </figcaption>
      <pre
        tabIndex={0}
        aria-label={`${language || "Code"} example`}
        className="focus-ring overflow-x-auto p-3 font-mono text-[12.5px] leading-relaxed text-foreground/95 print:whitespace-pre-wrap"
      >
        <code>{code}</code>
      </pre>
      <span role="status" aria-live="polite" className="sr-only">
        {copied ? "Code copied to clipboard" : ""}
      </span>
    </figure>
  );
}
