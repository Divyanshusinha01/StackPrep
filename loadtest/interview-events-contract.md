# Interview events: transport contract audit

Audit of `GET /interviews/:id/events` (SSE) before any transport change. Nothing here changes behavior. The checklist at the end is what a Realtime path must pass before it can replace or sit beside SSE.

Sources read: `supabase/functions/interviews/events.ts`, `handler.ts` (`streamEvents`), `packages/shared/src/realtime.ts`, the web consumers below, the migrations that write `interview_events`, `interview_messages` and `reports`, the RLS migrations, the e2e suite, `architecture.md` (Transport) and `techstack.md`.

## 1. Consumers

| Location | Depends on |
| --- | --- |
| `supabase/functions/interviews/events.ts` | Producer. `createInterviewStreamReader` (RLS reads), `pollStreamEvents` (merge, cursor, `report_ready` gating), `createInterviewStream` (SSE body, heartbeat, 140 s lifetime), `DEFAULT_STREAM_TIMING`, `STREAM_BATCH_LIMIT = 100`. |
| `supabase/functions/interviews/handler.ts` `streamEvents` | Auth (`401 unauthorized`), UUID check and RLS ownership read (`404 interview_not_found`), cursor from `Last-Event-ID` or `?last_event_id=` (header wins), `400 invalid_cursor`. |
| `packages/shared/src/realtime.ts` | `interviewStreamEventSchema` (three events, strict data), `InterviewStreamCursor`, `format/parseInterviewStreamCursor`, `INITIAL_INTERVIEW_STREAM_CURSOR`, `INTERVIEW_STREAM_RETRY_MS`, `INTERVIEW_STREAM_HEARTBEAT_MS`. |
| `apps/web/src/components/app/interview-event-stream.ts` | Fetch-based SSE parser, cursor kept from the last `id:`, reconnect with backoff, `400` resets the cursor, stops after `report_ready`, `onFallback` after `STREAM_MAX_FAILURES = 3` failed connects. Frames that fail the schema are skipped but still advance the cursor. |
| `apps/web/src/components/app/use-interview-events.ts` | Only hook that starts the stream. Builds the URL, fresh token per connect via `getSession()`, switches to 4 s polling (`usePollWhile`) on fallback for the rest of the session. Returns `idle`, `stream` or `polling` (no caller reads the return value today). |
| `apps/web/src/components/app/interview-session.tsx` `onStreamEvent` | The only event handler. `turn_persisted` calls `confirmTurn`; `interview_status: terminated` calls `terminate()`; `interview_status: completed` sets `streamedCompletion` (ends the room, after up to 30 s if live); `report_ready` sets `reportReady`, which redirects to the report once the room is over. `in_progress` is ignored. |
| `apps/web/src/components/app/use-realtime-interview.ts` `confirmTurn` | `highestAckedTurnRef = max(…, turn_sequence)` (used to decide whether a resumed session's recap is stale) and `outbox.confirm(client_event_id)`. |
| `apps/web/src/components/app/transcript-outbox.ts` `confirm` | Drops a queued, not-in-flight item by `client_event_id`; no-op otherwise. |

Not consumers, despite the plan's list:

- `interview-room.tsx` has no stream dependency; all stream handling is in `interview-session.tsx`.
- `apps/web/src/lib/interview-events.ts` is the `POST /events` writer only.
- `e2e/support/fake-realtime.ts` fakes only OpenAI (session mint, WebRTC, data channel, tool calls). The SSE endpoint runs for real in e2e.
- The fields `event_sequence`, `occurred_at`, `item_id` and `generated_at` are validated but not read by any consumer.

### e2e dependence

No e2e spec asserts on stream frames. The stream runs during `interview.spec.ts` and `end-interview.spec.ts`, but each observed outcome has another cause: turns are checked in the database, and the post-end redirect comes from the 3 s timer on `ended`, not from `report_ready`. `report.spec.ts` and `delete-interview.spec.ts` rely on server page redirects and never open the stream. Running e2e on both flag values therefore says little about the transport. Phase 5 should add one stream-only e2e case: complete or terminate the interview from the server while the room is open, and assert the room ends and moves to the report without any client action.

## 2. Ordering contract

Facts from the producer:

- Two independent per-interview sequences: `interview_events.sequence` and `interview_messages.sequence`. Every production writer assigns `max(sequence) + 1` while holding `pg_advisory_xact_lock(hashtext('<table>'), hashtext(interview_id))` until commit (`record_transcript_turn`, `record_voice_event`, tool-call, integrity, pause, end and code-memory functions). Within a table and interview, sequences are therefore **gapless and commit in sequence order**. The out-of-order-commit risk in the plan does not apply within one source for production writers. It applies only to cross-source order and to rows written without the lock (only SQL tests do that).
- Gaps in what the client sees come only from filtering. `interview_events` contains types that are never streamed (`pause`, `resume`, `connected`, `disconnected`, `tool_call`, `evidence_examined`, `integrity_check`, `integrity_warning`). `interview_messages` can contain `role = 'system'` rows, which are not streamed. A gap detector must track the max sequence over **all** rows of a source, not just emitted ones. The current SSE cursor only advances on emitted rows, which is fine for `> cursor` reads but cannot be reused as a gap detector.
- Merge order within one poll: `created_at`, then source (status before turn), then sequence. Each frame's id is the cursor after it.
- Components never move backwards. A row at or below its component of the cursor is skipped.
- `report_ready` is emitted only when both batches are short (`< limit`), so it is the last frame, and exactly once per cursor lineage (`reportSent`).
- Status mapping: `start → in_progress`, `completion → completed`, `termination → terminated`.
- `reports` is written by `save_report` as an upsert. A regeneration is an `UPDATE` that moves `generated_at`. `report_ready` fires once, so watching inserts is enough. A Realtime path must not re-emit on update.

What consumers actually need: within-source order matters for `highestAckedTurnRef` only through `max`, and for statuses only through "the last terminal status wins" (the client ignores `in_progress`). Cross-source interleaving is not load-bearing. `report_ready` being last is, because the redirect must not happen before pending `turn_persisted` and status events are applied. The Realtime path should still use the same comparator so both transports produce identical sequences in the shared suite.

Handler idempotency: every handler is safe to call twice (`confirm` is a no-op on a missing id, `max` is monotonic, the state setters are boolean latches, `close` dispatch is idempotent). Duplicates are harmless today but the contract still forbids them, so the duplicate count in Phases 4 and 6 stays a valid measure.

Known SSE quirk to keep or fix deliberately: a `400 invalid_cursor` makes the client drop its cursor and reconnect with none, which replays from `0.0.0`. Only a server-refused cursor triggers this, and the idempotent handlers absorb it.

## 3. Authorization and data exposure

- SSE reads use the caller's JWT client, so RLS applies. Authorization happens in this order: authenticated, valid UUID, `interviews` row visible under RLS, then stream. All three tables grant `select` to `authenticated` with owner policies (`user_id = auth.uid()` plus `interviews.deleted_at is null`, migration `20261008160000_delete_interview.sql`). There are no column-level grants, so an owner can already read every column of their own rows through PostgREST.
- A soft-deleted interview disappears from RLS immediately. SSE then returns `404` on the next connect, counts it as a failure, and falls back to polling. The server page handles the rest.
- None of the three tables is in the `supabase_realtime` publication today; no migration mentions a publication.

**What SSE sends:** ids, sequences, role, status, and timestamps. It sends no transcript content, no payloads, and no report content. The architecture doc states this as a property ("No transcript content is sent").

**What `postgres_changes` would send** (per the Phase 5 plan): full new rows, subject to RLS per subscriber. That means:

- `interview_messages.content` (full transcript) and `metadata`
- `interview_events.payload` for every event type, including `tool_call` args and `result_summary`, `evidence_examined` paths and commit SHAs, and `integrity_check` outcomes
- `reports.content`, the whole report

No other user can receive these rows, since RLS is checked per subscriber. But the browser would receive data that the current contract deliberately withholds, and messages would be much larger. That affects the message-size and throughput numbers in Phase 6.

## 4. Decisions needed before Phase 5

1. **Tech stack.** `techstack.md` lists **HTTP + SSE** for application communication and does not include Supabase Realtime. The architecture only says "revisit with Supabase Realtime if needed". Adding a Realtime client path, even behind a flag, is a stack change that needs explicit approval.
2. **Delivery mechanism.** One option is `postgres_changes`, as the plan describes; it exposes the full rows listed above. The other is Broadcast from the database: a trigger sends only the SSE-shaped fields on a private per-interview channel, authorized by RLS on `realtime.messages`. The second option keeps the "no content is sent" property, filters event types and roles server-side, and avoids per-change, per-subscriber RLS evaluation on the change stream. It also changes the plan's migration step (a trigger and a `realtime.messages` policy instead of publication membership).

## 5. Contract checklist

Each item must hold for both transports in the shared suite (Phase 5). "Today" is the existing test that covers it for SSE.

Authorization

- **A1.** No session results in no events. The client counts it as a failure and does not connect. Today: `interview-event-stream.test.ts` "counts a missing session as a failure".
- **A2.** An unauthenticated request gets `401`; a non-owner, malformed id, or soft-deleted interview gets `404 interview_not_found`, and no event is delivered. Today: `events.test.ts` "auth and ownership are checked before streaming".
- **A3.** User B subscribed to user A's interview id receives nothing, both live and in catch-up. Today this is RLS only; there is no transport test. Phase 5 adds an integration test against the local stack.
- **A4.** After a session refresh, delivery continues with the new token. For Realtime that means `realtime.setAuth`; for SSE, a fresh token per connect.
- **A5.** No delivered message contains transcript content, event payloads, or report content, unless decision 2 above explicitly accepts it.

Event shapes

- **S1.** Only `interview_status`, `turn_persisted` and `report_ready` are emitted, each passing `interviewStreamEventSchema`. Today: "full replay emits only the three event types".
- **S2.** Status mapping is `start/completion/termination` to `in_progress/completed/terminated`; other event types are never emitted. Today: "termination maps to the terminated status".
- **S3.** `turn_persisted` is emitted only for `ai` and `user` rows, with `client_event_id`, and `item_id` when present.

Ordering and delivery

- **O1.** Every eligible row inserted after the subscription is ready, or after the resume cursor, is delivered exactly once.
- **O2.** Within a source, delivery is in ascending sequence. Across sources, delivery follows the `created_at`, source, sequence comparator within a batch.
- **O3.** Cursor components never decrease, and a row at or below its component is never re-emitted. Today: "rows appearing between polls are emitted once, with non-decreasing ids".
- **O4.** Resuming from any emitted cursor replays exactly the strictly later events. Today: "reconnecting with each emitted id replays exactly the strictly later events".
- **O5.** A cursor ahead of the data emits nothing until rows pass it. Today: "a cursor ahead of the stored data emits nothing".
- **O6.** A malformed cursor is rejected and never silently treated as `0.0.0` by the server. Today: "a malformed cursor is rejected".
- **O7.** Gaps are detected against all rows of a source, including non-streamed event types and `system` messages. A cursor is never advanced past an unresolved gap. (Realtime only; SSE reads by range.)

Terminal behavior

- **T1.** `report_ready` is emitted only after both sources are drained, and is the last event. Today: "report_ready waits until both batches are drained".
- **T2.** `report_ready` is emitted at most once per cursor lineage; a report regeneration (an `UPDATE`) does not re-emit it. Today: "a cursor with the report flag set never re-emits report_ready".
- **T3.** After `report_ready` the client stops receiving and reconnecting. Today: "stops for good after report_ready".

Failure and fallback

- **F1.** After 3 consecutive failed connects or subscribes, the client stops the transport and the page falls back to 4 s polling for the rest of the session. Today: "falls back to polling after 3 consecutive failed connects".
- **F2.** A successful connect or subscribe resets the failure count. Today: "resets the failure count after a successful connect".
- **F3.** `stop()` (unmount, `enabled` false) ends all network activity and timers. Today: "stop() ends the loop", and "a client abort stops the stream" on the server.
- **F4.** A transport that stays connected but silently stops delivering is caught within a bounded time (Realtime: periodic reconciliation; SSE: the 140 s lifetime reconnect).

Consumer behavior (end to end, both flag values)

- **E1.** A turn stored by `POST /events` whose ack was lost is confirmed by `turn_persisted` and is not resent.
- **E2.** A server-side completion or termination while the room is open ends the room with no client action. This is the stream-only e2e case proposed in section 1.
- **E3.** `report_ready` after the room is over navigates to `/interviews/:id/report`.
