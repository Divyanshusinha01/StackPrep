import {
  deleteInterviewResponseSchema,
  endInterviewResponseSchema,
  INITIAL_INTERVIEW_STREAM_CURSOR,
  type IntegrityFrameResponse,
  integrityFrameRequestSchema,
  integrityFrameResponseSchema,
  INTEGRITY_FRAME_MAX_CHARS,
  type InterviewEventAck,
  interviewEventAckSchema,
  interviewEventRequestSchema,
  interviewIdParamSchema,
  interviewPlanSchema,
  type InterviewReportResponse,
  interviewReportResponseSchema,
  interviewReportSchema,
  type InterviewStatus,
  MAX_INTERVIEW_PAUSES,
  parseInterviewStreamCursor,
  PAUSE_RESUME_WINDOW_SECONDS,
  pauseInterviewResponseSchema,
  type PlanningState,
  realtimeSessionResponseSchema,
  reportErrorCodeSchema,
  resumeInterviewResponseSchema,
  toolCallRequestSchema,
  type ToolCallResponse,
  toolCallResponseSchema,
  VOICE_LIMIT_SECONDS,
} from "@stackprep/shared";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AIError, type AIProvider, type AIUsage, type ReasoningEffort } from "../_shared/ai/provider.ts";
import { providerTokens } from "../_shared/ai-usage.ts";
import type { Authenticate } from "../_shared/auth.ts";
import { NON_SUMMARY_KINDS } from "../_shared/code-index/memory.ts";
import type { GithubApp } from "../_shared/github-app.ts";
import { apiError, logGithubError } from "../_shared/github-errors.ts";
import { createCors, json } from "../_shared/http.ts";
import type { JobQueue } from "../_shared/jobs.ts";
import { buildRealtimeInstructions, type InstructionsMemory } from "../_shared/realtime/instructions.ts";
import type { RealtimeClient } from "../_shared/realtime/openai-realtime.ts";
import { buildRealtimeTools } from "../_shared/realtime/tools.ts";
import {
  createInterviewStream,
  createInterviewStreamReader,
  DEFAULT_STREAM_TIMING,
  type InterviewStreamReader,
  type StreamTiming,
} from "./events.ts";
import {
  analyzeFrame,
  INTEGRITY_TERMINATION_MESSAGE,
  INTEGRITY_WARNING_MESSAGES,
  type IntegrityReservation,
  type IntegritySignalResult,
  type IntegrityStore,
} from "./integrity.ts";
import { type ReportInterview, type ReportJobStore, requestReport } from "./report-request.ts";
import { buildResumeContext, RESUME_MESSAGES } from "./resume.ts";
import { createTreeCache, type TreeCache } from "./tools/get-file.ts";
import { parseToolCall, READ_TOOLS, runTool } from "./tools/index.ts";
import { createToolStore } from "./tools/store.ts";
import { type SearchEmbeddings, type ToolContext, toolError, type ToolStore } from "./tools/types.ts";
import {
  clampVoiceUsage,
  openVoiceSegment,
  voiceDurationEstimates,
  type VoiceSegmentEvent,
  voiceSegments,
} from "./voice-usage.ts";

const FN = "interviews";

/** Read tools allowed per interview in a sliding window, counted from stored tool_call events. */
export const READ_TOOL_LIMIT = 20;
export const READ_TOOL_WINDOW_MS = 60_000;

export const TIME_UP_GUIDANCE =
  "The interview time is over. Give a one-sentence closing statement now and end the conversation.";

const MAX_FILE_SUMMARIES = 20;

const ENDED_STATUSES: ReadonlySet<InterviewStatus> = new Set(["completed", "terminated", "failed"]);

export interface InterviewRow {
  id: string;
  workspace_id: string;
  status: InterviewStatus;
  repository_commit_sha: string;
}

/** Reads made with the caller's client, so RLS limits every result to their own rows. */
export interface InterviewReader {
  getInterview(interviewId: string): Promise<InterviewRow | null>;
  /** Status of the newest interview_planning job, or null if there is none. */
  getPlanningState(interviewId: string): Promise<PlanningState | null>;
  getReport(interviewId: string): Promise<StoredReport | null>;
  /** The newest report_generation job, or null if there is none. */
  getReportJob(interviewId: string): Promise<ReportJob | null>;
}

export interface StoredReport {
  content: unknown;
  generated_at: string;
}

export interface ReportJob {
  status: "queued" | "running" | "succeeded" | "failed";
  error_code: string | null;
}

export interface VoiceEvent {
  event_type: "connected" | "disconnected";
  occurred_at: string;
}

export interface RepositoryContext {
  repositoryFullName: string;
  memory: InstructionsMemory[];
}

export interface TranscriptTurnRecord {
  interviewId: string;
  userId: string;
  clientEventId: string;
  role: "ai" | "user";
  content: string;
  metadata: Record<string, unknown>;
}

export interface VoiceEventRecord {
  interviewId: string;
  userId: string;
  clientEventId: string;
  eventType: VoiceEvent["event_type"] | "pause" | "resume";
  payload: Record<string, unknown>;
}

/** `sequence` is the server-assigned sequence of the stored row. */
export interface RecordResult {
  status: "created" | "duplicate" | "event_conflict";
  sequence: number;
}

