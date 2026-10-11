import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { loadConfig } from "./config";
import { createLogger } from "./lib/logger";
import { RateLimiter } from "./middleware/rate-limit";
import { requireCsrfToken } from "./middleware/csrf";
import { Database } from "./db/client";
import { OrderService } from "./orders/service";
import { handleGatewayWebhook } from "./payments/webhook";

type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => Promise<void>;

export function buildRoutes(orders: OrderService): Record<string, Handler> {
  return {
    "POST /orders": async (req, res, body) => {
      const order = await orders.createOrder(JSON.parse(body));
      res.writeHead(201, { "content-type": "application/json" }).end(JSON.stringify(order));
    },
    "GET /orders": async (req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const page = await orders.listOrders(Number(url.searchParams.get("offset") ?? 0), Number(url.searchParams.get("limit") ?? 20));
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(page));
    },
    "POST /webhooks/gateway": async (req, res, body) => {
      await handleGatewayWebhook(body, req.headers);
      res.writeHead(204).end();
    },
  };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export async function main(): Promise<void> {
  const config = loadConfig();
  const log = createLogger("server");
  const db = new Database(config.databaseUrl);
  const limiter = new RateLimiter(config.rateLimitPerMinute);
  const routes = buildRoutes(new OrderService(db));

  const server = createServer(async (req, res) => {
    const key = `${req.method} ${(req.url ?? "/").split("?")[0]}`;
    const route = routes[key];
    if (!route) {
      res.writeHead(404).end();
      return;
    }
    if (!limiter.allow(req.socket.remoteAddress ?? "unknown")) {
      res.writeHead(429).end();
      return;
    }
    if (req.method !== "GET" && !key.startsWith("POST /webhooks/") && !requireCsrfToken(req)) {
      res.writeHead(403).end();
      return;
    }
    try {
      await route(req, res, await readBody(req));
    } catch (err) {
      log.error("request_failed", { route: key, error: String(err) });
      res.writeHead(500).end();
    }
  });

  server.listen(config.port, () => log.info("listening", { port: config.port }));

  // Stop accepting connections, let in-flight requests finish, then close the pool.
  const shutdown = () => {
    log.info("shutting_down", {});
    server.close(() => {
      void db.close().then(() => process.exit(0));
    });
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
