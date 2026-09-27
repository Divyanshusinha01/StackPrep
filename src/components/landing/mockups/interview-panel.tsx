"use client";

import { AnimatePresence, m } from "framer-motion";
import { Bot, Mic, PhoneOff, Search, Video } from "lucide-react";

import { cn } from "@/lib/utils";
import { useReducedMotion } from "@/components/motion/use-reduced-motion";
import { FileChip, Panel } from "./panel";

type Message = { role: "ai" | "user"; text: string; evidence?: string };

export const INTERVIEW_MESSAGES: Message[] = [
  {
    role: "ai",
    text: "Walk me through what happens when a request hits the checkout endpoint. Where does authentication happen?",
    evidence: "src/api/middleware.ts",
  },
  {
    role: "user",
    text: "Every API route goes through the middleware first. It validates the session cookie, loads the user, and only then hands off to the handler.",
  },
  {
    role: "ai",
    text: "You store sessions in Postgres instead of a signed token. Why that choice?",
    evidence: "src/auth/session.ts",
  },
  {
    role: "user",
    text: "I needed server-side revocation for “log out everywhere”, so one indexed lookup per request was a cost I was happy to pay.",
  },
  {
    role: "ai",
    text: "What happens if the payment provider delivers the same webhook twice?",
    evidence: "src/lib/queue.ts",
  },
  {
    role: "user",
    text: "The job is keyed on the provider’s event ID, so the second delivery is a no-op…",
  },
];

const EASE = [0.22, 1, 0.36, 1] as const;
const WAVE = [40, 70, 100, 55, 85, 35, 65, 90, 45, 75, 30, 60];

type InterviewPanelProps = {
  className?: string;
  /** Index of the latest visible message. Defaults to showing the full conversation. */
  activeIndex?: number;
};

export function InterviewPanel({
  className,
  activeIndex = INTERVIEW_MESSAGES.length - 1,
}: InterviewPanelProps) {
  const reduced = useReducedMotion();
  const pair = Math.floor(activeIndex / 2);
  const question = INTERVIEW_MESSAGES[pair * 2];
  const answer = activeIndex % 2 === 1 ? INTERVIEW_MESSAGES[activeIndex] : undefined;
  const speaker = INTERVIEW_MESSAGES[activeIndex]?.role ?? "ai";
  const duration = reduced ? 0 : 0.4;

  return (
    <Panel
      className={className}
      title="Interview 3 · acme/checkout-service"
      meta={
        <>
          <span className="size-1.5 rounded-full bg-destructive" aria-hidden />
          <span className="text-foreground/80">Live</span>
          <span className="tabular-nums">12:48 / 30:00</span>
        </>
      }
      bodyClassName="p-0"
    >
      <div className="grid grid-cols-2 gap-2 p-2 sm:gap-3 sm:p-3">
        <Tile label="StackPrep AI" speaking={speaker === "ai"}>
          <div className="relative flex items-center justify-center">
            {speaker === "ai" ? (
              <span
                className="absolute size-16 rounded-full bg-brand/20 motion-safe:animate-ping sm:size-20"
                aria-hidden
              />
            ) : null}
            <span className="relative flex size-14 items-center justify-center rounded-full border border-brand/40 bg-brand-muted text-brand sm:size-20">
              <Bot className="size-7 sm:size-9" aria-hidden />
            </span>
          </div>
        </Tile>

        <Tile label="You" speaking={speaker === "user"} className="bg-gradient-to-b from-panel-raised to-background">
          <div className="absolute inset-x-0 bottom-0 flex flex-col items-center" aria-hidden>
            <span className="size-12 rounded-full bg-foreground/15 sm:size-16" />
            <span className="mt-1.5 h-10 w-28 rounded-t-[3rem] bg-foreground/15 sm:h-14 sm:w-40" />
          </div>
        </Tile>

        <Transcript accent>
          <AnimatePresence mode="wait" initial={false}>
            <m.div
              key={pair}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration, ease: EASE }}
            >
              {question.evidence ? (
                <FileChip className="mb-2 max-w-full">
                  <Search className="size-3 shrink-0" aria-hidden />
                  <span className="truncate">Examining {question.evidence}</span>
                </FileChip>
              ) : null}
              <p className="text-xs leading-relaxed text-foreground sm:text-sm">{question.text}</p>
            </m.div>
          </AnimatePresence>
        </Transcript>

        <Transcript>
          <AnimatePresence mode="wait" initial={false}>
            <m.div
              key={answer ? `a${pair}` : `w${pair}`}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration, ease: EASE }}
            >
              {answer ? (
                <p className="text-xs leading-relaxed text-foreground/80 sm:text-sm">{answer.text}</p>
              ) : (
                <p className="font-mono text-[11px] text-muted-foreground">Listening…</p>
              )}
            </m.div>
          </AnimatePresence>
        </Transcript>
      </div>

      <div className="flex items-center gap-2 border-t px-3 py-2.5 sm:px-4">
        <span className="flex h-5 items-center gap-[3px]" aria-hidden>
          {WAVE.map((h, i) => (
            <span
              key={i}
              className="w-[3px] origin-center rounded-full bg-brand/70 motion-safe:animate-[wave_1.2s_ease-in-out_infinite]"
              style={{ height: `${h}%`, animationDelay: `${i * 90}ms` }}
            />
          ))}
        </span>
        <div className="mx-auto flex items-center gap-2" aria-hidden>
          <ControlButton>
            <Mic className="size-3.5" />
          </ControlButton>
          <ControlButton>
            <Video className="size-3.5" />
          </ControlButton>
          <span className="flex h-8 items-center justify-center rounded-full bg-destructive px-4 text-background">
            <PhoneOff className="size-3.5" />
          </span>
        </div>
        <span className="font-mono text-[11px] text-muted-foreground">Transcribing</span>
      </div>
    </Panel>
  );
}

function Tile({
  label,
  speaking,
  className,
  children,
}: {
  label: string;
  speaking: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "relative flex aspect-[4/3] items-center justify-center overflow-hidden rounded-lg border bg-background transition-shadow duration-300",
        speaking && "border-brand/60 shadow-[0_0_0_1px_var(--brand)]",
        className,
      )}
    >
      {children}
      <span className="absolute bottom-2 left-2 flex items-center gap-1.5 rounded bg-background/80 px-1.5 py-0.5 font-mono text-[10px] text-foreground/90 backdrop-blur-sm sm:text-[11px]">
        <Mic className={cn("size-3", speaking ? "text-brand" : "text-muted-foreground")} aria-hidden />
        {label}
      </span>
    </div>
  );
}

function Transcript({ accent, children }: { accent?: boolean; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        "min-h-28 rounded-lg border bg-panel-raised/50 p-3 sm:min-h-32",
        accent && "border-brand/20",
      )}
    >
      {children}
    </div>
  );
}

function ControlButton({ children }: { children: React.ReactNode }) {
  return (
    <span className="flex size-8 items-center justify-center rounded-full border bg-panel-raised text-foreground/80">
      {children}
    </span>
  );
}
