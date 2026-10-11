import type { IncomingHttpHeaders } from "node:http";
import { Database } from "../db/client";
import { markOrderStatus } from "../db/orders-repo";
import { loadConfig } from "../config";

interface GatewayEvent {
  type: "charge.succeeded" | "charge.failed";
  data: { orderId: string };
}

/** Applies a payment gateway event to the order it refers to. */
export async function handleGatewayWebhook(body: string, headers: IncomingHttpHeaders): Promise<void> {
  const event = JSON.parse(body) as GatewayEvent;
  const db = new Database(loadConfig().databaseUrl);
  try {
    await markOrderStatus(db, event.data.orderId, event.type === "charge.succeeded" ? "paid" : "failed");
  } finally {
    await db.close();
  }
  void headers;
}
