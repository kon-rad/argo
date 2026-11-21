# Recorded tool outcomes and replay

Usage derives Codex and Hermes tool results from recorded result envelopes. Exit code 0 is success; a numeric nonzero exit code is failure. A generic `completed` status alone does not prove success. Explicit `is_error`, `isError`, `success`, outcome/status, cancellation and timeout fields are recognised. Missing or malformed outcome fields stay unknown. Ordinary stdout/stderr is never searched for error words or parsed as an outcome. A successful command can print a failing example.

Across result blocks, failure evidence takes precedence, otherwise any recorded success establishes success. Text-only blocks contribute no outcome evidence, so ordinary text alongside an encoded zero exit stays successful. With no recorded outcome the result stays unknown.

The decoder accepts text blocks, arrays, `output`, `content`, `result`, `structuredContent` and recognised JSON-encoded envelopes, including `metadata.exit_code`. Unknown objects render as JSON. Derived display text is limited to 64 KiB and nesting to 12 decoder levels. The redacted raw record remains available separately. This does not change token parsing or accounting.

Session detail labels unknown tool outcomes and shows their count. Verified success has its own label. The API list/detail headers return `unknown_outcomes`; the existing `errors` count/filter uses derived failure flags. Identical result renderings for the same session and invocation ID are counted once when no recorded tool call intervenes. New invocation IDs, changed results, and retries separated by another recorded call remain distinct. Without an invocation ID, results are preserved independently. Raw archive rows are never deleted.

`run_failures` counts explicitly recorded `usage_runs.is_error` flags independently from tool errors, including an archived session with no tool calls. These runs also match the errors filter. This is a recorded run failure, not proof of an authentication failure. A launch with no archived session or matching lifecycle evidence cannot be reconstructed by this reader.

## Deploy and canary

Apply the additive migration and deploy parser/API support before replaying. `result_parser_version` tracks derived data independently of raw SHA. Live message upserts rederive after a parser-version change, even when the source hash is unchanged. Existing files skipped by a collector still need explicit replay. Parser version 2 rederives version 1 mixed-block results, including previously unknown zero-exit results, even when the raw SHA is unchanged.

Run on the trusted importer host using its usual database configuration. First select one archive session ID and source sequence from the private incident record. Generic examples:

```bash
secondbrain archive-steps --results --runtime codex --session 100 --seq 20 --dry-run
secondbrain archive-steps --results --runtime codex --session 100 --seq 20 --apply
secondbrain archive-steps --results --runtime codex --session 100 --seq 20 --apply
```

Choose exactly one of `--dry-run` and `--apply`. Select either a session (optionally one sequence) or a bounded UTC source-timestamp window. Runtime is mandatory. `hermes` includes its profiles. Batches default to 500 for the replay API and 2000 for the existing archive-steps CLI; `--batch` accepts 1 through 10000.

Before applying, capture message/session IDs, external IDs, sequence, source timestamps, raw SHA, a hash of redacted raw JSON, and session/call token counters. Dry-run prints only scanned, changed, failure, success and unknown counts, never transcript text. It performs no writes. Replay uses the live importer's derivation and redaction, and writes only text, step, tool names, invocation ID, error flag and parser version. It preserves raw, source identity, timestamps and all session/usage rows. A concurrent source-SHA change stops replay rather than overwriting it.

After applying, compare those snapshots exactly and read the session through the Usage list, detail and errors filter. Require readable redacted text and a true error flag for a recorded nonzero canary. If its envelope is unsupported, stop and add a sanitised regression fixture; do not infer failure from prose. The second apply must report `changed: 0`. Counts describe source rows; API display counts deduplicate expanded result renderings.

After the two operator canaries pass, use a bounded runtime/date replay, separately per runtime:

```bash
secondbrain archive-steps --results --runtime codex --from 2026-01-01T00:00:00Z --to 2026-01-02T00:00:00Z --dry-run
secondbrain archive-steps --results --runtime codex --from 2026-01-01T00:00:00Z --to 2026-01-02T00:00:00Z --apply
secondbrain archive-steps --results --runtime hermes --from 2026-01-01T00:00:00Z --to 2026-01-02T00:00:00Z --dry-run
secondbrain archive-steps --results --runtime hermes --from 2026-01-01T00:00:00Z --to 2026-01-02T00:00:00Z --apply
```

Use the selected incident window, not the example dates. NULL source timestamps require a session scope. Roll back the reader/parser release if necessary, retain the additive schema and raw archive, and deliberately rebuild derived fields with the selected parser version. Never delete historical transcripts or change tokens to repair error counts.

## Isolated verification

```bash
cd app
npm test -- --config vitest.usage-unit.config.ts
SB_TEST_DB=sb_tool_results_test npm test -- server/test/agent-sessions-api.test.ts server/test/archive-store.test.ts
npm run build
```

The database suite rebuilds only the named scratch database. Production canary readback is a separate trusted-operator check. See [architecture](architecture.md) and the [module guide](modules.md).
