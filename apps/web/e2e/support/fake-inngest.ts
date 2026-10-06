import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export interface ReceivedEvent {
  id?: string;
  name: string;
  data: Record<string, unknown>;
}

const EVENTS_PATH = "/__e2e/events";

function reply(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "null");
}

/**
 * Stands in for the Inngest Dev Server's event API (`POST /e/:key`). Edge Functions reach it
 * through `INNGEST_DEV` in `supabase/functions/.env.e2e`, so enqueueing succeeds for real but no
 * job ever runs; tests complete planning and reports by writing the job outcome themselves.
 */
export async function startFakeInngest(port: number): Promise<{ close(): Promise<void> }> {
  const events: ReceivedEvent[] = [];
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === EVENTS_PATH) {
      reply(res, 200, events);
      return;
    }
    if (req.method === "POST" && req.url?.startsWith("/e/")) {
      readJson(req).then(
        (body) => {
          const batch = (Array.isArray(body) ? body : [body]) as ReceivedEvent[];
          events.push(...batch);
          reply(res, 200, { ids: batch.map(() => randomUUID()), status: 200 });
        },
        () => reply(res, 400, { error: "invalid JSON", status: 400 }),
      );
      return;
    }
    reply(res, 404, { error: "not found", status: 404 });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", (err: NodeJS.ErrnoException) => {
      reject(
        err.code === "EADDRINUSE"
          ? new Error(`E2E: port ${port} is in use; the fake Inngest server needs it (E2E_INNGEST_PORT).`)
          : err,
      );
    });
    // All interfaces: the Edge runtime container reaches the host through host.docker.internal.
    server.listen(port, "0.0.0.0", resolve);
  });

  return {
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Events the fake has accepted during this run. */
export async function receivedInngestEvents(port: number): Promise<ReceivedEvent[]> {
  const res = await fetch(`http://127.0.0.1:${port}${EVENTS_PATH}`);
  return (await res.json()) as ReceivedEvent[];
}
