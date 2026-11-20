# Observatory evidence API and replay

Observatory 1 provides bounded, authorized evidence windows over existing usage, archive, board and org records, plus a pure replay contract. Observatory 2 adds an optional browser workspace and Usage navigation described below. Enable `observatory` in `MODULES` or the vault's `secondbrain.json` `addons` list. It defaults off. There are no new collectors, credentials, timers or model calls. Observatory 5 adds a rebuildable archive step projection column and indexes. A forward migration adds insertion-time sender provenance to org messages; historical rows are not backfilled.

## Authorization

All three endpoints mount behind the same owner session gate as Usage and Org. Local deployments use the local owner boundary. Board bearer tokens, ingest tokens and knowledge tokens do not grant Observatory access. Queries use the source viewers' existing database pool and effective role, with no role elevation, security-definer calls or RLS changes. A restricted database role sees its visible subset; zero visible rows never proves a source is empty. SQL permission denial returns 403 rather than fabricated empty coverage. Coverage reports the effective role, RLS, table ownership and bypass flags.

Source adapters also require their source module: `usage` for archive, calls and runs, `board` for card events, `org` for messages. Disabled sources are labelled in coverage and omitted from windows. Detail rechecks the source module and current row visibility. Continuation requests recheck all source rows supporting the export, including boundary state and execution intervals. Exports bind to the authenticated session hash and cannot be shared with a different session. A new login starts a new export.

## API

| GET endpoint | Parameters and result |
|---|---|
| `/api/observatory/coverage` | Required ISO instants `from`, `to`; optional `host`, numeric archive `session`. Returns source ranges, host/runtime groups, row counts, untimed rows, unknown run intervals, effective policy and truncation diagnostics. `session_updated_at` is archive freshness, not process liveness. Per-message observation time and ingestion freshness otherwise remain unknown. More than 200 groups sets `hasMoreGroups=true` and `truncatedGroups=null` because the remaining count is unknown. |
| `/api/observatory/window` | Same range/filter parameters. Returns `version`, half-open `[from,to)` window, boundary state, recorded execution intervals, ordered events, diagnostics, `export`, `total`, `next` and `resolution`. First page is at most 500 events. |
| `/api/observatory/window?export=<token>&offset=<next>&limit=500` | Continue the immutable snapshot. Range and filters cannot change. `limit` is 1 to 500. `next=null` ends pagination. |
| `/api/observatory/events/<encoded-event-id>?export=<token>` | Returns pinned event metadata and an authorized source pointer, including stable row ID and part key. No transcript body, tool arguments, hidden thinking or current card state is returned. Thinking detail may include an existing authorized Codex summary, with explicit hidden/unavailable states. Missing/deleted source rows return 404; denied source reads return 403. |

Ranges must be positive and at most 24 hours. Unknown parameters return 400. Selected archive source JSON is additionally capped at four MiB; bodies are not transferred to the replay reader. Source reads use a read-only repeatable-read transaction, a three-second per-statement timeout and a 5,000-record cap for each source and expanded result. Oversized results return 413, rather than silently truncating a replay. Query timeout returns 503. Narrow the range or select a session. Archive pairing uses content-free projected parts for prior tool calls/results, plus selected and untimed rows. Historical prompt, response and thinking bodies are never loaded per seek. Exact tool boundary state still grows with distinct historical occurrences: more than 5,000 required context records or expanded events returns 413, even with a narrow range. The API does not discard completed occurrences to invent a smaller boundary. Untimed rows remain explicit and count toward caps. Unknown time is never assigned an invented window.

Exports last five minutes, with at most eight exports, four MiB per export and 32 MiB per app instance. Eviction, expiry, process restart and a token belonging to another session return 410 with an explicit restart instruction. Concurrent imports cannot reorder existing pages. Detail validates visibility but returns pinned metadata: it does not pretend that a mutable source body is part of the snapshot. Complete all pages before replaying or exporting locally; `total` is the expected event count. Boundary and intervals repeat on each page.

