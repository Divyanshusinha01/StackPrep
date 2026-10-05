import {
  type InterviewEventAck,
  interviewEventAckSchema,
  interviewEventRequestSchema,
  interviewIdParamSchema,
  interviewPlanSchema,
  type InterviewStatus,
  type PlanningState,
  realtimeSessionResponseSchema,
  VOICE_LIMIT_SECONDS,
} from "@stackprep/shared";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Authenticate } from "../_shared/auth.ts";
import { apiError, logGithubError } from "../_shared/github-errors.ts";
import { createCors, json } from "../_shared/http.ts";
import { buildRealtimeInstructions, type InstructionsMemory } from "../_shared/realtime/instructions.ts";
import type { RealtimeClient } from "../_shared/realtime/openai-realtime.ts";
import { buildRealtimeTools } from "../_shared/realtime/tools.ts";

const FN = "interviews";

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
export interface InterviewStore {
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
  };
}

export function createInterviewStore(serviceClient: SupabaseClient): InterviewStore {
  return {
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

const SESSION_ROUTE = /\/interviews\/([^/]+)\/realtime\/session\/?$/;
const EVENTS_ROUTE = /\/interviews\/([^/]+)\/events\/?$/;

export function createInterviewsHandler({
  webOrigin,
  authenticate,
  reader,
  store,
  realtime,
  model,
  transcriptionModel,
  now = () => new Date(),
}: InterviewsHandlerOptions) {
  const cors = createCors(webOrigin, ["POST"]);
  const tools = buildRealtimeTools();

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
    const session = path.match(SESSION_ROUTE);
    const events = path.match(EVENTS_ROUTE);
    const route = session
      ? () => createSession(req, session[1])
      : events
      ? () => recordEvent(req, events[1])
      : null;
    if (!route) {
      return apiError("not_found", cors);
    }
    if (req.method !== "POST") {
      return apiError("method_not_allowed", cors, { Allow: "POST, OPTIONS" });
    }

    try {
      return await route();
    } catch (err) {
      logGithubError(FN, err, { code: "internal_error" });
      return apiError("internal_error", cors);
    }
  };
}