export interface PauseResult {
  status: "paused" | "already_paused" | "limit_reached" | "not_active";
  pauseCount: number;
  pausedAt: string | null;
  /** Sequence of the `disconnected` written to close an open voice segment. */
  disconnectedSequence: number | null;
}

export type ResumeResult = "resumed" | "already_active" | "expired" | "not_active";

export type DeleteResult = "deleted" | "already_deleted" | "not_ended" | "not_found";

export interface EndResult {
  status: "completed" | "no_report" | "already_completed" | "already_terminated" | "not_active";
  /** Sequence of the `disconnected` written to close an open voice segment. */
  disconnectedSequence: number | null;
}

/**
 * Service-role reads of hidden state. Every call is keyed by ids taken from an interview the
 * caller has already been shown to own.
 */
export interface InterviewStore extends ToolStore, IntegrityStore {
  /** Raw `interview_state.plan`; `{}` until planning writes it. */
  getPlan(interviewId: string): Promise<unknown>;
  /** Connected / disconnected events in sequence order. */
  listVoiceEvents(interviewId: string): Promise<VoiceEvent[]>;
  /** The same events with their row id and sequence, for linking usage to voice segments. */
  listVoiceSegmentEvents(interviewId: string): Promise<VoiceSegmentEvent[]>;
  getRepositoryContext(workspaceId: string, commitSha: string): Promise<RepositoryContext | null>;
  recordTranscriptTurn(turn: TranscriptTurnRecord): Promise<RecordResult>;
  recordVoiceEvent(event: VoiceEventRecord): Promise<RecordResult>;
  pauseInterview(interviewId: string, userId: string): Promise<PauseResult>;
  resumeInterview(interviewId: string, userId: string): Promise<ResumeResult>;
  endInterview(interviewId: string, userId: string): Promise<EndResult>;
  /** Soft delete: sets deleted_at, so RLS hides the interview from its owner. */
  deleteInterview(interviewId: string, userId: string): Promise<DeleteResult>;
}

export interface InterviewsHandlerOptions {
  webOrigin: string;
  authenticate: Authenticate;
  reader: (client: SupabaseClient) => InterviewReader;
  /** RLS reads behind GET /interviews/:id/events. */
  streamReader?: (client: SupabaseClient) => InterviewStreamReader;
  streamTiming?: StreamTiming;
  store: InterviewStore;
  realtime: RealtimeClient;
  model: string;
  transcriptionModel: string;
  github: GithubApp;
  ai: AIProvider;
  evaluationModel: string;
  evaluationReasoningEffort?: ReasoningEffort;
  /** Vector fill for search_repository; omitted means keyword search only. */
  embeddings?: SearchEmbeddings;
  visionModel: string;
  visionReasoningEffort?: ReasoningEffort;
  jobs: JobQueue;
  reportJobs: ReportJobStore;
  trees?: TreeCache;
  now?: () => Date;
}

function check(action: string, error: { message: string } | null): void {
  if (error) {
    throw new Error(`Failed to ${action}: ${error.message}`);
  }
}

export function createInterviewReader(client: SupabaseClient): InterviewReader {
  return {
    async getInterview(interviewId) {
      const { data, error } = await client
        .from("interviews")
        .select("id, workspace_id, status, repository_commit_sha")
        .eq("id", interviewId)
        .maybeSingle();
      check("load interview", error);
      return (data ?? null) as InterviewRow | null;
    },
    async getPlanningState(interviewId) {
      const { data, error } = await client
        .from("jobs")
        .select("status")
        .eq("interview_id", interviewId)
        .eq("type", "interview_planning")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      check("load interview planning", error);
      return (data?.status ?? null) as PlanningState | null;
    },
    async getReport(interviewId) {
      const { data, error } = await client
        .from("reports")
        .select("content, generated_at")
        .eq("interview_id", interviewId)
        .maybeSingle();
      check("load report", error);
      return (data ?? null) as StoredReport | null;
    },
    async getReportJob(interviewId) {
      const { data, error } = await client
        .from("jobs")
        .select("status, error_code")
        .eq("interview_id", interviewId)
        .eq("type", "report_generation")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      check("load report job", error);
      return (data ?? null) as ReportJob | null;
    },
  };
}

