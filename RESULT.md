DONE

## Summary

Closes Engine simplification round 2, item 1: one settings reader, per-section validation, and schema-backed environment reads.

- Added `app/server/src/settings-file.ts` as the only settings path resolver and JSON file loader. It has no `config.ts` import.
- Routed runtime settings, addon discovery, and doctor through that loader. `SECONDBRAIN_SETTINGS` now works for default, absolute, and vault-relative paths, including addon discovery.
- Added `settingsReport()`. Each top-level section validates independently, so an invalid `socialMetrics` section uses its defaults while valid `summaries` settings still load.
- Made doctor fail critically for invalid JSON or schema-invalid settings. Diagnostics include only the settings path, section, field path, and Zod message.
- Moved production env reads behind the Zod-backed `config.env` surface and removed the env-schema exception worklist.
- Updated configuration docs and both env examples.

## Before and after

| Measure | Before | After |
|---|---:|---:|
| Settings file readers/parsers | 3 | 1 shared loader |
| Invalid section blast radius | Whole settings object reset | Invalid section only |
| Cataloged direct `process.env.X` reads outside `config.ts` and tests | 62 in 29 files | 10 lines in 7 bootstrap or standalone files |
| Env schema exception worklist | 49 entries | 0 entries |
| New focused isolated checks | 0 | 18 passing |

The remaining 10 direct reads are intentional and their keys are still in the schema:

- `settings-file.ts`: `SECONDBRAIN_SETTINGS`; the required leaf resolver cannot import `config.ts`.
- `cli-features.ts`: `MODULES`; this manifest bootstrap runs before app config.
- `cli-review.ts` and `review/process.ts`: `REVIEW_DB_URL` and `GH_TOKEN`; the standalone trusted review worker intentionally does not load the vault env or app config.
- `cli-ledger.ts`, `ledger/sync.ts`, and `archive/redact.ts`: `SB_LEDGER_DIR`, `SB_LEDGER_TOKEN`, `REDACT_ENV_FILES`, `XDG_CONFIG_HOME`, and `USER`; the ledger is built as a standalone single-file tool from Node builtins and pure modules.

## Environment keys added to the schema

`SECONDBRAIN_SETTINGS`, `SB_UNIT_DIR`, `SB_ENV_FILE`, `SECONDBRAIN_DB_URL`, `SB_ORG_DB_URL`, `ORG_DB_URL`, `ORG_AGENT`, `ORG_VIA`, `ORG_RUN`, `ORG_ROUTING_JSON`, `ORG_BREAKER`, `ORG_BREAKER_AS`, `PROJECTS_BY`, `PLAN_USAGE_LOG`, `CLAUDE_PROJECTS_DIR`, `CLAUDE_BIN`, `CC_RUNS_DIR`, `SECONDBRAIN_TELEGRAM_DIR`, `USAGE_HOST`, `USAGE_SYNC_HOST`, `USAGE_SYNC_SERVER`, `USAGE_SYNC_TOKEN`, `USAGE_PUSH_HOST`, `USAGE_PUSH_STATE`, `USAGE_PUSH_MAX_BYTES`, `SB_LEDGER_DIR`, `SB_LEDGER_TOKEN`, `BOT_REPOS_FILE`, `HERMES_ENV_FILE`, `REMOTE_HERMES_USER`, `AGENTS_SYNC_HOST`, `REDACT_ENV_FILES`, `B2STORE`, `CREDITS_KEYS_FILE`, `FAL_BILLING_KEY`, `GEMINI_API_KEY`, `BASE_RPC_URL`, `LIVESTREAM_YOUTUBE`, `LIVESTREAM_TWITCH`, `LIVESTREAM_KICK`, `LIVESTREAM_PUBLIC_DIR`, `SUMMARIES_LOCAL_URL`, `XDG_CONFIG_HOME`, `USER`, `NODE_ENV`, `DESK_TEST_DATABASE_URL`, `DESK_PUBLICATION_TEST_DATABASE_URL`.

The legacy `LIVESTREAM_YOUTUBE`, `LIVESTREAM_TWITCH`, and `LIVESTREAM_KICK` values are per-vault choices already represented by `secondbrain.json`. This card kept their existing env-over-settings precedence mechanically as required.

## Verification

- `cd app && npm ci --offline`
  - Added 514 packages.
  - Audited 518 packages.
  - 0 vulnerabilities.
- `cd app && npm run build`
  - Server TypeScript build passed.
  - Web TypeScript and Vite build passed.
  - 784 modules transformed.
- Isolated Vitest config, then `npx vitest run ... settings.test.ts env-schema.test.ts machines.test.ts`
  - 3 test files passed.
  - 18 tests passed.
- Focused doctor checks for schema-invalid and missing settings files
  - 1 test file passed.
  - 2 tests passed, 4 skipped by the name filter.
- `scripts/check-public.sh`
  - Exit 0, no output.
- `git diff origin/main --check`
  - Exit 0.
- Required env grep
  - 10 remaining lines, all listed above with reasons.

## Not verified

`cd app && npx vitest run --project server` could not enter test collection because no PostgreSQL server is available at `/tmp/.s.PGSQL.5432`. The real output was:

```text
psql: error: connection to server on socket "/tmp/.s.PGSQL.5432" failed: No such file or directory
Is the server running locally and accepting connections on that socket?
No test files found, exiting with code 1
```

An isolated PostgreSQL start was attempted under `/private/tmp`, but this managed sandbox rejects PostgreSQL's shared-memory allocation with `shmget: Operation not permitted`. Supertest listener-based tests are also blocked by `listen EPERM`. CI or Vera needs to run the full server project against `SB_TEST_DB=sb_card_70c44306_test`.

## Commits

- `4cead52 fix(settings): share loading and isolate invalid sections`
- `9ee8887 refactor(config): route runtime env through schema`

## Assumptions and follow-ups

- Assumed a schema-invalid settings file must make doctor unhealthy, not merely advisory, because the card says doctor must fail.
- No migration, deploy, web source, zen-agent, or desk behavior beyond desk env reads changed.
- Follow-up only if desired: remove the three legacy livestream env overrides in a separate behavior-change card after migrating users fully to `secondbrain.json`.
