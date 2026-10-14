import type { Metadata } from "next";
import Link from "next/link";
import { ADMIN_INTERVIEW_COST_LIMIT, ADMIN_WINDOW_DAYS, type AdminMetricsResponse } from "@stackprep/shared";
import { AppShell } from "@/components/app/app-shell";
import { Notice } from "@/components/app/notice";
import { PageHeader } from "@/components/app/page-header";
import { getAdminMetrics, requireAdmin } from "@/lib/admin";
import { formatCount, formatMs, formatPercent, formatUsd, parseAdminWindow } from "@/lib/admin-format";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Admin",
  robots: { index: false },
};

function Section({ id, title, description, children }: {
  id: string;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="space-y-3">
      <div>
        <h2 id={id} className="text-sm font-semibold">{title}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      </div>
      <div className="overflow-x-auto rounded-xl border bg-panel/60">{children}</div>
    </section>
  );
}

function Table({ head, rows, empty }: { head: string[]; rows: React.ReactNode[][]; empty: string }) {
  if (rows.length === 0) {
    return <p className="px-4 py-3 text-sm text-muted-foreground">{empty}</p>;
  }
  return (
    <table className="w-full text-sm">
      <thead className="border-b text-left text-xs text-muted-foreground">
        <tr>
          {head.map((label, i) => (
            <th key={label} scope="col" className={cn("px-4 py-2 font-medium", i > 0 && "text-right")}>{label}</th>
          ))}
        </tr>
      </thead>
      <tbody className="divide-y">
        {rows.map((cells, r) => (
          <tr key={r}>
            {cells.map((cell, i) => (
              <td key={i} className={cn("px-4 py-2 tabular-nums", i > 0 && "text-right")}>{cell}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Dashboard({ metrics }: { metrics: AdminMetricsResponse }) {
  return (
    <div className="space-y-10">
      <Section
        id="voice-text"
        title="Voice vs text"
        description="Effective AI usage by channel. Estimated cost is still a duration estimate awaiting provider usage."
      >
        <Table
          head={["Channel", "Calls", "Cost", "Of which estimated", "Unpriced calls", "Audio seconds"]}
          empty="No usage in this window."
          rows={metrics.voice_text_split.map((row) => [
            row.channel,
            formatCount(row.calls),
            formatUsd(row.cost_usd),
            formatUsd(row.estimated_cost_usd),
            formatCount(row.unpriced_calls),
            formatCount(Math.round(row.audio_seconds)),
          ])}
        />
      </Section>

      <Section
        id="cache"
        title="Prompt cache hit rate"
        description="Cached input tokens over input tokens, text and audio together. Duration estimates and embeddings are excluded."
      >
        <Table
          head={["Channel", "Calls", "Input tokens", "Cached input tokens", "Hit rate"]}
          empty="No usage in this window."
          rows={metrics.cache_hit_rate.map((row) => [
            row.channel,
            formatCount(row.calls),
            formatCount(row.input_tokens),
            formatCount(row.cached_input_tokens),
            formatPercent(row.hit_rate),
          ])}
        />
      </Section>

      <Section
        id="latency"
        title="Tool latency"
        description="Realtime tool calls. Vector fill covers search_repository fills that were attempted; history starts at deploy."
      >
        <Table
          head={["Tool", "Calls", "Errors", "p50", "p95", "Vector fills", "Vector p50", "Vector p95", "Deadline fallbacks"]}
          empty="No tool calls in this window."
          rows={metrics.tool_latency.map((row) => [
            <span key="tool" className="font-mono">{row.tool}</span>,
            formatCount(row.calls),
            formatCount(row.error_calls),
            formatMs(row.p50_ms),
            formatMs(row.p95_ms),
            formatCount(row.vector_fills),
            formatMs(row.vector_p50_ms),
            formatMs(row.vector_p95_ms),
            formatPercent(row.deadline_fallback_share),
          ])}
        />
      </Section>

      <Section
        id="interview-cost"
        title="Cost per interview"
        description={`Interviews created in this window, most expensive first (top ${ADMIN_INTERVIEW_COST_LIMIT}). Cost sums priced calls only.`}
      >
        <Table
          head={["Interview", "Created", "Cost", "Voice", "Text", "Calls", "Unpriced", "Estimate"]}
          empty="No interviews in this window."
          rows={metrics.interview_cost.map((row) => [
            <span key="id" className="font-mono text-xs">{row.interview_id}</span>,
            new Date(row.interview_created_at).toISOString().slice(0, 16).replace("T", " "),
            formatUsd(row.cost_usd),
            formatUsd(row.voice_cost_usd),
            formatUsd(row.text_cost_usd),
            formatCount(row.calls),
            formatCount(row.unpriced_calls),
            row.has_estimate ? "yes" : "no",
          ])}
        />
      </Section>
    </div>
  );
}

export default async function AdminPage({ searchParams }: PageProps<"/admin">) {
  const user = await requireAdmin();
  const days = parseAdminWindow((await searchParams).days);
  const metrics = await getAdminMetrics(days);

  return (
    <AppShell user={user}>
      <PageHeader
        title="Admin"
        description="AI cost, cache, and tool latency. Aggregates and interview ids only."
        actions={
          <nav aria-label="Time window" className="flex gap-1 rounded-lg border p-1">
            {ADMIN_WINDOW_DAYS.map((option) => (
              <Link
                key={option}
                href={`/admin?days=${option}`}
                aria-current={option === days ? "page" : undefined}
                className={cn(
                  "focus-ring rounded-md px-2.5 py-1 text-sm",
                  option === days ? "bg-panel-raised font-medium" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {option}d
              </Link>
            ))}
          </nav>
        }
      />
      {metrics ? (
        <Dashboard metrics={metrics} />
      ) : (
        <Notice tone="error">Metrics are unavailable. Check that this account is in the backend ADMIN_USER_IDS too.</Notice>
      )}
    </AppShell>
  );
}
