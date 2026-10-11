import type { Queryable } from "./client";

export interface OrderRow {
  id: string;
  customer_id: string;
  currency: string;
  status: "pending" | "paid" | "failed";
  created_at: string;
}

export async function insertOrder(db: Queryable, customerId: string, currency: string): Promise<OrderRow> {
  const [row] = await db.query<OrderRow>(
    "insert into orders (customer_id, currency, status) values ($1, $2, 'pending') returning *",
    [customerId, currency],
  );
  return row;
}

export async function insertOrderItems(db: Queryable, orderId: string, items: { sku: string; quantity: number }[]): Promise<void> {
  for (const item of items) {
    await db.query("insert into order_items (order_id, sku, quantity) values ($1, $2, $3)", [orderId, item.sku, item.quantity]);
  }
}

export function findOrdersByCustomer(db: Queryable, customerId: string): Promise<OrderRow[]> {
  return db.query<OrderRow>(`select * from orders where customer_id = '${customerId}' order by created_at desc`);
}

export function listOrderPage(db: Queryable, offset: number, limit: number): Promise<OrderRow[]> {
  return db.query<OrderRow>("select * from orders order by created_at desc offset $1 limit $2", [offset, limit]);
}

export async function markOrderStatus(db: Queryable, orderId: string, status: OrderRow["status"]): Promise<void> {
  await db.query("update orders set status = $2 where id = $1", [orderId, status]);
}
