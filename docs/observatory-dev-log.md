# Observatory 1 development log

## 2026-11-17

Added an optional API-only addon for coverage, evidence windows and source detail pointers. Shared replay uses recorded intervals and source provenance, restores boundary state, preserves concurrent/resumed identities and idle gaps, and excludes unknown execution ends. Archive step expansion supplies tool occurrences; usage measurements do not create tools. Prompt human origin and historical completeness remain unknown without evidence. Thinking is availability only. No LLM processing or production access was used.

The schema audit inspected migration definitions: archive sessions are unique by source/host/external ID; messages by session/external ID; usage runs by host/run ID; calls by source/host/call ID. Those keys explain why a session-to-runs-to-calls join would multiply activity. The adapter uses independent bounded source reads and source-qualified archive lookups instead. Two migrated-database tests exercise join counts and the prior-card query, but could not run here.

Before implementation the fixture suite could not load the missing replay/adapter modules. Final database-free verification reports `Test Files 1 passed (1)` and `Tests 17 passed (17)`. The checks cover exact start/end visibility, active-at-start snapshots, concurrent and resumed sessions, idle gaps, reverse seek, duplicate/late input, reused and ambiguous tool IDs, untimed and inverted results, no future result/card leakage, same-time part ordering, thinking availability, immutable pagination, expiry/eviction, disabled modules, source-detail denial and request bounds.

`cd app && npm run build` passed, with the existing Vite warning about chunks larger than 500 kB. `cd app && npm test -- --project web` reports `Test Files 33 passed (33)` and `Tests 249 passed (249)`. `scripts/check-public.sh` exited 0 with no output after preserving generated web bundles outside the source tree; the initial scan of those bundles flagged a third-party minified numeric literal as IPv4. `git diff --check` passed.

Required full-suite checks remain blocked by this environment:

- `cd app && npm test`: global setup could not connect to the disposable test database, reporting `Operation not permitted`; no server tests ran. Actual PostgreSQL SQL syntax, RLS, cardinalities and query plans remain unverified.
- `python3 -m pytest harness tools addons`: `No module named pytest`.
- `cd zen-agent && npm ci --offline && npm test`: dependencies installed and TypeScript compiled; 95 tests, 80 passed, 15 failed. Fourteen failures reported `listen EPERM: operation not permitted 127.0.0.1`; one cleanup failure then reported `Cannot read properties of undefined (reading 'close')`.

The [API contract](observatory.md) and [read-only production audit](audits/observatory.sql) describe limits and the next verification. No browser scene, live liveness collector, production audit, production completeness claim or deployment is included. The vault is read-only in this run, so this engine log and the runner result are the handoff; a coordinator must reconcile private tracker/dev-log records. Builder completion requires review after the blocked checks pass.


## 2026-11-18 verification repair

The coordinator reran verification directly on the M1 host, using only the dedicated scratch database. CI had exposed a fixture error hidden by the worker sandbox: `archive_sessions.harness` is generated and cannot be inserted. The fixture now lets PostgreSQL derive it from `source`, registers and cleans up its synthetic usage host, and includes the `harness: codex` marker written by the real Codex archive importer. Both migrated-database tests pass, including join cardinalities and the historical board boundary query.

Host checks also resolve the worker environment failures: zen-agent reports 94 passed, 0 failed; an isolated `uv run --with pytest python -m pytest harness tools addons` reports 179 passed and 5 skipped. The engine build passes. Source leak scanning passes with zero output after preserving generated browser bundles outside the source tree; scanning those minified bundles alone triggers the existing third-party numeric-literal false positive. No sandbox policy, production data or deployed configuration was changed. Full app-suite results are recorded in the PR handoff.

## 2026-11-18 Observatory 2 workspace, card t_2693489d

Added optional `/observatory` navigation and a lazy, pinned Three.js/3d-force-graph workspace over slice 1 exports. Deterministic positions, active-only execution markers, independent concurrent runs, exact edge removal, timeline seek/reverse/event stepping, URL filters/cursor, source provenance glyphs, accessible HTML lists/inspector and Usage session links use recorded evidence. Structured file paths are bounded operation attempts; shell text and transcript bodies never enter the overview. Source detail remains lazy and authorized. Live history refresh explicitly cannot establish live process activity. Thinking remains availability-only. No LLM processing, production access, external publication or deployment occurred.

