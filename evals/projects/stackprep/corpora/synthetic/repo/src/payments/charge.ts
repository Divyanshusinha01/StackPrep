import { withRetry } from "../utils/retry";

const GATEWAY_URL = "https://api.gateway.example/v1/charges";

export interface ChargeRequest {
  orderId: string;
  paymentMethodId: string;
  currency: string;
}

export class CardDeclinedError extends Error {}

async function postCharge(request: ChargeRequest): Promise<{ chargeId: string }> {
  const res = await fetch(GATEWAY_URL, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${process.env.GATEWAY_API_KEY}` },
    body: JSON.stringify(request),
  });
  if (res.status === 402) {
    throw new CardDeclinedError(`card declined for order ${request.orderId}`);
  }
  if (!res.ok) {
    throw new Error(`gateway returned ${res.status}`);
  }
  return (await res.json()) as { chargeId: string };
}

/** Charges the order's payment method through the gateway, retrying failed attempts. */
export function chargeCard(request: ChargeRequest): Promise<{ chargeId: string }> {
  return withRetry(() => postCharge(request), { attempts: 5, delayMs: 0 });
}
