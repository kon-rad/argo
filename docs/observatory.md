# Observatory evidence API and replay

Observatory 1 provides bounded, authorized evidence windows over existing usage, archive, board and org records, plus a pure replay contract. It has no scene or navigation entry yet. Enable `observatory` in `MODULES` or the vault's `secondbrain.json` `addons` list. It defaults off. There are no new collectors, tables, credentials, timers or model calls.

## Authorization

All three endpoints mount behind the same owner session gate as Usage and Org. Local deployments use the local owner boundary. Board bearer tokens, ingest tokens and knowledge tokens do not grant Observatory access. Queries use the source viewers' existing database pool and effective role, with no role elevation, security-definer calls or RLS changes. A restricted database role sees its visible subset; zero visible rows never proves a source is empty. SQL permission denial returns 403 rather than fabricated empty coverage. Coverage reports the effective role, RLS, table ownership and bypass flags.

Source adapters also require their source module: `usage` for archive, calls and runs, `board` for card events, `org` for messages. Disabled sources are labelled in coverage and omitted from windows. Detail rechecks the source module and current row visibility. Continuation requests recheck all source rows supporting the export, including boundary state and execution intervals. Exports bind to the authenticated session hash and cannot be shared with a different session. A new login starts a new export.

## API

| GET endpoint | Parameters and result |
|---|---|
| `/api/observatory/coverage` | Required ISO instants `from`, `to`; optional `host`, numeric archive `session`. Returns source ranges, host/runtime groups, row counts, untimed rows, unknown run intervals, effective policy and truncation diagnostics. `session_updated_at` is archive freshness, not process liveness. Per-message observation time and ingestion freshness otherwise remain unknown. More than 200 groups sets `hasMoreGroups=true` and `truncatedGroups=null` because the remaining count is unknown. |
| `/api/observatory/window` | Same range/filter parameters. Returns `version`, half-open `[from,to)` window, boundary state, recorded execution intervals, ordered events, diagnostics, `export`, `total`, `next` and `resolution`. First page is at most 500 events. |
| `/api/observatory/window?export=<token>&offset=<next>&limit=500` | Continue the immutable snapshot. Range and filters cannot change. `limit` is 1 to 500. `next=null` ends pagination. |
| `/api/observatory/events/<encoded-event-id>?export=<token>` | Returns pinned event metadata and an authorized source pointer, including stable row ID and part key. No transcript body, tool arguments, hidden thinking or current card state is returned. Missing/deleted source rows return 404; denied source reads return 403. |

Ranges must be positive and at most 24 hours. Unknown parameters return 400. Archive JSON transfer is additionally capped at four MiB before expansion. Source reads use a read-only repeatable-read transaction, a three-second per-statement timeout and a 5,000-record cap for each source and expanded result. Oversized results return 413, rather than silently truncating a replay. Query timeout returns 503. Narrow the range or select a session. Archive pairing requires the selected sessions' bounded prior history; a long session can exceed the cap even with a narrow range. A future materialized projection can remove that limitation.

Exports last five minutes, with at most eight exports, four MiB per export and 32 MiB per app instance. Eviction, expiry, process restart and a token belonging to another session return 410 with an explicit restart instruction. Concurrent imports cannot reorder existing pages. Detail validates visibility but returns pinned metadata: it does not pretend that a mutable source body is part of the snapshot. Complete all pages before replaying or exporting locally; `total` is the expected event count. Boundary and intervals repeat on each page.

Host or session filters exclude board and org events because those sources have no reliable host/session identity. Filtering does not infer a join through today's roster or an unscoped run string. Coverage labels these limits. Counts describe the caller-visible, requested range only; historical completeness and human-origin coverage remain unknown. Production coverage requires a separate audit.

## Evidence and identity

The public pure module is `@secondbrain/contracts/observatory`. Every event has schema version, canonical ID, source table/row/part, occurred time (UTC epoch milliseconds or null), observation time (unknown unless independently recorded), timestamp precision, source sequence, recorded part index, actor provenance and optional causal reference. Parts at the same timestamp retain their source order; no synthetic milliseconds are invented. Untimed events remain in the event list with null time and never affect replay state.