The new adapter regression failed before implementation with `1 failed | 17 passed (18)` and passes afterward with `18 passed (18)`. Workspace tests initially failed to resolve the missing model module. Final web verification reports `Test Files 36 passed (36)` and `Tests 262 passed (262)`, including 12 Observatory tests and one Usage entry/part-anchor check. These cover URL restoration, provenance, disappearance/edges/idle gaps, future result cutoff, immutable complete pagination, denied/lazy detail, recorded source navigation and renderer idle/unmount behavior through a mocked graph. The mock does not prove WebGL rendering or GPU cleanup on hardware.

`cd app && npm run build` passes, including shared/server/web TypeScript and Vite, with the existing >500 kB chunk warning. Exact renderer dependencies are pinned to Three.js 0.186.1 and 3d-force-graph 1.80.1. `scripts/check-public.sh` passes with zero output after retaining generated Vite bundles under ignored dependency/build evidence. The initial scan of generated bundles matched an upstream minified numeric literal as IPv4. `git diff --check` passes. Playwright lists one coordinator scenario; it has not been rendered in this sandbox. Reproduction, fixture URL, coverage limits and measurement protocol are in [Observatory](observatory.md).

Remaining verification needs coordinator capabilities:

- `cd app && SB_TEST_DB=sb_card_2693489d_test npm test` was refused during global setup: PostgreSQL connections on loopback port 5433 report `Operation not permitted`. No server/database tests ran. The dedicated scratch database must be used on relaunch; no shared/production database was accessed.
- `python3 -m pytest harness tools addons` and the system Python variant report `No module named pytest`. Offline uv fallback was refused creating its cache lock outside the workspace.
- `cd zen-agent && npm ci --offline --ignore-scripts && npm test` installed 88 packages with zero vulnerabilities and built TypeScript, then reported 95 tests, 80 passed and 15 failed. Fourteen failures report loopback `listen EPERM`; the remaining cleanup failure follows failed server initialization. This runtime was not changed.
- Rendered browser acceptance needs `cd app && npm run e2e:observatory -w web` on the coordinator. The synthetic scenario checks real canvas presence, exact boundaries, restoration, keyboard seeking, cutoff and source-part links. Performance targets (500 nodes, 1,500 edges, 32 MiB cache, p95 seek <100 ms, 30 fps) remain unmeasured. Cache accounting and display caps are enforced but are not measured heap/frame-rate claims.

Assumptions: this card is the implementation unit; no matching problem-catalog row was found and the private catalog stays untouched. Slice 1 remains authoritative for permissions, lifecycle and unknown historical coverage. The private vault is read-only, so this engine log and runner RESULT.md are the review handoff. Browser, scratch-database, loopback runtime checks, pytest and a separate live coverage audit remain follow-ups before approval/shipping through the registered review gate.

## 2026-11-20 coordinator verification and integration

Merged current protected main into the workspace branch, preserving both Observatory links and the newer Usage controls. The integrated build passes; 41 web test files and 300 tests pass. The actual Chromium replay scenario passed in 8.1 seconds on the coordinator, including a visible canvas, concurrent markers, exact end/idle gaps, reverse/reload/keyboard state, lazy source detail and recorded-part navigation. This supersedes the earlier statement that browser acceptance had only been listed. Native WebGL context-loss inspection then found the canvas could obscure HTML fallback; the host is now hidden on failure, with a regression test.

The native production-preview benchmark used Google Chrome 1440x1100 and confirmed ANGLE Metal on Apple M1 Max: 40 synthetic DOM-update seeks, p50 3.5 ms, p95 10.4 ms, maximum 11.3 ms. An explicit synthetic 500-node/1,500-edge fixture recorded 59.86 requestAnimationFrame fps and p95 frame interval 16.7 ms. These are fixture/browser measurements, not production workload, GPU completion or a guarantee for every device.

Software rendering was materially slower and remains a documented limit: Headless Chrome 159 reported ANGLE SwiftShader; production-preview seek p95 was 125.3 ms, and the same synthetic stress shape recorded 15.21 requestAnimationFrame fps. Development-server measurements were slower again (p95 427.1 ms and 8.88 fps). The proposed targets are met on the measured native Metal setup, not on SwiftShader.

