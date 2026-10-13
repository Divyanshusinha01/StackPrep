import type { BrowserContext, Page, Request, Route } from "@playwright/test";
import type { RealtimeSessionResponse } from "@stackprep/shared";

/**
 * Stands in for OpenAI Realtime in the browser. `use-realtime-interview.ts` only needs:
 * - `POST /functions/v1/interviews/:id/realtime/session` (mocked here; minting a real credential
 *   is covered by the Deno handler tests),
 * - `POST https://api.openai.com/v1/realtime/calls` returning an SDP answer (mocked here), once for
 *   the voice call and once for the transcription-only call,
 * - `RTCPeerConnection`s whose `oai-events` data channels open and deliver server events.
 * The fake peer connection implements just that surface; update it if the hook starts using more.
 * The fake transcription session acknowledges each `input_audio_buffer.commit` with
 * `input_audio_buffer.committed`, like the real one. Everything after the data channels
 * (transcript reducer, item mapping, outbox, `/events`, SSE) is real.
 */

const SESSION_ROUTE = /\/functions\/v1\/interviews\/[^/]+\/realtime\/session$/;
const FRAMES_ROUTE = /\/functions\/v1\/interviews\/[^/]+\/integrity\/frames$/;
const CALLS_ROUTE = /^https:\/\/api\.openai\.com\/v1\/realtime\/calls$/;

const VOICE_SECONDS = 30 * 60;
const VOICE_SECRET = "ek_e2e_voice_not_real";
const TRANSCRIPTION_SECRET = "ek_e2e_transcription_not_real";

export interface RealtimeServerEvent {
  type: string;
  [key: string]: unknown;
}

type CallKind = "voice" | "transcription";

interface FakeRealtimeState {
  sent: string[];
  isOpen(kind: CallKind): boolean;
  emit(kind: CallKind, event: RealtimeServerEvent): void;
  /** Completes the oldest committed candidate turn on the transcription session. */
  transcribe(transcript: string): void;
}