Host or session filters exclude board and org events because those sources have no reliable host/session identity. Filtering does not infer a join through today's roster or an unscoped run string. Coverage labels these limits. Counts describe the caller-visible, requested range only; historical completeness and human-origin coverage remain unknown. Production coverage requires a separate audit.

## Evidence and identity

The public pure module is `@secondbrain/contracts/observatory`. Every event has schema version, canonical ID, source table/row/part, occurred time (UTC epoch milliseconds or null), observation time (unknown unless independently recorded), timestamp precision, source sequence, recorded part index, actor provenance and optional causal reference. Parts at the same timestamp retain their source order; no synthetic milliseconds are invented. Untimed events remain in the event list with null time and never affect replay state.

Archive session identity is `archive:<numeric-session-id>`. Archive context retains host, source, harness and external session ID as separate fields. An execution is `run:<encoded-host>:<encoded-run-id>`, never a persona or conversation ID. A tool occurrence is the archive message part's canonical ID. Tool result pairing is scoped to the numeric archive session and recorded occurrence. A reused tool ID starts a new occurrence. If multiple unmatched calls reuse one identifier, the result stays unpaired. A result needs a recorded matching identifier and noncontradictory known timestamps; unmatched results retain unknown causality. Subagents with their own archive session remain distinct.

Archive events reuse `archive/steps.ts` expansion. Usage rows are separate `usage` events with tokens/model, never extra tool events. Joins use host, source/runtime and external session identity. Archive expansion does not join usage rows, so two calls and two resumed runs cannot multiply one archived operation. Execution attribution requires exactly one containing recorded interval; overlap is left unassigned. No adjacency across machines establishes causality. Org thread and task references are explicit; current roster labels are not historical human provenance.

Prompts remain `actor.kind=unknown` without independently recorded sender provenance. `role=user`, channel text and a current roster runtime do not prove human origin. Org author/channel provenance is retained. New org messages snapshot `author_kind` from the roster in an invoker trigger at insertion; updates cannot rewrite that kind, and changing the author resets it to unknown. Historical rows stay unknown instead of borrowing today's roster. Archive prompts use explicit recorded `sender.kind` (`human`, `agent`, `automation`), with optional `sender.id` and `sender.channel`; roles or channel labels alone remain unknown. Collectors without this metadata remain unknown. Overview thinking events expose availability only. Successful file changes, commit/review/merge facts and hidden reasoning are not reconstructed from token totals, shell text or missing history.

## Replay semantics

`makeWindow` applies only events strictly before `from` to build the boundary. Card state comes from recorded transitions, never `cards.status`. The latest prior state-bearing event establishes each card's initial state. Creation/move payloads, claim, block and explicit finish outcomes are understood. Assignment, reclaim and dependency events whose resulting status is not fully recorded reset the state to unknown. Boundary provenance maps every derived ticket/tool state to its last recorded event, source pointer and occurred time. A card with no prior state remains absent/unknown, even if it is done today.

`replay(window, cursor)` restores a fresh boundary copy, deduplicates canonical event IDs, orders timed events and binary-searches through `cursor` inclusively. Backward and forward seeks return the same semantic state without mutating input. Calls start pending; only a result at or before the cursor can complete them. Source normalizers that do not record success leave the result outcome unknown. The reducer returns ticket/tool state and active executions; event detail stays in the pinned window.

Visibility is exactly `start <= cursor < end` over recorded `usage_runs` execution intervals. Concurrent runs remain distinct. Resumed sessions produce separate intervals and empty idle gaps. Missing, inverted or open interval ends are excluded, not extended to infinity. Conversation archive start/end, import freshness and current persona presence cannot supply execution intervals. Active replay output excludes future end/outcome fields. This version supports historical recorded execution only; current live executions require prospective lease/process capture and are labelled unsupported. A board lease is not automatically equated to a running process.

## Validation and audit

