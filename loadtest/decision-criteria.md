# Realtime cutover: decision criteria

Written and committed with the SSE baseline, before any Realtime run. Phase 7 applies these as written; changing them after Realtime numbers exist needs an explicit note explaining why.

There are two SSE result sets:

- `results/sse-baseline/` is **the baseline**: the edge runtime exactly as `supabase functions serve` configures it, including its per-isolate CPU limits (1 s soft, 2 s hard).
- `results/sse-baseline-uncapped/` is **a diagnostic**: identical except those CPU limits are raised (600 s / 1200 s), so streams are not killed with their isolate. It shows the load SSE polling puts on the database when every stream stays alive. The capped baseline under-states that load wherever streams died and stopped polling.

Realtime is run once, with the default edge runtime (the edge runtime then only serves writes, and Realtime does not depend on its CPU limits).

## Comparison validity

The Realtime run (`results/realtime/`) is comparable only if all of these match the baseline's `environment.json`:

- `config.json` and `schedule.json` unchanged (same seed, stages, timing windows, workload, container limits, thresholds). The SHA-256 of both files is listed below.
- Same machine, Docker VM size, Supabase CLI version, container images, and k6 build (k6 v2.2.0 + xk6-sse v0.2.0).
- Same 3 runs per stage, same medians, same stages (including any extension stage the baseline reached).

Any harness change (seeding, writer, analysis, sampling) means re-running the SSE baseline with the changed harness before comparing.

## Correctness gates (must all hold)

1. **Zero lost events.** `frames.dropped = 0`, `frames.duplicates = 0`, and `frames.readersWithoutReport = 0` in every Realtime load run, and the Phase 5 integration test (writer + subscribe + socket kill + reconnect) receives exactly the written set.
2. **Contract checklist.** Every item in `interview-events-contract.md` section 5 passes for the Realtime path in the shared suite.
3. **No data exposure regression.** Checklist item A5: no delivered message carries transcript content, event payloads, or report content, unless that is explicitly accepted beforehand (contract audit, decision 2).

## Performance gates (per stage, medians over 3 runs, at the same concurrency)

4. **Latency SLO.** p95 frame delay ≤ 3000 ms. For Realtime this applies to all rows. It has no lifetime reconnect, so there is no separate "connected" figure.
5. **Errors.** Error rate ≤ 1%, with no polling fallbacks, at every stage up to the target concurrency.
6. **DB read load lowered meaningfully.** Compared with the **uncapped diagnostic**, at 100 and 200 concurrent interviews (and any extension stage), both of these must hold:
   - Total DB statements/s (all categories, so Realtime's own change-polling and RLS queries count) at least 50% lower than SSE.
   - DB container CPU p50 at least 30% lower than SSE.
   Catch-up and periodic reconciliation reads are part of the Realtime numbers, not excluded.
7. **Headroom on Realtime's own limits.**
   - Locally, the Realtime container CPU p50 stays below 90% of its pinned limit at the highest stage SSE passed.
   - On the hosted plan, the plan's concurrent-connection, messages/s, and channel-joins/s limits must be at least 2× the demand at the target concurrency. Demand is one connection and one join per open interview, and messages/s is the measured per-interview message rate × concurrency.

## Outcomes

- **Cut over** only if gates 1-7 all hold. The cutover then follows the plan's Phase 7: re-run the consumer inventory, keep a deprecation window with the flag defaulting to `realtime` while SSE stays deployed, then remove the SSE endpoint and update the architecture doc.
- **Keep SSE** if any gate fails, or if Realtime only moves the bottleneck (for example DB load drops but Realtime CPU or plan limits cap concurrency at or below the SSE ceiling). Optional follow-ups are a longer poll interval or a cheaper poll query. The Realtime code stays flagged off or is removed, and the architecture doc records the measured findings only.

## Open inputs (not in the docs)

- **Target concurrency.** Neither `PRD.md` nor `architecture.md` sets a concurrent-interview target. Until one is set, the target is the highest stage the uncapped diagnostic passed (or the highest stage run, if none breached).
- **Intended hosted plan.** It is not named in the docs. Gate 7's hosted check needs the plan's published Realtime limits at decision time.

## Pinned inputs

SHA-256 of the files with LF line endings:

| File | SHA-256 |
| --- | --- |
| `config.json` | `601c6c8b11803905ee1310a4b61fe9b3707b3dac0e6c6a72d8238ca78b2c1934` |
| `schedule.json` | `d6a7d7da211bb313626f3ef25b6e71164e083eb8246aa5ed869afc6de199b204` |
