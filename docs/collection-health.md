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
Attempts retain at most 1000 entries per stream. Every report also expires at most
1000 globally expired (30-day) attempts, including inactive streams. Run
`secondbrain usage-quarantine cleanup` independently to drain expiry in bounded
1000-row batches when no collectors are reporting. Latest state and unaccepted
quarantine are never expired.

Producers advertise source-time, backlog and quarantine capabilities. `backlogUnit`
is additive and optional on version 1 health; older reporters keep an unknown unit.
The API returns it as `backlog_unit`. The summary displays source observed/imported
times, pending units and rejection/quarantine counts. Measurements are scoped:

- usage-push and server usage-sync count pending **source bytes**, including an
  incomplete tail. Imported time is the latest valid event in the acknowledged
  complete prefix. Whole-file rewrites reconcile before claiming their new prefix.
- Ledger counts pending **records**: queued local rows plus uncaptured source
  lines or Hermes message/counter/call revisions. Imported time comes only from
  acknowledged local records, excluding active quarantine. Provenance metadata
  never changes content hashes, source IDs, token totals or source sequence.
- agents-sync counts pending **records**: Hermes message revisions, calls and
  session counter revisions compared with destination source keys/content. It
  reports each home/profile separately, including no-change ticks. Plugin calls
  retain the existing two-week file window; conversation SQLite has no such cutoff.

JSONL event time comes from source timestamp, ts, observedAt or at fields (and a
Zen message's timestamp), never mtime or import receipt. Hermes uses source message
and session timestamps. Missing timestamps stay null. A pending record with no
source timestamp cannot supply oldestPendingAt. SQLite has no malformed JSON lines;
plugin/source JSONL rejection counts are measured and redacted poison is retained.
A rejected wire prevents its trailing heartbeat from claiming imported freshness.
Delivery is best effort: a network partition leaves local stage logs and an overdue
remote receipt. Health does not certify files outside configured collector paths.

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
exceed the soft budget once. Whole Codex/Zen complete prefixes preserve the
existing wire protocol; there is no 64 MiB source cutoff. Large JSON strings use
an iterative redaction scan. Transport writes at most 64 KiB characters at a time
with backpressure and a hard deadline. These are whole-prefix reads in worker
memory, not constant-memory parsing. Allocation/parser errors fail explicitly and
keep unacknowledged cursors. A 65 MiB complete-record/prefix regression verifies
progress, stable IDs/counters, retry, metadata-only replay and bounded upload.
A common least-recently processed queue gives files across runtimes turns.

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
split rejection retries. Hermes backup/parsing and the entire CLI attempt now run in a supervised child.
The same boundary covers synchronous filesystem walks, JSON parsing, SQLite work,
Postgres import and shutdown in usage-sync and agents-sync. Defaults: usage-sync
180 seconds, agents-sync and ledger run/collect 600 seconds, usage-push 600 seconds.
`--deadline-ms <1..1800000>` overrides the whole-attempt limit. It is separate from
usage-push's existing normal/backfill transport budgets. The parent kills only its
child process group and removes its private temporary directory, including SQLite
snapshots, after exit. Open SQLite/Postgres transactions roll back; completed
idempotent per-file transactions/cursors remain committed. A retry resumes them.

On timeout the parent logs `stage=attempt-end reason=deadline` and runs a separate
best-effort health-only child with a 10-second cap. It reports retry/deadline without
importing new data, replaying quarantine or advancing source cursors. Thus maximum
CLI wall time is the selected worker budget plus up to 10 seconds of reporting and
OS shutdown. If that report cannot reach storage, the previous retry/in-progress
server report or last heartbeat ages offline; local deadline logs remain evidence.
Server attempt sequences come from Postgres, independent of source event time.
The ledger adds a nullable provenance column on a writable run, retaining local
schema version 1 so older bundles remain usable for rollback. Read-only status
opens both the original and extended v1 schema without performing a migration.

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
Usage health response. Quarantine operations use the supported importer:

```sh
secondbrain usage-quarantine list laptop-a
secondbrain usage-quarantine inspect laptop-a <digest>
secondbrain usage-quarantine replay laptop-a <digest>
secondbrain usage-quarantine replay laptop-a <digest> /private/operator/repaired-wire.json
secondbrain usage-quarantine cleanup
```

List/inspect print bounded metadata only, never payloads. Replay submits one retained
wire item, or one operator-repaired wire item, through the same validation,
transactions and idempotent source IDs as normal ingestion. An invalid JSON/source
fragment needs an operator-repaired supported wire item; blind replay retains it.
Only explicit acceptance removes the original quarantine record. A rejection,
timeout, empty input or database error retains it. There is no automatic source
payload expiry. Run these as the root operator with the normal server environment;
do not export retained payloads into shared logs. Ledger HTTP rejection recovery
continues to use `ledger requeue` and its retained local rows.

Observe 24 hours including sleep/offline periods, then canary the next laptop and
server streams. Proposed awake/reachable event-to-import p95 targets are 180 seconds
for laptops, 360 seconds for five-minute server collection, 660 seconds for ten-minute
Hermes collection. Report measured event counts, sample sizes, observed p95 and
exceptions. These are targets, not guarantees established by unit tests. No host
canary or production soak runs in an isolated builder. Roll back only the collector
bundle while keeping sources, cursors, acknowledged state and redaction enabled.

External acceptance still requires migration/API tests on an isolated Postgres with
vector, then the operator canaries and soak. No production process inspection,
network probe or restart is part of the isolated build.