Run `cd app && npm run build && npm test` against a disposable `SB_TEST_DB` ending in `_test`. `observatory-db.test.ts` audits migrated schema joins with synthetic fixtures: one archive operation, two resumed/concurrent runs and two matching usage rows must yield one tool event, two usage events and two execution intervals. It also executes the historical card query against the schema.

For a keyless, database-free subset, run `cd app && npm run build:shared && npx vitest run --config observatory.vitest.config.ts`. This checks pure adapters/replay, request validation, source denial, immutable pagination, expiry and cache bounds. It does not validate PostgreSQL query syntax, RLS, query plans, HTTP session integration or production completeness.

The coordinator can run [the read-only audit](audits/observatory.sql) against production under the same effective role as the app, and separately under restricted reader roles. Keep outputs private. Report role, exact revision, time, counts, join multiplicities, missing fields and query plans as separate evidence. No historical fixed count is an acceptance target. The browser workspace has a separate synthetic scenario and unmeasured rendering budgets, described below.

## Browser workspace (Observatory 2)

With the addon enabled, open **Work > Observatory** at `/observatory`, or **Show activity** in a Usage session. The route and navigation remain absent when the module is off. The workspace uses pinned `three@0.186.1` and `3d-force-graph@1.80.1`, with zero warmup/cooldown physics ticks and deterministic machine/execution positions. Concurrent runs have independent markers. Session and attached edges disappear exactly at the recorded end; idle gaps have no execution marker. Current process liveness remains unsupported by slice 1. “Live history refresh” fetches a fresh recorded window every 15 seconds while the tab is visible, without extending open intervals or suggesting a process is running.

Usage links derive their range and cursor from recorded session start/end and loaded step timestamps. Sessions lasting up to 24 hours include their full known span, including the final instant. Longer sessions open the latest recorded day; use the range form to inspect earlier days. Missing start times use an available recorded end/step, and sessions with no time anchor show an explicit unknown-time label instead of a link. No wall-clock fallback invents evidence.

The URL stores UTC epoch-millisecond `from`, `to`, `cursor`, host, numeric archive session, ticket, runtime, persona, model, origin and selected event. Browser back/forward restores these values. Ranges are limited to 24 hours. Seek, reverse playback and previous/next event use the pure shared reducer. Events at the same instant step together in recorded order. The slider supports keyboard arrows. Labels use the app timezone; the range form accepts UTC ISO instants. Server host/session filters restrict source reads; the other filters apply to the loaded window. Origin filters affect events, leaving recorded execution identity intact. Ticket, persona and model event filters use recorded execution associations even after the execution ends, so past events remain inspectable while markers and edges disappear. A model label requires a usage observation at or before the cursor; it stays unknown beforehand.

Amber diamonds identify evidenced human origin; cyan spheres identify agents; grey boxes identify automation and hollow grey octahedra identify unknown origin. The same glyphs and words appear in the HTML event list and inspector. A prompt role alone never makes a human. Synthetic demo provenance is explicitly synthetic and never mixed with recorded API results. Short tool-call/result markers last two seconds of replay time and point to explicit file targets where available. Return arrows identify results. Structured `read`, `read_file`, `Read`, `write_file`, `Write`, `edit_file` and `Edit` inputs can supply a bounded `path` or `file_path`; other arguments and file contents are discarded. Shell command text is never parsed for targets. Every target is an operation attempt, including when a tool reports success, rather than proof of changed bytes.

The execution list, target list, timeline and inspector work without WebGL. Disable “Show 3D workspace” to use only HTML. Context loss or renderer construction failure gives the same fallback. Geometry/material resources, resize observers, interaction listeners and timers are released on unmount; geometry and materials are shared by visual kind/origin and retained across seeks until unmount. Visible meshes are reused by identity; unchanged scenes skip graph replacement. The renderer uses pixel ratio 1, no antialiasing, low-resolution spheres and retains the camera. Rendering pauses after 1.2 seconds without scene/camera interaction, and when the document is hidden. No continuous force simulation or transcript bodies run in the overview.

