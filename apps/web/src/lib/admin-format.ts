import { type AdminWindowDays, adminWindowDaysSchema, DEFAULT_ADMIN_WINDOW_DAYS } from "@stackprep/shared";

/** The `?days=` search param, falling back to the default for anything not offered. */
export function parseAdminWindow(value: string | string[] | undefined): AdminWindowDays {
  const parsed = adminWindowDaysSchema.safeParse(typeof value === "string" ? value : undefined);
  return (parsed.success ? parsed.data : DEFAULT_ADMIN_WINDOW_DAYS) as AdminWindowDays;
}

const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});
const count = new Intl.NumberFormat("en-US");

export function formatUsd(value: number): string {
  return usd.format(value);
}

export function formatCount(value: number): string {
  return count.format(value);
}

/** A 0-1 ratio as a percentage; an em dash when there is nothing to divide. */
export function formatPercent(ratio: number | null): string {
  return ratio === null || !Number.isFinite(ratio) ? "—" : `${(ratio * 100).toFixed(1)}%`;
}

export function formatMs(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return "—";
  }
  return value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${Math.round(value)} ms`;
}