Archive session identity is `archive:<numeric-session-id>`. Archive context retains host, source, harness and external session ID as separate fields. An execution is `run:<encoded-host>:<encoded-run-id>`, never a persona or conversation ID. A tool occurrence is the archive message part's canonical ID. Tool result pairing is scoped to the numeric archive session and recorded occurrence. A reused tool ID starts a new occurrence. If multiple unmatched calls reuse one identifier, the result stays unpaired. A result needs a recorded matching identifier and noncontradictory known timestamps; unmatched results retain unknown causality. Subagents with their own archive session remain distinct.

Archive events reuse `archive/steps.ts` expansion. Usage rows are separate `usage` events with tokens/model, never extra tool events. Joins use host, source/runtime and external session identity. Archive expansion does not join usage rows, so two calls and two resumed runs cannot multiply one archived operation. Execution attribution requires exactly one containing recorded interval; overlap is left unassigned. No adjacency across machines establishes causality. Org thread and task references are explicit; current roster labels are not historical human provenance.

Prompts remain `actor.kind=unknown` without independently recorded sender provenance. `role=user`, channel text and a current roster runtime do not prove human origin. Org author/channel provenance is retained but its historical actor kind stays unknown. Thinking events expose availability only. Successful file changes, commit/review/merge facts and hidden reasoning are not reconstructed from token totals, shell text or missing history.

## Replay semantics

`makeWindow` applies only events strictly before `from` to build the boundary. Card state comes from recorded transitions, never `cards.status`. The latest prior state-bearing event establishes each card's initial state. Creation/move payloads, claim, block and explicit finish outcomes are understood. Assignment, reclaim and dependency events whose resulting status is not fully recorded reset the state to unknown. Boundary provenance maps every derived ticket/tool state to its last recorded event, source pointer and occurred time. A card with no prior state remains absent/unknown, even if it is done today.

`replay(window, cursor)` restores a fresh boundary copy, deduplicates canonical event IDs, orders timed events and binary-searches through `cursor` inclusively. Backward and forward seeks return the same semantic state without mutating input. Calls start pending; only a result at or before the cursor can complete them. Source normalizers that do not record success leave the result outcome unknown. The reducer returns ticket/tool state and active executions; event detail stays in the pinned window.

Visibility is exactly `start <= cursor < end` over recorded `usage_runs` execution intervals. Concurrent runs remain distinct. Resumed sessions produce separate intervals and empty idle gaps. Missing, inverted or open interval ends are excluded, not extended to infinity. Conversation archive start/end, import freshness and current persona presence cannot supply execution intervals. Active replay output excludes future end/outcome fields. This version supports historical recorded execution only; current live executions require prospective lease/process capture and are labelled unsupported. A board lease is not automatically equated to a running process.

## Validation and audit

Run `cd app && npm run build && npm test` against a disposable `SB_TEST_DB` ending in `_test`. `observatory-db.test.ts` audits migrated schema joins with synthetic fixtures: one archive operation, two resumed/concurrent runs and two matching usage rows must yield one tool event, two usage events and two execution intervals. It also executes the historical card query against the schema.

For a keyless, database-free subset, run `cd app && npm run build:shared && npx vitest run --config observatory.vitest.config.ts`. This checks pure adapters/replay, request validation, source denial, immutable pagination, expiry and cache bounds. It does not validate PostgreSQL query syntax, RLS, query plans, HTTP session integration or production completeness.

The coordinator can run [the read-only audit](audits/observatory.sql) against production under the same effective role as the app, and separately under restricted reader roles. Keep outputs private. Report role, exact revision, time, counts, join multiplicities, missing fields and query plans as separate evidence. No historical fixed count is an acceptance target. This slice adds no rendered UI, so browser/rendering budgets belong to a later scene implementation.
