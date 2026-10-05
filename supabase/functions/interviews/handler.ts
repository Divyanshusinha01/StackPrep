import {
  type InterviewEventAck,
  interviewEventAckSchema,
  interviewEventRequestSchema,
  interviewIdParamSchema,
  interviewPlanSchema,
  type InterviewReportResponse,
  interviewReportResponseSchema,
  interviewReportSchema,
  type InterviewStatus,
  type PlanningState,
  realtimeSessionResponseSchema,
  reportErrorCodeSchema,
  toolCallRequestSchema,
  type ToolCallResponse,
  toolCallResponseSchema,
  VOICE_LIMIT_SECONDS,
} from "@stackprep/shared";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AIProvider } from "../_shared/ai/provider.ts";
import type { Authenticate } from "../_shared/auth.ts";
import type { GithubApp } from "../_shared/github-app.ts";
import { apiError, logGithubError } from "../_shared/github-errors.ts";
import { createCors, json } from "../_shared/http.ts";
import type { JobQueue } from "../_shared/jobs.ts";
import { buildRealtimeInstructions, type InstructionsMemory } from "../_shared/realtime/instructions.ts";
import type { RealtimeClient } from "../_shared/realtime/openai-realtime.ts";
import { buildRealtimeTools } from "../_shared/realtime/tools.ts";
import { type ReportInterview, type ReportJobStore, requestReport } from "./report-request.ts";
import { createTreeCache, type TreeCache } from "./tools/get-file.ts";
import { parseToolCall, READ_TOOLS, runTool } from "./tools/index.ts";
import { createToolStore } from "./tools/store.ts";
import { type ToolContext, toolError, type ToolStore } from "./tools/types.ts";

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
  eventType: VoiceEvent["event_type"];
  payload: Record<string, unknown>;
}

/** `sequence` is the server-assigned sequence of the stored row. */
export interface RecordResult {
  status: "created" | "duplicate" | "event_conflict";
  sequence: number;
}

/**
 * Service-role reads of hidden state. Every call is keyed by ids taken from an interview the
 * caller has already been shown to own.
 */
export interface InterviewStore extends ToolStore {
  /** Raw `interview_state.plan`; `{}` until planning writes it. */
  getPlan(interviewId: string): Promise<unknown>;
  /** Connected / disconnected events in sequence order. */
  listVoiceEvents(interviewId: string): Promise<VoiceEvent[]>;
  getRepositoryContext(workspaceId: string, commitSha: string): Promise<RepositoryContext | null>;
  recordTranscriptTurn(turn: TranscriptTurnRecord): Promise<RecordResult>;
  recordVoiceEvent(event: VoiceEventRecord): Promise<RecordResult>;
}

export interface InterviewsHandlerOptions {
  webOrigin: string;
  authenticate: Authenticate;
  reader: (client: SupabaseClient) => InterviewReader;
  store: InterviewStore;
  realtime: RealtimeClient;
  model: string;
  transcriptionModel: string;
  github: GithubApp;
  ai: AIProvider;
  evaluationModel: string;
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
    async getRepositoryContext(workspaceId, commitSha) {
      const memory = () =>
        serviceClient.from("repository_memory").select("kind, content")
          .eq("workspace_id", workspaceId).eq("repository_commit_sha", commitSha);
      // Ordered by stable keys so the instructions prefix is byte-identical across sessions.
      const [workspace, summaries, files] = await Promise.all([
        serviceClient.from("workspaces")
          .select("repository:repositories!workspaces_repository_id_user_id_fkey(full_name)")
          .eq("id", workspaceId).maybeSingle(),
        memory().neq("kind", "file_summary").order("kind").order("id"),
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
  };
}

/**
 * Sums connected time. A `connected` without a matching `disconnected` runs until the next
 * `connected` or, for the last one, until now, so a client cannot gain time by never reporting
 * a disconnect.
 */
export function voiceSecondsUsed(events: VoiceEvent[], now: Date): number {
  let total = 0;
  let openedAt: number | null = null;
  const close = (at: number) => {
    if (openedAt !== null) {
      total += Math.max(0, at - openedAt);
      openedAt = null;
    }
  };
  for (const event of events) {
    const at = Date.parse(event.occurred_at);
    if (Number.isNaN(at)) {
      continue;
    }
    if (event.event_type === "connected") {
      close(at);
      openedAt = at;
    } else {
      close(at);
    }
  }
  close(now.getTime());
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

export function createInterviewsHandler({
  webOrigin,
  authenticate,
  reader,
  store,
  realtime,
  model,
  transcriptionModel,
  github,
  ai,
  evaluationModel,
  jobs,
  reportJobs,
  trees = createTreeCache(),
  now = () => new Date(),
}: InterviewsHandlerOptions) {
  const cors = createCors(webOrigin, ["GET", "POST"]);
  const tools = buildRealtimeTools();

  function toolResponse(body: ToolCallResponse): Response {
    return json(toolCallResponseSchema.parse(body), { status: 200, headers: cors.headers });
  }

  function queueReport(interview: ReportInterview, userId: string) {
    return requestReport({ jobs, store: reportJobs }, interview, userId);
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

    const context = await store.getRepositoryContext(interview.workspace_id, interview.repository_commit_sha);
    if (!context) {
      throw new Error("Interview workspace is not readable");
    }
    const instructions = buildRealtimeInstructions({
      repositoryFullName: context.repositoryFullName,
      commitSha: interview.repository_commit_sha,
      memory: context.memory,
      plan: plan.data,
      elapsedVoiceSeconds: elapsed,
    });

    let credential;
    try {
      credential = await realtime.createClientSecret(
        { model, transcriptionModel, instructions, tools },
        await safetyIdentifier(ctx.user.id),
      );
    } catch (err) {
      logGithubError(FN, err, { event: "realtime_session_failed", code: "realtime_unavailable", interview_id: interview.id });
      return apiError("realtime_unavailable", cors);
    }

    const body = realtimeSessionResponseSchema.parse({
      client_secret: credential.value,
      expires_at: credential.expiresAt.toISOString(),
      model,
      remaining_voice_seconds: remaining,
    });
    return json(body, { status: 201, headers: cors.headers });
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
    } else {
      const result = await store.recordVoiceEvent({
        interviewId: interview.id,
        userId: ctx.user.id,
        clientEventId: event.client_event_id,
        eventType: event.type,
        payload: { client_occurred_at: event.occurred_at },
      });
      if (result.status === "event_conflict") {
        return apiError("event_conflict", cors);
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
      { pattern: TOOL_CALLS_ROUTE, method: "POST", run: callTool },
      { pattern: REPORT_ROUTE, method: "GET", run: getReport },
      { pattern: REPORT_RETRY_ROUTE, method: "POST", run: retryReport },
    ] as const;
    let matched: { route: (typeof routes)[number]; id: string } | null = null;
    for (const route of routes) {
      const match = path.match(route.pattern);
      if (match) {
        matched = { route, id: match[1] };
        break;
      }
    }
    if (!matched) {
      return apiError("not_found", cors);
    }
    if (req.method !== matched.route.method) {
      return apiError("method_not_allowed", cors, { Allow: `${matched.route.method}, OPTIONS` });
    }

    try {
      return await matched.route.run(req, matched.id);
    } catch (err) {
      logGithubError(FN, err, { code: "internal_error" });
      return apiError("internal_error", cors);
    }
  };
}