All immutable pages must arrive before replay. One current snapshot is kept in component memory, with no local storage or multi-window query cache. Loading aborts on range/filter changes and unmount. Event count is capped at 5,000; serialized page transfer accounting is capped at 32 MiB (including repeated boundaries), with explicit errors for incomplete, changed or oversized snapshots. This is a cache/transfer budget, not a measured browser heap ceiling. The display caps at 500 nodes and 1,500 edges and reports omissions; timeline HTML shows the latest 200 timed events through the cursor. Untimed counts and source diagnostics remain visible. Narrow the range for earlier detail.

Source detail is fetched only after **Verify source detail**, rechecking the export and source authorization. Expired/evicted exports and denied sources show errors; restart explicitly. Successful verification offers the existing Usage session URL with the recorded part key. Usage loads up to 50 pages to locate that part, scrolls to its anchor and labels an unavailable part. This destination is the existing authorized source viewer, outside the overview. For thinking events, Verify source detail rechecks source permissions and reads at most one MiB of current source JSON. Only existing Codex `reasoning.summary` blocks of type `summary_text` can be shown as an authorized summary, capped at 20,000 characters and passed through the existing redactor. Encrypted/redacted reasoning without a summary is labelled hidden. Absent summaries, unsupported formats and oversized rows are labelled unavailable. Before verification the state is explicitly not checked. Raw thinking bodies are never substituted for a summary and nothing is reconstructed. Summary bodies stay out of the overview/export and are cleared on selection or snapshot change.

### Synthetic demo and coordinator browser scenario

Click **Synthetic demo**, or open:

```text
/observatory?demo=1&from=1767225600000&to=1767225620000&cursor=1767225602000&event=call
```

The reproducible fixture is `app/web/src/routes/observatory/demo.ts`. It includes two concurrent sessions with the same persona, active-at-window-start execution, a tool call at +2s with result at +4s, exact ends at +5s/+7s, an idle gap until +12s, resumed execution, human/automation/unknown provenance and thinking availability. It contains no real source data. The synthetic source button deliberately does not link to a nonexistent recorded session.

On a coordinator with loopback networking and a browser:

```bash
cd app
npm run e2e:install -w web
npm run e2e:observatory -w web
```

The Playwright scenario uses Vite and synthetic API responses, no database or production credentials. It requires a visible WebGL canvas, checks cursor restoration after reload, exact execution counts, idle gap, keyboard slider control, call/result cutoff and verified source-part URL. It saves a screenshot to ignored test output. A listed test is not a rendered pass. Separately check browser back/forward, origin filters/shapes, mobile HTML layout, denied detail, reduced-motion preference (use HTML mode), WebGL loss and idle rendering in browser developer tools. Run the dedicated test-database suite and read-only production audit separately; mocked endpoints do not establish RLS or live coverage.

Coordinator validation after the correction rendered both browser scenarios on native Chrome using Apple M1 Max Metal. The 500-node/1,500-edge harness measured p95 scene-update latency 33.8 ms and 60.0 requestAnimationFrame fps, meeting the measured baseline targets. Software SwiftShader results were slower and must not be substituted for native GPU evidence. The 32 MiB accounting cap remains serialized cache accounting, not a measured heap bound. Record device, browser/GPU, exact revision, event/node/edge counts, response bytes, browser memory, seek samples, frame-rate samples and idle frame activity. The display limits and cleanup tests do not prove frame rate, memory use or seek latency.

The coordinator scenario now includes a separate renderer stress harness at `e2e/observatory-benchmark.html`, served only by Vite during development. It uses exactly 500 synthetic nodes and 1,500 edges, ten warmup updates, 40 position-changing seeks and 120 interaction-awake animation-frame intervals. Playwright attaches `synthetic-performance.json` with raw samples, browser/renderer, viewport, p95 seek latency and requestAnimationFrame rate. Assertions enforce p95 below 100 ms and at least 30 fps. Seek samples include synchronous React scene updates plus two animation frames; frame samples measure animation scheduling, not GPU completion. This isolates renderer stress and does not establish production workloads, browser heap usage or full-page replay latency. Run the full scenario on the correction commit and record its SHA, device/GPU and output. Earlier revision evidence cannot satisfy this revision's acceptance gate.