export function createInterviewStore(serviceClient: SupabaseClient): InterviewStore {
  return {
    ...createToolStore(serviceClient),
    async getPlan(interviewId) {
      const { data, error } = await serviceClient
        .from("interview_state")
        .select("plan")
        .eq("interview_id", interviewId)
        .maybeSingle();
      check("load interview state", error);
      return data?.plan ?? null;
    },
    async listVoiceEvents(interviewId) {
      const { data, error } = await serviceClient
        .from("interview_events")
        .select("event_type, occurred_at")
        .eq("interview_id", interviewId)
        .in("event_type", ["connected", "disconnected"])
        .order("sequence");
      check("load voice events", error);
      return (data ?? []) as VoiceEvent[];
    },
    async listVoiceSegmentEvents(interviewId) {
      const { data, error } = await serviceClient
        .from("interview_events")
        .select("id, sequence, event_type, occurred_at")
        .eq("interview_id", interviewId)
        .in("event_type", ["connected", "disconnected"])
        .order("sequence");
      check("load voice segment events", error);
      return (data ?? []) as VoiceSegmentEvent[];
    },
    async getRepositoryContext(workspaceId, commitSha) {
      const memory = () =>
        serviceClient.from("repository_memory").select("kind, content")
          .eq("workspace_id", workspaceId).eq("repository_commit_sha", commitSha);
      // Ordered by stable keys so the instructions prefix is byte-identical across sessions.
      const [workspace, summaries, files] = await Promise.all([
        serviceClient.from("workspaces")
          .select("repository:repositories!workspaces_repository_id_user_id_fkey(full_name)")
          .eq("id", workspaceId).maybeSingle(),
        memory().not("kind", "in", NON_SUMMARY_KINDS).order("kind").order("id"),
        memory().eq("kind", "file_summary").order("created_at").order("id").limit(MAX_FILE_SUMMARIES),
      ]);
      check("load workspace", workspace.error);
      check("load repository memory", summaries.error);
      check("load file summaries", files.error);
      const repository = workspace.data?.repository as unknown as { full_name: string } | null | undefined;
      if (!repository) {
        return null;
      }
      return {
        repositoryFullName: repository.full_name,
        memory: [...(summaries.data ?? []), ...(files.data ?? [])] as InstructionsMemory[],
      };
    },
    async recordTranscriptTurn(turn) {
      const { data, error } = await serviceClient.rpc("record_transcript_turn", {
        p_interview_id: turn.interviewId,
        p_user_id: turn.userId,
        p_client_event_id: turn.clientEventId,
        p_role: turn.role,
        p_content: turn.content,
        p_metadata: turn.metadata,
      }).single();
      check("record transcript turn", error);
      return data as RecordResult;
    },
    async recordVoiceEvent(event) {
      const { data, error } = await serviceClient.rpc("record_voice_event", {
        p_interview_id: event.interviewId,
        p_user_id: event.userId,
        p_client_event_id: event.clientEventId,
        p_event_type: event.eventType,
        p_payload: event.payload,
      }).single();
      check("record voice event", error);
      return data as RecordResult;
    },
    async pauseInterview(interviewId, userId) {
      const { data, error } = await serviceClient.rpc("pause_interview", {
        p_interview_id: interviewId,
        p_user_id: userId,
      }).single();
      check("pause interview", error);
      const row = data as {
        status: PauseResult["status"];
        pause_count: number;
        paused_at: string | null;
        disconnected_sequence: number | null;
      };
      return {
        status: row.status,
        pauseCount: row.pause_count,
        pausedAt: row.paused_at,
        disconnectedSequence: row.disconnected_sequence,
      };
    },
    async resumeInterview(interviewId, userId) {
      const { data, error } = await serviceClient.rpc("resume_interview", {
        p_interview_id: interviewId,
        p_user_id: userId,
      }).single();
      check("resume interview", error);
      return (data as { status: ResumeResult }).status;
    },
    async endInterview(interviewId, userId) {
      const { data, error } = await serviceClient.rpc("end_interview_by_user", {
        p_interview_id: interviewId,
        p_user_id: userId,
      }).single();
      check("end interview", error);
      const row = data as { status: EndResult["status"]; disconnected_sequence: number | null };
      return { status: row.status, disconnectedSequence: row.disconnected_sequence };
    },
    async deleteInterview(interviewId, userId) {
      const { data, error } = await serviceClient.rpc("delete_interview", {
        p_interview_id: interviewId,
        p_user_id: userId,
      });
      check("delete interview", error);
      return data as DeleteResult;
    },
    async reserveIntegrityCheck(interviewId, userId) {
      const { data, error } = await serviceClient.rpc("reserve_integrity_check", {
        p_interview_id: interviewId,
        p_user_id: userId,
      }).single();
      check("reserve integrity check", error);
      const row = data as { status: IntegrityReservation["status"]; check_id: string | null };
      return { status: row.status, checkId: row.check_id };
    },
    async recordIntegritySignal(interviewId, userId, checkId, kind) {
      const { data, error } = await serviceClient.rpc("record_integrity_signal", {
        p_interview_id: interviewId,
        p_user_id: userId,
        p_check_id: checkId,
        p_kind: kind,
      }).single();
      check("record integrity signal", error);
      const row = data as { status: IntegritySignalResult["status"]; warning_number: number | null };
      return { status: row.status, warningNumber: row.warning_number };
    },
  };
}

/**
 * Sums connected time. A `connected` without a matching `disconnected` runs until the next
 * `connected` or, for the last one, until now, so a client cannot gain time by never reporting
 * a disconnect.
 */
export function voiceSecondsUsed(events: VoiceEvent[], now: Date): number {
  const total = voiceSegments(events)
    .reduce((sum, segment) => sum + Math.max(0, (segment.endedAt ?? now.getTime()) - segment.startedAt), 0);
  return Math.floor(total / 1000);
}

async function safetyIdentifier(userId: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`stackprep:${userId}`));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Key-order-independent JSON, to compare stored (jsonb) and replayed tool arguments. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const SESSION_ROUTE = /\/interviews\/([^/]+)\/realtime\/session\/?$/;
const EVENTS_ROUTE = /\/interviews\/([^/]+)\/events\/?$/;
const TOOL_CALLS_ROUTE = /\/interviews\/([^/]+)\/tool-calls\/?$/;
const REPORT_ROUTE = /\/interviews\/([^/]+)\/report\/?$/;
const REPORT_RETRY_ROUTE = /\/interviews\/([^/]+)\/report\/retry\/?$/;
const FRAMES_ROUTE = /\/interviews\/([^/]+)\/integrity\/frames\/?$/;
const PAUSE_ROUTE = /\/interviews\/([^/]+)\/pause\/?$/;
const RESUME_ROUTE = /\/interviews\/([^/]+)\/resume\/?$/;
const END_ROUTE = /\/interviews\/([^/]+)\/end\/?$/;
const INTERVIEW_ROUTE = /\/interviews\/([^/]+)\/?$/;

