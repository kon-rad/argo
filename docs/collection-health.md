# Session collection health

Usage's Session collection summary is independent of Vault sync (Git) and Vault
index. Health is keyed by authenticated host, collector instance, runtime and path.
A fresh stream never hides an overdue stream elsewhere. A quiet conversation can
have a healthy heartbeat; an old replay keeps its source-event timestamps.

`POST /api/ingest/health` uses the existing device bearer token. The server supplies
host from that identity and rejects a host in the payload. SSH import uses the
host argument supplied through the existing authorized SSH importer. It does not
provide device-token identity isolation between users sharing the same SSH login.
Do not grant that login to untrusted collectors. `/api/usage/health` uses the normal
Usage session gate. Both are mounted through the Usage feature manifest.

The version 1 heartbeat contract has collectorInstance, runtime, path, attemptSeq,
collectorVersion, startedAt, endedAt, outcome, observedAt, importedAt, backlog,
oldestPendingAt, rejected, quarantined, reason and capabilities. Dates are ISO
strings. Missing measurements are null. Receipt and last success use server time.
Attempt sequence must strictly increase to update latest status. Repeating the
same attempt does not refresh it. Source timestamps cannot move backwards.
Attempts retain at most 1000 entries per stream and 30 days when it next reports.
Latest state stays available for offline diagnosis. Inactive streams' history is
not globally swept yet. Quarantine has no automatic deletion.

Collectors currently advertise heartbeat capability only. Source-event, imported
source-event and per-path backlog measurements remain null until a producer can
measure them correctly. This is collection liveness, not a completeness guarantee.
Health failure delivery is best effort; a network partition shows an overdue
receipt and local stage logs rather than a remotely delivered network failure.

Private `secondbrain.json` can declare `usage.expectedStreams` (default `[]`):

```json
{"usage":{"expectedStreams":[{"host":"laptop-a","collectorInstance":"installation-id","runtime":"codex","path":"/synthetic/sessions","intervalSec":60,"state":"enabled"}]}}
```

Use the installation's collector ID and actual path. `paused` and `retired` are
explicit owner states. Never-received enabled streams are unknown. Reporting
streams become offline (meaning heartbeat overdue, not proven powered off) after
three configured intervals plus 60 seconds. A fresh failed attempt or measured
backlog is stale. Unregistered reporting streams use 120 seconds and are marked
`expected: false`. No expected hosts are built into the engine.

## Bounds and acknowledgement

The installed usage-push collector reads process environment only and needs no
node_modules or vault env file. Normal collection has a 30 second elapsed budget
and a 20,000,000-byte soft transfer budget, configurable through
`USAGE_PUSH_TICK_MS` and `USAGE_PUSH_MAX_BYTES`. A complete oversized record may
exceed the soft budget once. Reads stop at 64 MiB; larger single records or Codex
complete prefixes stay on disk with unchanged offsets. Their chunking is a
follow-up, not permission to truncate them. Codex preserves complete-prefix
reconciliation of identity and cumulative counters. A common least-recently
processed queue gives old and active files across runtimes turns. Filesystem
walking and synchronous parsers are not preemptible by the elapsed check.

SSH has ConnectTimeout=15, ServerAliveInterval=15, ServerAliveCountMax=3 and an
overall subprocess deadline. `USAGE_PUSH_DEADLINE_MS` defaults to 180000 for normal
ticks; `USAGE_PUSH_BACKFILL_MS` defaults to 600000 for the first attempt. The deadline
includes stdin backpressure and remote shutdown. Deadline and stdin failures kill
only the spawned process group. Collection cursors remain unchanged after failed
acknowledgement. Stage logs contain timestamps, byte counts and classified reasons,
never child stderr, credentials or transcript bodies. Doctor prints a lock PID.
An unexplained lock is retained; only a known dead PID permits automatic recovery.

Version 2 SSH acknowledgement contains `v`, `lines`, `accepted`, `rejected` and
`quarantined` positions. Every position must be accepted or explicitly durably
quarantined before the client saves its next cursors. Malformed source fragments
are redacted and sent as quarantine entries while their original files remain
local. Quarantine is idempotent by host and digest. Valid later items can commit.
A database failure aborts acknowledgement, so replay is required and idempotent.
Legacy clients still receive their human summary; rejected lines now exit 1 to
prevent old exit-2 clients from discarding them. New clients refuse an old server's
human summary or exit 2 and retain cursors. Deploy server schema and reader first.

Ledger status/doctor opens SQLite read-only with a bounded busy timeout, without
write pragmas, migrations or directory creation. It sees committed state during
a collector transaction. Collection and acknowledgement writes stay separate from
network operations. Claude ledger reads rotate across files and stop between files
after 30 seconds or 20 MB. Ledger HTTP sync has a 120 second total budget, including
split rejection retries. Hermes whole-database reads remain a follow-up boundary.

## Diagnose before restarting

Run these on the owning host as an operator, not from an isolated builder:

```sh
node /path/to/ledger.mjs doctor
app/bin/install-usage-push-mac.sh doctor
ps -o pid,ppid,pgid,etime,state,command -p <lock-pid>
lsof /path/to/ledger.db /path/to/ledger.db-wal
log show --last 2h --style compact --predicate 'process == "powerd"'
```

Correlate stage=collect-start/end, stage=sync-start/end, upload-start/end and health
receipt with the lock owner, child SSH/import PID, sleep/wake events and configured
route availability. Do not dump process environments, raw SSH debug output or
transcripts. Inspect the existing configured route without changing it. Do not
kill a live collector, remove an unexplained lock or change schedules to diagnose.
Proxy logs distinguish capture failure from forwarding failure using bounded codes.
A successful forwarded response can coexist with a failed capture.

## Canary, soak and rollback

After server migration and compatible importer deployment, the host operator can
canary one installation with its current paths and token, keeping overlapping
Claude collectors enabled:

```sh
node /path/to/ledger.mjs status
node /path/to/ledger.mjs run
app/bin/install-usage-push-mac.sh doctor
node /path/to/usage-push/cli-usage-push.js
```

Record bundle revisions, collector IDs, acknowledged cursors and the per-stream
Usage health response. Inspect quarantine through an authorized read-only database
session (`SELECT host,digest,reason,received_at FROM usage_import_quarantine`). Do
not print `wire` into shared logs. Recovery after an importer fix requires explicit
operator replay of retained wire/source data; no automatic quarantine reprocessor
is provided yet.

Observe 24 hours including sleep/offline periods, then canary the next laptop and
server streams. Proposed awake/reachable event-to-import p95 targets are 180 seconds
for laptops, 360 seconds for five-minute server collection, 660 seconds for ten-minute
Hermes collection. Report measured event counts, sample sizes, observed p95 and
exceptions. These are targets, not guarantees established by unit tests. No host
canary or production soak runs in an isolated builder. Roll back only the collector
bundle while keeping sources, cursors, acknowledged state and redaction enabled.

Dependencies before claiming the full reliability card: measured per-path source
and import event/backlog metrics; bounded Hermes backup and server sync loops;
large-prefix chunk protocol above 64 MiB; explicit quarantine reprocessing command;
global inactive-attempt cleanup; and the database/API checks and live soak.
