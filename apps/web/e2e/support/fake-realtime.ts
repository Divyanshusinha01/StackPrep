import type { BrowserContext, Page, Request, Route } from "@playwright/test";
import type { RealtimeSessionResponse } from "@stackprep/shared";

/**
 * Stands in for OpenAI Realtime in the browser. `use-realtime-interview.ts` only needs:
 * - `POST /functions/v1/interviews/:id/realtime/session` (mocked here; minting a real credential
 *   is covered by the Deno handler tests),
 * - `POST https://api.openai.com/v1/realtime/calls` returning an SDP answer (mocked here),
 * - an `RTCPeerConnection` whose `oai-events` data channel opens and delivers server events.
 * The fake peer connection implements just that surface; update it if the hook starts using more.
 * Everything after the data channel (transcript reducer, outbox, `/events`, SSE) is real.
 */

const SESSION_ROUTE = /\/functions\/v1\/interviews\/[^/]+\/realtime\/session$/;
const FRAMES_ROUTE = /\/functions\/v1\/interviews\/[^/]+\/integrity\/frames$/;
const CALLS_ROUTE = /^https:\/\/api\.openai\.com\/v1\/realtime\/calls$/;

const VOICE_SECONDS = 30 * 60;

export interface RealtimeServerEvent {
  type: string;
  [key: string]: unknown;
}

interface FakeRealtimeState {
  sent: string[];
  isOpen(): boolean;
  emit(event: RealtimeServerEvent): void;
}

/** Runs in the page before any app script. Must be self-contained (serialized by Playwright). */
function fakeRealtimeInitScript() {
  class FakeDataChannel {
    readyState: RTCDataChannelState = "connecting";
    onopen: ((event: Event) => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onclose: ((event: Event) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;

    constructor(readonly label: string) {}

    send(data: string) {
      state.sent.push(String(data));
    }

    close() {
      this.readyState = "closed";
    }

    addEventListener() {}
    removeEventListener() {}
  }

  let openChannel: FakeDataChannel | null = null;

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
      setTimeout(() => {
        if (this.connectionState === "closed") {
          return;
        }
        this.connectionState = "connected";
        this.onconnectionstatechange?.();
        for (const channel of this.channels) {
          channel.readyState = "open";
          openChannel = channel;
          channel.onopen?.(new Event("open"));
        }
      }, 0);
    }

    // Like a real peer connection, closing does not fire `close` on its data channels.
    close() {
      this.connectionState = "closed";
      for (const channel of this.channels) {
        channel.readyState = "closed";
        if (openChannel === channel) {
          openChannel = null;
        }
      }
    }

    addEventListener() {}
    removeEventListener() {}
  }

  const state: FakeRealtimeState = {
    sent: [],
    isOpen: () => openChannel?.readyState === "open",
    emit(event) {
      if (!openChannel || openChannel.readyState !== "open") {
        throw new Error("E2E: the Realtime data channel is not open");
      }
      openChannel.onmessage?.({ data: JSON.stringify(event) });
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

export interface FakeRealtime {
  /** Session requests the app made (POST only). */
  sessionRequests: number;
  /** Waits until the app has opened the data channel. */
  waitForOpen(page: Page): Promise<void>;
  /** Delivers one Realtime server event on the open data channel. */
  emit(page: Page, event: RealtimeServerEvent): Promise<void>;
}

export async function installFakeRealtime(context: BrowserContext): Promise<FakeRealtime> {
  const fake: FakeRealtime = {
    sessionRequests: 0,
    async waitForOpen(page) {
      await page.waitForFunction(() =>
        (window as unknown as { __e2eRealtime?: FakeRealtimeState }).__e2eRealtime?.isOpen(),
      );
    },
    async emit(page, event) {
      await page.evaluate((e) => {
        (window as unknown as { __e2eRealtime: FakeRealtimeState }).__e2eRealtime.emit(e);
      }, event);
    },
  };

  await context.addInitScript(fakeRealtimeInitScript);

  await context.route(SESSION_ROUTE, async (route) => {
    if (route.request().method() === "POST") {
      fake.sessionRequests++;
    }
    const session: RealtimeSessionResponse = {
      client_secret: "ek_e2e_not_real",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      model: "gpt-realtime-e2e",
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
    await route.fulfill({
      status: 201,
      headers: corsHeaders(request),
      contentType: "application/sdp",
      body: "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=stackprep-e2e-answer\r\nt=0 0\r\n",
    });
  });

  return fake;
}
