import { type CoverageMap, coverageMapSchema, RESUME_QUESTION_MAX_CHARS, type SessionResume } from "@stackprep/shared";
import type { SessionRecap } from "../_shared/realtime/instructions.ts";
import { resolveCurrentQuestion } from "./tools/evaluate-answer.ts";
import type { TranscriptMessage } from "./tools/types.ts";

/** Recent turns read when a session is minted; enough to find the current question and its answer. */
export const RESUME_MESSAGES = 12;

export interface ResumeContext {
  recap: SessionRecap;
  resume: SessionResume;
}

function coveredTopics(coverage: CoverageMap | null): string[] {
  return (coverage?.areas ?? [])
    .filter((area) => area.status !== "not_started")
    .map((area) => `${area.name} (${area.status === "covered" ? "covered" : "partly covered"})`);
}

/**
 * Builds the reconnect recap from persisted state: covered topics, the current question, and
 * whether the candidate's answer to it was received. Null on the first connection.
 */
export function buildResumeContext(
  { elapsedVoiceSeconds, coverageMap, messages }: { elapsedVoiceSeconds: number; coverageMap: unknown; messages: TranscriptMessage[] },
): ResumeContext | null {
  if (elapsedVoiceSeconds === 0 && messages.length === 0) {
    return null;
  }
  const coverage = coverageMapSchema.safeParse(coverageMap);
  const current = resolveCurrentQuestion(messages);
  const answer = current?.answer.map((m) => m.content.trim()).filter(Boolean).join(" ") ?? "";
  const question = current?.question.content.trim() || null;
  return {
    recap: {
      coveredTopics: coveredTopics(coverage.success ? coverage.data : null),
      currentQuestion: question,
      lastAnswer: answer || null,
    },
    resume: {
      last_turn_sequence: messages.reduce((max, m) => Math.max(max, m.sequence), 0),
      current_question: question ? question.slice(0, RESUME_QUESTION_MAX_CHARS) : null,
    },
  };
}
