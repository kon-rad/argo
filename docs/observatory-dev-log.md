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
