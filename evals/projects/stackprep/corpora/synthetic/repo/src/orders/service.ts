import type { Database } from "../db/client";
import { findOrdersByCustomer, insertOrder, insertOrderItems, listOrderPage, type OrderRow } from "../db/orders-repo";
import { chargeCard } from "../payments/charge";
import { LruCache } from "../cache/lru";
import { validateOrderInput } from "./validate";

export interface OrderPage {
  orders: OrderRow[];
  offset: number;
}

export class OrderService {
  private readonly customerOrders = new LruCache<string, OrderRow[]>(500);

  constructor(private readonly db: Database) {}

  /**
   * Validates the order, writes it and its items in one transaction, then charges the card.
   * Each call creates a new order.
   */
  async createOrder(body: unknown): Promise<OrderRow> {
    const input = validateOrderInput(body);
    const order = await this.db.transaction(async (tx) => {
      const row = await insertOrder(tx, input.customerId, input.currency);
      await insertOrderItems(tx, row.id, input.items);
      return row;
    });
    await chargeCard({ orderId: order.id, paymentMethodId: input.paymentMethodId, currency: input.currency });
    this.customerOrders.delete(input.customerId);
    return order;
  }

  async listOrders(offset: number, limit: number): Promise<OrderPage> {
    const orders = await listOrderPage(this.db, offset, limit);
    return { orders, offset };
  }

  async ordersForCustomer(customerId: string): Promise<OrderRow[]> {
    const cached = this.customerOrders.get(customerId);
    if (cached) {
      return cached;
    }
    const rows = await findOrdersByCustomer(this.db, customerId);
    this.customerOrders.set(customerId, rows);
    return rows;
  }
}
