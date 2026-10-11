import { z } from "zod";

export const MAX_LINE_ITEMS = 50;

export const orderInputSchema = z.object({
  customerId: z.string().uuid(),
  currency: z.enum(["USD", "EUR", "GBP"]),
  items: z
    .array(z.object({ sku: z.string().min(1).max(64), quantity: z.number().int().min(1).max(100) }))
    .min(1)
    .max(MAX_LINE_ITEMS),
  paymentMethodId: z.string().min(1),
});

export type OrderInput = z.infer<typeof orderInputSchema>;

/** Parses untrusted request bodies; throws a ZodError describing every invalid field. */
export function validateOrderInput(body: unknown): OrderInput {
  return orderInputSchema.parse(body);
}