Host zen-agent checks report 94 passed. Isolated Python checks report 278 passed and 2 skipped. Pre-integration app tests had three unrelated route/response failures; fresh CI at a6dfd36 passed every required check after integration. Corrections for the independent review findings still require renewed exact-head CI and rendered checks before acceptance. No author approval, merge or deployment is claimed by this log.

## Review 109 correction

Card: `t_2693489d`. Source-only correction in the isolated engine worktree.

- Human provenance now has a real recorded path: org message insertion snapshots sender kind without backfilling history. Archive adapters accept explicit recorded sender metadata, never roles or channel labels. Fixture exports exercise human, agent and unknown, including HTML origin filtering.
- Ticket/persona/model filters retain historical events after execution end. Active markers and attached edges still disappear at the exact half-open end. Immutable window indexes, direct association maps and a single through-cursor pass remove repeated sorts and nested scans.
- Usage links use recorded session and loaded-step times, including activity after the first hour. No time anchor produces an explicit unknown state; sessions longer than one day open the latest bounded day.
- Lazy thinking detail displays only existing authorized Codex summary_text blocks after permission checks, bounded and redacted. Hidden and unavailable have distinct labels. Overview responses still contain no summary bodies.
- Renderer shares shape resources, retains surviving data-object identity and meshes, skips identical scenes, uses pixel ratio 1 and disables antialiasing. Idle/unmount cleanup remains covered. These changes reduce work but do not prove the performance target.
- Regression baseline: new adapter tests failed 2 cases (18 passed); historical-filter tests failed 3 cases (5 passed) before fixes. Final fixture and web totals are recorded in the runner RESULT.md.

Remaining coordinator evidence is required. This sandbox cannot connect to PostgreSQL or serve a browser. The exact attempted app check was `cd app && SB_TEST_DB=sb_card_2693489d_test npm test`, refused with `Operation not permitted` on localhost port 5433. The new forward migration and insertion-time provenance integration fixture have not executed here. Python pytest is absent. Zen-agent's 16 loopback-listener tests fail with EPERM; 156 tests pass. Run these checks with the required capabilities before approval.

The browser scenario now contains a deterministic 500-node/1,500-edge renderer benchmark with raw JSON samples and explicit 100 ms/30 fps gates. Listing the two Playwright tests is not execution evidence. Review 109 reports earlier synthetic measurements of p95 seek 427.1 ms and 8.88 fps; those remain a reported baseline, not measurements of this correction. No current rendered pass, new performance number, production audit or completeness claim is available. The coordinator must execute acceptance and benchmark on this correction's exact commit and attach the revision and device/browser/GPU evidence.

Local correction verification: `cd app && npm run build` exits 0, with the existing bundle-size warning; `cd app && npx vitest run --project web` reports `41 passed` files and `313 passed` tests; the database-free Observatory config reports `21 passed` tests. `npm run e2e:observatory -w web -- --list` lists two scenarios without rendering. `git diff --check` passes. The public leak script passes with exit 0 over all tracked and new nonignored source files. A whole-directory scan also traversed ignored build/cache artifacts and flagged bundled Three.js and pytest cache data, so it is not reported as a clean whole-directory scan.

## Observatory 5: bounded archive windows

Card `t_07c1c871` adds a rebuildable content-free archive projection through the importer and bounded resumable `archive-steps --observatory` batches. Replay selects window metadata and prior tool context, retaining occurrence pairing and exact boundary provenance without fetching narrative prefixes. Selected raw bytes still have a 4 MiB guard. Missing relevant projection fails 503. See [rollout and limits](observatory.md#observatory-5-projection-and-rollout).

The synthetic database regression has a prefix over 8 MiB and asserts two transferred metadata rows, three source queries, cross-boundary pairing, invalidation, backfill idempotency and a real oversized selected source returning 413. The sandbox refused PostgreSQL connections, so this fixture, migration and EXPLAIN are pending coordinator verification. Database-free adapters, authorization and immutable pagination are checked separately; these do not establish production coverage.