For a native Chrome baseline, set the test-only `OBSERVATORY_CHROME` variable to the installed browser executable before running the existing e2e command. It defaults to Playwright's browser when absent. On macOS the native override requests ANGLE Metal and enables GPU rendering; the measurement records the actual WebGL renderer, so flags alone are not evidence of hardware use. Functional tests can run on software rendering, but the full benchmark's targets are checked against the agreed hardware baseline.

The first nonempty workspace automatically frames its recorded scene even if the page initially opened on an empty cursor. Scrubbing then preserves the camera; Fit active workspace explicitly reframes later activity. Human-attributed input events have their own short amber pulse even when no execution interval exists. Such a pulse is not an active agent or proof that an agent started.

## Observatory 5 projection and rollout

Migration `1756000020800` adds `archive_messages.observatory_projection`. It stores versioned step kinds, stable relative part keys, call identifiers, outcome evidence, bounded explicit file targets and recorded sender metadata. It stores no transcript, argument, summary, thinking or diff bodies. The existing multi-harness step parser builds it during message import, in the import transaction, from the stored redacted source. The replay adapter resolves relative keys against the immutable numeric row ID. Lazy authorized thinking detail continues to read the source only on request.

Updates to raw/role/kind/content_text invalidate the projection in an invoker trigger. Historical rows start NULL. Missing projection in any relevant pre-window/selected/untimed source returns 503 with a backfill instruction, including run-only sessions. No raw-history fallback or silent omission occurs. Source timestamp and sequence updates are read directly rather than cached. All projection reads stay on the source table under its existing authorization and snapshot.

Coordinator commands, on the deployed revision with its normal authorized environment:

```bash
secondbrain archive-steps --observatory --dry-run
secondbrain archive-steps --observatory --apply --batch 100
```

The first command reports visible total/missing counts. Each apply invocation commits at most 100 rows (accepted batch range 1..200), reports changed and remaining coverage, then exits. Repeat it until missing is zero; rerunning is safe. NULL rows form the persistent resume queue, so edits and concurrent imports cannot advance past missing coverage. `SKIP LOCKED` supports concurrent workers, but a zero changed count with nonzero missing means rows may still be locked. Stop/retry rather than claiming completeness. This is bounded by source row count per transaction, not source bytes: a single very large archive row can still make a backfill batch expensive; reduce batch size. There is no daemon or migration-time body expansion.

Coverage groups expose `replay_projection_missing` for the requested range only. This does not certify prior context readiness; the window reader checks all relevant earlier rows too. The CLI audit reports all visible archive rows. Historical completeness and production coverage remain unknown until the coordinator runs them.

The archive read is one set query, followed by one runs query and one usage query regardless of session count. An active-session CTE uses host/source/session identity and EXISTS, without multiplying messages by executions. Separate UNION ALL branches read selected/untimed metadata and prior tool metadata; the raw-byte aggregate touches only selected/untimed rows. Partial indexes cover missing projection and tool context; `(session_id, ts)` covers time selection. All bounds, source refs and immutable export reauthorization remain in force. Run the database fixture and [EXPLAIN audit](audits/observatory-window.sql) on the shipping host; plans and production backfill have not been verified in the sandbox.


Read-only query-plan audit (empty host/session disables that filter):

```bash
psql -X -v from='2025-01-01T00:05:00Z' -v to='2025-01-01T00:05:02Z' \
  -v host='' -v session='' -f docs/audits/observatory-window.sql
```

Supply the observed window when auditing production and retain outputs privately. The script uses the app's three-second query budget, rolls back and performs no backfill writes.