/** Runs in the page before any app script. Must be self-contained (serialized by Playwright). */
function fakeRealtimeInitScript() {
  class FakeDataChannel {
    readyState: RTCDataChannelState = "connecting";
    kind: CallKind = "voice";
    onopen: ((event: Event) => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onclose: ((event: Event) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;

    constructor(readonly label: string) {}

    send(data: string) {
      state.sent.push(String(data));
      if (this.kind !== "transcription") {
        return;
      }
      const event = JSON.parse(String(data)) as { type?: string };
      if (event.type === "input_audio_buffer.commit") {
        const itemId = `item_tx_${++committedCount}`;
        committed.push(itemId);
        queueMicrotask(() => {
          if (this.readyState === "open") {
            this.onmessage?.({ data: JSON.stringify({ type: "input_audio_buffer.committed", item_id: itemId }) });
          }
        });
      }
    }

    close() {
      this.readyState = "closed";
    }

    addEventListener() {}
    removeEventListener() {}
  }

  const open: Record<CallKind, FakeDataChannel | null> = { voice: null, transcription: null };
  /** Transcription items committed and not yet transcribed, oldest first. */
  const committed: string[] = [];
  let committedCount = 0;

  class FakeRTCPeerConnection {
    connectionState: RTCPeerConnectionState = "new";
    onconnectionstatechange: (() => void) | null = null;
    ontrack: ((event: unknown) => void) | null = null;
    localDescription: RTCSessionDescriptionInit | null = null;
    remoteDescription: RTCSessionDescriptionInit | null = null;
    private channels: FakeDataChannel[] = [];

    createDataChannel(label: string) {
      const channel = new FakeDataChannel(label);
      this.channels.push(channel);
      return channel;
    }

    addTrack() {
      return {};
    }

    getSenders() {
      return [];
    }

    async createOffer(): Promise<RTCSessionDescriptionInit> {
      return { type: "offer", sdp: "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=stackprep-e2e\r\nt=0 0\r\n" };
    }

    async setLocalDescription(description: RTCSessionDescriptionInit) {
      this.localDescription = description;
    }

    async setRemoteDescription(description: RTCSessionDescriptionInit) {
      this.remoteDescription = description;
      const kind: CallKind = description.sdp?.includes("s=stackprep-e2e-transcription") ? "transcription" : "voice";
      setTimeout(() => {
        if (this.connectionState === "closed") {
          return;
        }
        this.connectionState = "connected";
        this.onconnectionstatechange?.();
        for (const channel of this.channels) {
          channel.kind = kind;
          channel.readyState = "open";
          open[kind] = channel;
          channel.onopen?.(new Event("open"));
        }
      }, 0);
    }

    // Like a real peer connection, closing does not fire `close` on its data channels.
    close() {
      this.connectionState = "closed";
      for (const channel of this.channels) {
        channel.readyState = "closed";
        if (open[channel.kind] === channel) {
          open[channel.kind] = null;
          if (channel.kind === "transcription") {
            committed.length = 0;
          }
        }
      }
    }

    addEventListener() {}
    removeEventListener() {}
  }

  const channelFor = (kind: CallKind) => {
    const channel = open[kind];
    if (!channel || channel.readyState !== "open") {
      throw new Error(`E2E: the Realtime ${kind} data channel is not open`);
    }
    return channel;
  };

  const state: FakeRealtimeState = {
    sent: [],
    isOpen: (kind) => open[kind]?.readyState === "open",
    emit(kind, event) {
      channelFor(kind).onmessage?.({ data: JSON.stringify(event) });
    },
    transcribe(transcript) {
      const itemId = committed.shift();
      if (!itemId) {
        throw new Error("E2E: no committed candidate turn to transcribe");
      }
      state.emit("transcription", {
        type: "conversation.item.input_audio_transcription.completed",
        item_id: itemId,
        transcript,
      });
    },
  };

  Object.assign(window, { __e2eRealtime: state, RTCPeerConnection: FakeRTCPeerConnection });
}

function corsHeaders(request: Request): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": request.headers()["origin"] ?? "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

async function fulfillJson(route: Route, status: number, body: unknown) {
  const request = route.request();
  if (request.method() === "OPTIONS") {
    await route.fulfill({ status: 204, headers: corsHeaders(request) });
    return;
  }
  await route.fulfill({ status, headers: corsHeaders(request), contentType: "application/json", body: JSON.stringify(body) });
}

export interface FakeRealtimeOptions {
  /** Whether the session endpoint returns a transcription credential. Defaults to true. */
  transcription?: boolean;
}

export interface FakeRealtime {
  /** Session requests the app made (POST only). */
  sessionRequests: number;
  /** Waits until the app has opened the voice data channel, and the transcription one if enabled. */
  waitForOpen(page: Page): Promise<void>;
  /** Delivers one Realtime server event on the open voice data channel. */
  emit(page: Page, event: RealtimeServerEvent): Promise<void>;
  /** The candidate speaks one turn: voice `speech_started` and `speech_stopped` for `itemId`. */
  speak(page: Page, itemId: string): Promise<void>;
  /** Completes the oldest committed candidate turn with `transcript` on the transcription session. */
  transcribe(page: Page, transcript: string): Promise<void>;
}

type WindowWithFake = { __e2eRealtime: FakeRealtimeState };

export async function installFakeRealtime(
  context: BrowserContext,
  { transcription = true }: FakeRealtimeOptions = {},
): Promise<FakeRealtime> {
  const fake: FakeRealtime = {
    sessionRequests: 0,
    async waitForOpen(page) {
      await page.waitForFunction((withTranscription) => {
        const state = (window as unknown as Partial<WindowWithFake>).__e2eRealtime;
        return state?.isOpen("voice") && (!withTranscription || state.isOpen("transcription"));
      }, transcription);
    },
    async emit(page, event) {
      await page.evaluate((e) => {
        (window as unknown as WindowWithFake).__e2eRealtime.emit("voice", e);
      }, event);
    },
    async speak(page, itemId) {
      await fake.emit(page, { type: "input_audio_buffer.speech_started", item_id: itemId });
      await fake.emit(page, { type: "input_audio_buffer.speech_stopped", item_id: itemId });
    },
    async transcribe(page, transcript) {
      await page.evaluate((t) => {
        (window as unknown as WindowWithFake).__e2eRealtime.transcribe(t);
      }, transcript);
    },
  };

  await context.addInitScript(fakeRealtimeInitScript);

  await context.route(SESSION_ROUTE, async (route) => {
    if (route.request().method() === "POST") {
      fake.sessionRequests++;
    }
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const session: RealtimeSessionResponse = {
      client_secret: VOICE_SECRET,
      expires_at: expiresAt,
      model: "gpt-realtime-e2e",
      transcription: transcription
        ? { client_secret: TRANSCRIPTION_SECRET, expires_at: expiresAt, model: "gpt-live-transcribe-e2e" }
        : null,
      remaining_voice_seconds: VOICE_SECONDS,
      resume: null,
    };
    await fulfillJson(route, 201, session);
  });

  // Integrity frames would reach the vision model from the Edge Function; integrity is out of scope here.
  await context.route(FRAMES_ROUTE, (route) => fulfillJson(route, 200, { status: "ok" }));

  await context.route(CALLS_ROUTE, async (route) => {
    const request = route.request();
    if (request.method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: corsHeaders(request) });
      return;
    }
    const kind = request.headers()["authorization"] === `Bearer ${TRANSCRIPTION_SECRET}` ? "transcription" : "answer";
    await route.fulfill({
      status: 201,
      headers: corsHeaders(request),
      contentType: "application/sdp",
      body: `v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=stackprep-e2e-${kind}\r\nt=0 0\r\n`,
    });
  });

  return fake;
}
