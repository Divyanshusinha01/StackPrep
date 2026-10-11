import { useMemo } from "react";

export interface CartLine {
  sku: string;
  name: string;
  unitPrice: number;
  quantity: number;
}

const TAX_RATE = 0.08;

export function computeTotals(lines: CartLine[]): { subtotal: number; tax: number; total: number } {
  const subtotal = lines.reduce((sum, line) => sum + line.unitPrice * line.quantity, 0);
  const tax = Math.round(subtotal * TAX_RATE * 100) / 100;
  return { subtotal, tax, total: subtotal + tax };
}

export function CartSummary({ lines, onCheckout }: { lines: CartLine[]; onCheckout: () => void }) {
  const totals = useMemo(() => computeTotals(lines), [lines]);
  return (
    <section aria-label="Cart summary">
      <ul>
        {lines.map((line) => (
          <li key={line.sku}>
            {line.name} x {line.quantity}
          </li>
        ))}
      </ul>
      <p>Subtotal: {totals.subtotal.toFixed(2)}</p>
      <p>Tax: {totals.tax.toFixed(2)}</p>
      <p>Total: {totals.total.toFixed(2)}</p>
      <button type="button" onClick={onCheckout} disabled={lines.length === 0}>
        Checkout
      </button>
    </section>
  );
}
