# Usage launch provenance

Apply migrations through `1756000021000_codex-run-host-replay.sql` before updating producers.
Old transcripts and clients remain readable. The additions preserve raw evidence and
have no destructive down migration. Rollback the producer/reader code while retaining
the schema and original metadata.

## Producer contract v1

A trusted producer sends one envelope before starting a child, then resends the same
envelope with the native session ID as soon as it is available. Each execution gets
its own run ID; multiple executions may bind to the same resumed native session.
The authenticated transport supplies the host. The envelope cannot override it.

```json
{"v":1,"runId":"example-run-1","source":"codex","runtime":"codex","sessionId":null,"entrypoint":"exec","trigger":"cron","channel":"telegram","persona":"guide","personaOrigin":"dispatcher","taskIds":["t_1234abcd"]}
```

All fields are required, with nullable unknown dimensions. `source` and `runtime`
must match the native archive identity. Source/profile aliases cannot cross-match.
`entrypoint` describes the runtime invocation (`cli`, `exec`, `wake`, `run`);
`trigger` describes why it started (`board`, `cron`, `telegram`, `owner`, etc.);
`channel` records the producer's transport separately from the native session channel.
`personaOrigin` names the producer's evidence for the persona. It is not authority
to skip roster validation. The server snapshots known, unknown and absent persona
states and existing card IDs on first ingestion. A later roster or card addition
alone cannot validate previously unknown launch evidence.

Two supported transports carry the envelope:

- Usage SSH wire: one JSONL object `{"t":"launch","launch":<envelope>}` into
  `secondbrain usage-import <registered-host>`.
- Device ledger batches: a row with `kind: "launch"`, a stable key such as
  `codex|example-run-1`, and `data: <envelope>`. The registered device token decides
  the host; retries follow the existing batch acknowledgement protocol.

The engine dispatcher records the envelope transactionally before spawning Codex or
Zen. Codex receives `SB_LAUNCH_V1` and binds its `thread.started` ID while stdout is
streaming, even if the child later fails. Zen carries `launch_v1` in its trace's
`dispatch` metadata; a collector can bind its native ID from that durable meta line
without a final result. Final stdout binding remains a fallback for injected runners.
A producer crash before any native ID is observed leaves a durable unbound launch.
It must be bound using real native evidence; do not infer identity from timestamps.

The same `(host, source, runtime, runId)` accepts a null-to-native session binding
and exact retries. A conflicting envelope or different native ID fails the ingest
transaction. Raw envelopes are retained. These writes create no `usage_runs`,
`org_wakeups` or token calls. Existing dispatcher accounting continues separately.

The private cc-card runner, external bridges, and other dispatchers must implement
this contract themselves. The collector cannot reconstruct an outer trigger from
an arbitrary native transcript. Neither `[Replying to:` fragments nor pasted card
URLs establish launch origin. No private runner code is changed by this engine work.

## Historical replay

`secondbrain usage-backfill --provenance --sessions=101,102` is scoped to at most
500 archive IDs and defaults to dry-run. Add `--apply` to persist associations.
Run it again to verify `changed: 0`. Existing strict host/source/runtime run evidence
and trusted launches are available immediately through `usage_session_tasks`.

The fallback examines only the first non-injected user prompt, never assistant
messages or later mentions. It accepts a leading `Board card <ID>: <title>` heading,
or the compiled persona plus the explicit `# How this run works (cc-card, headless)`
envelope and its board heading. Both the card ID and exact title must exist.
Quoted headings, fenced examples, URLs and ordinary references are insufficient.
This intentionally leaves ambiguous historical sessions unresolved. A title changed
since launch may also require a supported producer replay rather than this fallback.

Each link exposes an evidence ID, provenance, confidence and reason. Missing evidence
returns an explicit unresolved reason in the replay report and session API. The API
returns every verified task for a resumed session, the ordered launch history, and
separate runtime and trigger fields. List and detail use the same query. Persona
filters/facets and by-bot token aggregates share `usage_session_persona`; owner bot
chats do not acquire wakes or enter wake budgets through this attribution.

Recorded dispatcher run identities take precedence over additive launch attribution,
even when the bot is absent from the current roster. Run calls retain their `bot`
accounting surface. Validated native bots also survive an unknown launch candidate.
Configured `channel_persona` remains visible separately from the transport bot and
the roster-validated archive `bot` foreign key; an unrostered recorded persona has
status `unknown`. A launch candidate alone still requires its ingestion-time roster
snapshot. Missing or unknown launch metadata never invents a wake.

Codex host validation happens before card or wake claims. An invalid
`ORG_CODEX_HOST` leaves work ready for a corrected launch, with no child spawned.
After execution, accounting failures leave completed and archived cards terminal.
When the dispatcher runs Codex on another machine, set `ORG_CODEX_HOST` to that
machine's registered Usage host. Laptop imports reconcile an exact native Codex
session ID with a previously recorded run and its trusted launch, then discard
the dispatcher's duplicate token summary when native calls exist. The replay
migration repairs rows recorded before that import path ran. It leaves unbound
launches and ambiguous sessions unlinked rather than assigning a ticket by time
or title.