/** Body bytes allowed for one frame request: the data URL cap plus JSON framing. */
const FRAME_BODY_MAX_BYTES = INTEGRITY_FRAME_MAX_CHARS + 1024;
const FRAME_RETRY_AFTER_SECONDS = "10";

export function createInterviewsHandler({
  webOrigin,
  authenticate,
  reader,
  streamReader = createInterviewStreamReader,
  streamTiming = DEFAULT_STREAM_TIMING,
  store,
  realtime,
  model,
  transcriptionModel,
  github,
  ai,
  evaluationModel,
  evaluationReasoningEffort,
  embeddings,
  visionModel,
  visionReasoningEffort,
  jobs,
  reportJobs,
  trees = createTreeCache(),
  now = () => new Date(),
}: InterviewsHandlerOptions) {
  const cors = createCors(webOrigin, ["GET", "POST", "DELETE"]);
  const tools = buildRealtimeTools();

  function toolResponse(body: ToolCallResponse): Response {
    return json(toolCallResponseSchema.parse(body), { status: 200, headers: cors.headers });
  }

  function queueReport(interview: ReportInterview, userId: string) {
    return requestReport({ jobs, store: reportJobs }, interview, userId);
  }

  /**
   * Writes duration estimates for the voice segment closed by the event at `close.bySequence`, or
   * for the open segment when the voice limit closes it at `close.at`. Never throws.
   */
  async function recordVoiceEstimates(
    interview: InterviewRow,
    userId: string,
    close: { bySequence: number } | { at: Date },
  ): Promise<void> {
    try {
      const segments = voiceSegments(await store.listVoiceSegmentEvents(interview.id));
      const segment = "bySequence" in close
        ? segments.find((s) => s.closedBy?.sequence === close.bySequence)
        : openVoiceSegment(segments);
      if (!segment) {
        return;
      }
      const endedAt = segment.endedAt ?? ("at" in close ? close.at.getTime() : segment.startedAt);
      const scope = {
        userId,
        workspaceId: interview.workspace_id,
        interviewId: interview.id,
        realtimeModel: model,
        transcriptionModel,
      };
      for (const entry of voiceDurationEstimates(scope, segment, endedAt)) {
        await store.recordAiUsage(entry);
      }
    } catch (err) {
      logGithubError(FN, err, { event: "voice_estimate_failed", code: "internal_error", interview_id: interview.id });
    }
  }

  /** Report state as the owner sees it, derived from the report row and the newest report job. */
  async function reportStatus(userReader: InterviewReader, interviewId: string): Promise<InterviewReportResponse> {
    const [report, job] = await Promise.all([userReader.getReport(interviewId), userReader.getReportJob(interviewId)]);
    if (report) {
      const parsed = interviewReportSchema.safeParse(report.content);
      if (parsed.success) {
        return { status: "ready", report: parsed.data, generated_at: report.generated_at };
      }
      logGithubError(FN, null, { event: "report_content_invalid", code: "internal_error", interview_id: interviewId });
      return { status: "failed", error_code: "internal_error" };
    }
    if (!job) {
      // Completed without a job: the request itself failed before anything was queued.
      return { status: "failed", error_code: "enqueue_failed" };
    }
    if (job.status === "queued" || job.status === "running") {
      return { status: "pending" };
    }
    const code = reportErrorCodeSchema.safeParse(job.error_code);
    return { status: "failed", error_code: job.status === "failed" && code.success ? code.data : "internal_error" };
  }

  type CompletedInterview =
    | { ok: false; response: Response }
    | { ok: true; userId: string; userReader: InterviewReader; interview: InterviewRow };

  async function loadCompletedInterview(req: Request, id: string): Promise<CompletedInterview> {
    const ctx = await authenticate(req);
    if (!ctx) {
      return { ok: false, response: apiError("unauthorized", cors) };
    }
    if (!interviewIdParamSchema.safeParse(id).success) {
      return { ok: false, response: apiError("interview_not_found", cors) };
    }
    const userReader = reader(ctx.supabase);
    const interview = await userReader.getInterview(id);
    if (!interview) {
      return { ok: false, response: apiError("interview_not_found", cors) };
    }
    if (interview.status !== "completed") {
      return { ok: false, response: apiError("interview_not_completed", cors) };
    }
    return { ok: true, userId: ctx.user.id, userReader, interview };
  }

  async function getReport(req: Request, id: string): Promise<Response> {
    const loaded = await loadCompletedInterview(req, id);
    if (!loaded.ok) {
      return loaded.response;
    }
    const body = interviewReportResponseSchema.parse(await reportStatus(loaded.userReader, loaded.interview.id));
    return json(body, { headers: cors.headers });
  }

  /** Re-queues a failed report. A concurrent retry that already queued one answers with its state. */
  async function retryReport(req: Request, id: string): Promise<Response> {
    const loaded = await loadCompletedInterview(req, id);
    if (!loaded.ok) {
      return loaded.response;
    }
    const { userId, userReader, interview } = loaded;
    if ((await reportStatus(userReader, interview.id)).status !== "failed") {
      return apiError("report_not_retryable", cors);
    }
    const outcome = await queueReport(interview, userId);
    const body = interviewReportResponseSchema.parse(
      outcome === "queued" ? { status: "pending" } : await reportStatus(userReader, interview.id),
    );
    return json(body, { status: outcome === "queued" ? 202 : 200, headers: cors.headers });
  }

  /**
   * Executes a Realtime tool call relayed by the browser. Tool-level failures are HTTP 200 tool
   * errors so the interviewer can recover; auth, ownership, and malformed envelopes are HTTP errors.
   */
  async function callTool(req: Request, id: string): Promise<Response> {
    const ctx = await authenticate(req);
    if (!ctx) {
      return apiError("unauthorized", cors);
    }
    if (!interviewIdParamSchema.safeParse(id).success) {
      return apiError("interview_not_found", cors);
    }
    const interview = await reader(ctx.supabase).getInterview(id);
    if (!interview) {
      return apiError("interview_not_found", cors);
    }

    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return apiError("invalid_request", cors);
    }
    const request = toolCallRequestSchema.safeParse(raw);
    if (!request.success) {
      return apiError("invalid_request", cors);
    }
    const { call_id: callId } = request.data;
    const call = parseToolCall(request.data.name, request.data.arguments);
    if (!call.ok) {
      return toolResponse(toolError(call.code));
    }

    // A replay returns the stored answer even after the interview has ended.
    const existing = await store.findToolCall(interview.id, callId);
    if (existing) {
      if (existing.tool !== call.tool || stableJson(existing.args) !== stableJson(call.args)) {
        return apiError("event_conflict", cors);
      }
      if (existing.result !== null) {
        return toolResponse(existing.result as ToolCallResponse);
      }
    }

    if (interview.status !== "in_progress") {
      return toolResponse(toolError("interview_not_active"));
    }
    const elapsedSeconds = voiceSecondsUsed(await store.listVoiceEvents(interview.id), now());
    if (elapsedSeconds >= VOICE_LIMIT_SECONDS) {
      if (await store.completeInterview(interview.id, ctx.user.id, "time_limit")) {
        await recordVoiceEstimates(interview, ctx.user.id, { at: now() });
        await queueReport(interview, ctx.user.id);
      }
      return toolResponse(toolError("interview_not_active", TIME_UP_GUIDANCE));
    }
    if (!existing && READ_TOOLS.includes(call.tool)) {
      const since = new Date(now().getTime() - READ_TOOL_WINDOW_MS);
      if (await store.countToolCallsSince(interview.id, [...READ_TOOLS], since) >= READ_TOOL_LIMIT) {
        return toolResponse(toolError("rate_limited"));
      }
    }

    const toolCtx: ToolContext = {
      interview,
      userId: ctx.user.id,
      store,
      github,
      trees,
      ai,
      evaluationModel,
      evaluationReasoningEffort,
      embeddings,
      elapsedSeconds,
      requestReport: async () => {
        await queueReport(interview, ctx.user.id);
      },
      log: (entry) => console.log(JSON.stringify({ fn: FN, interview_id: interview.id, tool: call.tool, ...entry })),
    };
    const outcome = await runTool(call.tool, call.args, toolCtx);
    const output = toolCallResponseSchema.parse(outcome.output);
    if (existing || outcome.record === false) {
      return toolResponse(output);
    }

    const recorded = await store.recordToolCall({
      interviewId: interview.id,
      userId: ctx.user.id,
      callId,
      tool: call.tool,
      args: call.args,
      resultSummary: outcome.summary,
      result: outcome.persist ? output : null,
      evidence: outcome.evidence ?? [],
      evaluation: outcome.evaluation ?? null,
    });
    if (recorded.status === "event_conflict") {
      return apiError("event_conflict", cors);
    }
    if (recorded.status === "duplicate") {
      // A concurrent relay of the same call won; answer consistently with it.
      return toolResponse((recorded.result ?? output) as ToolCallResponse);
    }
    if (outcome.afterRecord) {
      try {
        await outcome.afterRecord();
      } catch (err) {
        logGithubError(FN, err, { event: "tool_state_update_failed", code: "internal_error", interview_id: interview.id });
      }
    }
    return toolResponse(output);
  }

  /**
   * One camera frame: reserve a check (rate limit, active and not interrupted), run the vision
   * model with no lock held, then resolve the check. A vision failure resolves it with no signal,
   * so the candidate is never penalized for it. The frame is never stored or logged.
   */
  async function submitFrame(req: Request, id: string): Promise<Response> {
    const ctx = await authenticate(req);
    if (!ctx) {
      return apiError("unauthorized", cors);
    }
    if (!interviewIdParamSchema.safeParse(id).success) {
      return apiError("interview_not_found", cors);
    }
    const interview = await reader(ctx.supabase).getInterview(id);
    if (!interview) {
      return apiError("interview_not_found", cors);
    }

    if (Number(req.headers.get("content-length") ?? 0) > FRAME_BODY_MAX_BYTES) {
      await req.body?.cancel();
      return apiError("invalid_request", cors);
    }
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return apiError("invalid_request", cors);
    }
    const frame = integrityFrameRequestSchema.safeParse(raw);
    if (!frame.success) {
      return apiError("invalid_request", cors);
    }

    const reservation = await store.reserveIntegrityCheck(interview.id, ctx.user.id);
    if (reservation.status === "not_active") {
      return apiError("interview_not_active", cors);
    }
    if (reservation.status === "interrupted") {
      return apiError("interview_interrupted", cors);
    }
    if (reservation.status === "rate_limited" || !reservation.checkId) {
      return apiError("rate_limited", cors, { "Retry-After": FRAME_RETRY_AFTER_SECONDS });
    }

    const log = (entry: Record<string, string | number | boolean>) =>
      console.log(JSON.stringify({ fn: FN, interview_id: interview.id, ...entry }));
    let kind: Awaited<ReturnType<typeof analyzeFrame>> = null;
    try {
      const recordUsage = (usage: AIUsage) =>
        store.recordAiUsage({
          userId: ctx.user.id,
          workspaceId: interview.workspace_id,
          interviewId: interview.id,
          task: "vision",
          model: visionModel,
          source: "provider",
          tokens: providerTokens(usage),
          idempotencyKey: `vision:${reservation.checkId}`,
        });
      kind = await analyzeFrame(
        { ai, model: visionModel, reasoningEffort: visionReasoningEffort, log, recordUsage },
        frame.data.image,
      );
    } catch (err) {
      if (!(err instanceof AIError)) {
        throw err;
      }
      log({ event: "integrity_check_failed", reason: err.name });
    }

    const result = await store.recordIntegritySignal(interview.id, ctx.user.id, reservation.checkId, kind);
    if (result.status === "not_active") {
      return apiError("interview_not_active", cors);
    }
    let body: IntegrityFrameResponse = { status: "ok" };
    if (result.status === "terminated") {
      body = { status: "terminated", warning_number: 3, message: INTEGRITY_TERMINATION_MESSAGE };
    } else if (result.status === "warning" && kind && result.warningNumber !== null) {
      body = { status: "warning", warning_number: result.warningNumber, message: INTEGRITY_WARNING_MESSAGES[kind] };
    }
    if (body.status !== "ok") {
      log({ event: "integrity_signal", kind: kind ?? "none", warning_number: result.warningNumber ?? 0 });
    }
    return json(integrityFrameResponseSchema.parse(body), { headers: cors.headers });
  }

  async function createSession(req: Request, id: string): Promise<Response> {
    const ctx = await authenticate(req);
    if (!ctx) {
      return apiError("unauthorized", cors);
    }
    if (!interviewIdParamSchema.safeParse(id).success) {
      return apiError("interview_not_found", cors);
    }
    const userReader = reader(ctx.supabase);
    const interview = await userReader.getInterview(id);
    if (!interview) {
      return apiError("interview_not_found", cors);
    }
    if (ENDED_STATUSES.has(interview.status)) {
      return apiError("interview_not_active", cors);
    }
    if (interview.status === "paused") {
      return apiError("interview_paused", cors);
    }

    const planning = await userReader.getPlanningState(interview.id);
    if (planning === "failed") {
      return apiError("interview_planning_failed", cors);
    }
    const plan = interviewPlanSchema.safeParse(await store.getPlan(interview.id));
    if (!plan.success) {
      // A succeeded job with no usable plan cannot recover by waiting.
      return apiError(planning === "succeeded" ? "interview_planning_failed" : "interview_preparing", cors);
    }

    const elapsed = voiceSecondsUsed(await store.listVoiceEvents(interview.id), now());
    const remaining = VOICE_LIMIT_SECONDS - elapsed;
    if (remaining <= 0) {
      return apiError("interview_not_active", cors);
    }

    const [context, messages, state] = await Promise.all([
      store.getRepositoryContext(interview.workspace_id, interview.repository_commit_sha),
      store.listRecentMessages(interview.id, RESUME_MESSAGES),
      store.getInterviewState(interview.id),
    ]);
    if (!context) {
      throw new Error("Interview workspace is not readable");
    }
    const resumed = buildResumeContext({ elapsedVoiceSeconds: elapsed, coverageMap: state?.coverageMap, messages });
    const instructions = buildRealtimeInstructions({
      repositoryFullName: context.repositoryFullName,
      commitSha: interview.repository_commit_sha,
      memory: context.memory,
      plan: plan.data,
      elapsedVoiceSeconds: elapsed,
      recap: resumed?.recap ?? null,
    });

    let credential;
    const mintStartedAt = Date.now();
    try {
      credential = await realtime.createClientSecret(
        { model, transcriptionModel, instructions, tools },
        await safetyIdentifier(ctx.user.id),
      );
    } catch (err) {
      logGithubError(FN, err, { event: "realtime_session_failed", code: "realtime_unavailable", interview_id: interview.id });
      return apiError("realtime_unavailable", cors);
    }
    console.log(JSON.stringify({ fn: FN, event: "realtime_session_minted", interview_id: interview.id, elapsed_ms: Date.now() - mintStartedAt }));

    const body = realtimeSessionResponseSchema.parse({
      client_secret: credential.value,
      expires_at: credential.expiresAt.toISOString(),
      model,
      remaining_voice_seconds: remaining,
      resume: resumed?.resume ?? null,
    });
    return json(body, { status: 201, headers: cors.headers });
  }

  /**
   * SSE of interview status, persisted turns, and report readiness. Resumes strictly after the
   * `Last-Event-ID` cursor (or `?last_event_id=` for readers that cannot set it); the header wins.
   */
  async function streamEvents(req: Request, id: string): Promise<Response> {
    const ctx = await authenticate(req);
    if (!ctx) {
      return apiError("unauthorized", cors);
    }
    if (!interviewIdParamSchema.safeParse(id).success) {
      return apiError("interview_not_found", cors);
    }
    const interview = await reader(ctx.supabase).getInterview(id);
    if (!interview) {
      return apiError("interview_not_found", cors);
    }

    const raw = req.headers.get("Last-Event-ID") || new URL(req.url).searchParams.get("last_event_id");
    const cursor = raw ? parseInterviewStreamCursor(raw) : INITIAL_INTERVIEW_STREAM_CURSOR;
    if (!cursor) {
      return apiError("invalid_cursor", cors);
    }

    const body = createInterviewStream({
      reader: streamReader(ctx.supabase),
      interviewId: interview.id,
      cursor,
      signal: req.signal,
      timing: streamTiming,
      onError: (err) => logGithubError(FN, err, { event: "interview_stream_failed", code: "internal_error", interview_id: interview.id }),
    });
    return new Response(body, {
      status: 200,
      headers: { ...cors.headers, "Content-Type": "text/event-stream", "Cache-Control": "no-store" },
    });
  }

  /**
   * Candidate-initiated pause. The database closes any open voice segment, so voice time stops
   * even if the browser never reports its disconnect. Repeating it while paused is not an error.
   */
  async function pauseInterview(req: Request, id: string): Promise<Response> {
    const ctx = await authenticate(req);
    if (!ctx) {
      return apiError("unauthorized", cors);
    }
    if (!interviewIdParamSchema.safeParse(id).success) {
      return apiError("interview_not_found", cors);
    }
    const interview = await reader(ctx.supabase).getInterview(id);
    if (!interview) {
      return apiError("interview_not_found", cors);
    }

    const result = await store.pauseInterview(interview.id, ctx.user.id);
    if (result.status === "limit_reached") {
      return apiError("pause_limit_reached", cors);
    }
    if (result.status === "not_active" || !result.pausedAt) {
      return apiError("interview_not_active", cors);
    }
    if (result.disconnectedSequence !== null) {
      await recordVoiceEstimates(interview, ctx.user.id, { bySequence: result.disconnectedSequence });
    }
    const resumeBy = new Date(Date.parse(result.pausedAt) + PAUSE_RESUME_WINDOW_SECONDS * 1000);
    const body = pauseInterviewResponseSchema.parse({
      status: "paused",
      pauses_left: Math.max(0, MAX_INTERVIEW_PAUSES - result.pauseCount),
      resume_by: resumeBy.toISOString(),
    });
    return json(body, { status: result.status === "paused" ? 201 : 200, headers: cors.headers });
  }

  /** Returns a paused interview to in progress; the browser then opens a new voice session. */
  async function resumeInterview(req: Request, id: string): Promise<Response> {
    const ctx = await authenticate(req);
    if (!ctx) {
      return apiError("unauthorized", cors);
    }
    if (!interviewIdParamSchema.safeParse(id).success) {
      return apiError("interview_not_found", cors);
    }
    const interview = await reader(ctx.supabase).getInterview(id);
    if (!interview) {
      return apiError("interview_not_found", cors);
    }

    const result = await store.resumeInterview(interview.id, ctx.user.id);
    if (result === "expired") {
      return apiError("pause_expired", cors);
    }
    if (result === "not_active") {
      return apiError("interview_not_active", cors);
    }
    const body = resumeInterviewResponseSchema.parse({ status: "in_progress" });
    return json(body, { status: 200, headers: cors.headers });
  }

  /**
   * Candidate ends the interview from the room or the paused screen. With an evaluated answer it
   * is completed and a report is queued; otherwise it is terminated with no report. Repeating it
   * after the interview ended answers with the same outcome and writes nothing.
   */
  async function endInterview(req: Request, id: string): Promise<Response> {
    const ctx = await authenticate(req);
    if (!ctx) {
      return apiError("unauthorized", cors);
    }
    if (!interviewIdParamSchema.safeParse(id).success) {
      return apiError("interview_not_found", cors);
    }
    const interview = await reader(ctx.supabase).getInterview(id);
    if (!interview) {
      return apiError("interview_not_found", cors);
    }

    const result = await store.endInterview(interview.id, ctx.user.id);
    if (result.status === "not_active") {
      return apiError("interview_not_active", cors);
    }
    if (result.disconnectedSequence !== null) {
      await recordVoiceEstimates(interview, ctx.user.id, { bySequence: result.disconnectedSequence });
    }
    if (result.status === "completed") {
      await queueReport(interview, ctx.user.id);
    }
    const completed = result.status === "completed" || result.status === "already_completed";
    const body = endInterviewResponseSchema.parse(
      completed ? { status: "completed", report: true } : { status: "terminated", report: false },
    );
    const created = result.status === "completed" || result.status === "no_report";
    return json(body, { status: created ? 201 : 200, headers: cors.headers });
  }

  /**
   * Removes an ended interview from the candidate's history. The row is kept, so it still counts
   * toward the interview limit. A deleted interview is hidden by RLS and answers not found.
   */
  async function deleteInterview(req: Request, id: string): Promise<Response> {
    const ctx = await authenticate(req);
    if (!ctx) {
      return apiError("unauthorized", cors);
    }
    if (!interviewIdParamSchema.safeParse(id).success) {
      return apiError("interview_not_found", cors);
    }
    const interview = await reader(ctx.supabase).getInterview(id);
    if (!interview) {
      return apiError("interview_not_found", cors);
    }

    const result = await store.deleteInterview(interview.id, ctx.user.id);
    if (result === "not_found") {
      return apiError("interview_not_found", cors);
    }
    if (result === "not_ended") {
      return apiError("interview_not_ended", cors);
    }
    const body = deleteInterviewResponseSchema.parse({ status: "deleted" });
    return json(body, { status: 200, headers: cors.headers });
  }

  /** Accepted after the interview ends too, so turns buffered during a drop are not lost. */
  async function recordEvent(req: Request, id: string): Promise<Response> {
    const ctx = await authenticate(req);
    if (!ctx) {
      return apiError("unauthorized", cors);
    }
    if (!interviewIdParamSchema.safeParse(id).success) {
      return apiError("interview_not_found", cors);
    }
    const interview = await reader(ctx.supabase).getInterview(id);
    if (!interview) {
      return apiError("interview_not_found", cors);
    }

    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return apiError("invalid_request", cors);
    }
    const parsed = interviewEventRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return apiError("invalid_request", cors);
    }
    const event = parsed.data;

    let ack: InterviewEventAck;
    if (event.type === "transcript_turn") {
      const result = await store.recordTranscriptTurn({
        interviewId: interview.id,
        userId: ctx.user.id,
        clientEventId: event.client_event_id,
        role: event.role,
        content: event.content,
        metadata: {
          item_id: event.item_id,
          occurred_at: event.occurred_at,
          ...(event.interrupted ? { interrupted: true } : {}),
        },
      });
      if (result.status === "event_conflict") {
        return apiError("event_conflict", cors);
      }
      ack = { type: event.type, status: result.status, client_event_id: event.client_event_id, turn_sequence: result.sequence };
    } else if (event.type === "voice_usage") {
      // Linked to the open segment only: usage relayed after a disconnect cannot be attributed.
      const segment = openVoiceSegment(voiceSegments(await store.listVoiceSegmentEvents(interview.id)));
      if (!segment) {
        return apiError("voice_not_connected", cors);
      }
      const status = await store.recordAiUsage({
        userId: ctx.user.id,
        workspaceId: interview.workspace_id,
        interviewId: interview.id,
        task: "voice",
        model,
        source: "client_reported",
        tokens: clampVoiceUsage(event),
        voiceSegmentEventId: segment.opened.id,
        idempotencyKey: `voice_usage:${interview.id}:${event.client_event_id}`,
      });
      if (status === "failed") {
        return apiError("internal_error", cors);
      }
      ack = { type: event.type, status, client_event_id: event.client_event_id };
    } else {
      const result = await store.recordVoiceEvent({
        interviewId: interview.id,
        userId: ctx.user.id,
        clientEventId: event.client_event_id,
        eventType: event.type,
        payload: {
          client_occurred_at: event.occurred_at,
          ...(event.type === "pause" ? { reason: event.reason } : {}),
        },
      });
      if (result.status === "event_conflict") {
        return apiError("event_conflict", cors);
      }
      if (event.type === "connected" || event.type === "disconnected") {
        await recordVoiceEstimates(interview, ctx.user.id, { bySequence: result.sequence });
      }
      ack = { type: event.type, status: result.status, client_event_id: event.client_event_id, event_sequence: result.sequence };
    }

    const body = interviewEventAckSchema.parse(ack);
    return json(body, { status: body.status === "created" ? 201 : 200, headers: cors.headers });
  }

  return async (req: Request): Promise<Response> => {
    const rejected = cors.rejectOrigin(req);
    if (rejected) {
      return rejected;
    }
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors.headers });
    }

    const path = new URL(req.url).pathname;
    const routes = [
      { pattern: SESSION_ROUTE, method: "POST", run: createSession },
      { pattern: EVENTS_ROUTE, method: "POST", run: recordEvent },
      { pattern: EVENTS_ROUTE, method: "GET", run: streamEvents },
      { pattern: TOOL_CALLS_ROUTE, method: "POST", run: callTool },
      { pattern: REPORT_ROUTE, method: "GET", run: getReport },
      { pattern: REPORT_RETRY_ROUTE, method: "POST", run: retryReport },
      { pattern: FRAMES_ROUTE, method: "POST", run: submitFrame },
      { pattern: PAUSE_ROUTE, method: "POST", run: pauseInterview },
      { pattern: RESUME_ROUTE, method: "POST", run: resumeInterview },
      { pattern: END_ROUTE, method: "POST", run: endInterview },
      { pattern: INTERVIEW_ROUTE, method: "DELETE", run: deleteInterview },
    ] as const;
    let id: string | null = null;
    const candidates: (typeof routes)[number][] = [];
    for (const route of routes) {
      const match = path.match(route.pattern);
      if (match && (id === null || id === match[1])) {
        id = match[1];
        candidates.push(route);
      }
    }
    if (id === null) {
      return apiError("not_found", cors);
    }
    const route = candidates.find((candidate) => candidate.method === req.method);
    if (!route) {
      return apiError("method_not_allowed", cors, { Allow: `${candidates.map((c) => c.method).join(", ")}, OPTIONS` });
    }

    try {
      return await route.run(req, id);
    } catch (err) {
      logGithubError(FN, err, { code: "internal_error" });
      return apiError("internal_error", cors);
    }
  };
}
