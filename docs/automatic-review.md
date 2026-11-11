# Automatic contextual review and shipping

This owner-managed board feature is **disabled by default**. The migration inserts a disabled policy. No timer is installed automatically. It implements catalog card `t_420cc80c`: builder completion becomes submission, and only reviewed, merged, deployed and healthy work becomes done.

`finish --done`, a coding card's direct `move done`, and a runner's `move review` all enqueue the same durable database job. The database trigger changes the requested status to review in the same transaction. An archive request cannot release dependencies around the gate. Non-code cards and disabled installations retain their previous behavior. Already submitted work remains gated when policy is disabled. Disabling pauses the worker; it does not accept work.

The database marks in-scope code work persistently, so later self-assignment or classification changes cannot escape review. Assignment remains possible before submission; after submission, the original builder, repository and classification are retained. Historical completed cards are not resubmitted by metadata edits. Explicit review-only cards in existing work graphs are not recursively submitted to code review; persistent enforcement still prevents a builder from converting an already in-scope build into an escape route. Rejection posts findings to the PR, then atomically records a ticket comment, increments the round, returns the original card to ready and wakes the original builder. Ready is required by existing lane claim semantics. Resubmission creates another durable round and retains the previous PR binding. Escalation never approves work.

## Local fixture

From `app/`:

```sh
npm ci
npm run build
node server/dist/cli-review.js fixture
npx vitest run --config vitest.review.config.ts
```

The fixture runs both rejection and exact-head merge, deployment and health paths using adapters with no production writes, network or credentials. The unit suite also executes the concrete target bridge against temporary local programs, tests uncertain-effect reconciliation, context exclusions, full verdict parsing and Git push arguments.

Real SQL tests use the normal application test harness. Use a new PostgreSQL cluster with pgvector and an isolated database, never a production endpoint or a retired local database:

```sh
PGHOST=/tmp/review-test-socket PGPORT=55432 SB_TEST_DB=sb_review_gate_test npm test -- --project server review-db.test.ts board.test.ts
```

The harness rebuilds only that test database. It requires a PostgreSQL role able to create test roles. SQL authorization is verified only when this command actually passes against PostgreSQL, not by inspecting migration text.

## Owner setup

Apply migrations using the normal owner-controlled migration process. The migration creates the group role `sb_review_worker` if absent. On a host where the migration role cannot create roles, the database owner must create that NOLOGIN role first. Do not grant it to `sb_org`, a builder login, or a shared application login.

Create a dedicated LOGIN with a private authentication mechanism, grant it `sb_review_worker`, and register that exact login and the roster's reviewer. These are owner-only SQL writes:

```sql
CREATE ROLE review_service LOGIN;
GRANT sb_review_worker TO review_service;
UPDATE review_policy SET reviewer='auditor', worker_login='review_service', enabled=false, corrections_enabled=false, shipping_enabled=false;
```

The reviewer must be an independent roster agent. The worker verifies its configured identity against the structured verdict. Database functions authorize the actual `session_user` and role membership, not the caller's `org.agent` setting. Builders have no grants on review state, attempts, policy or decisions. The legacy `ship check` refuses gated cards even if they have a ship-now approval. Other approvals keep their existing rules.

Create an owner-owned host policy file, mode 0600. All paths and identities are host configuration, never PR or model output:

```json
{
  "repositories": {
    "engine": {
      "github": "example/engine",
      "gitDir": "/srv/review/engine.git",
      "base": "main",
      "target": "application",
      "checks": ["tests", "build"],
      "notes": ["Projects/example/design.md"]
    }
  },
  "targets": {
    "application": {
      "argv": ["/usr/bin/node", "/srv/engine/app/server/dist/review/target.js", "/etc/secondbrain/review-target.json"],
      "cwd": "/srv/review"
    }
  },
  "notesRoot": "/srv/vault",
  "exclude": ["CURRENT", "Areas/Finance", "private"],
  "evidenceRoot": "/srv/review/evidence",
  "home": "/srv/review/service-home",
  "gh": "/usr/bin/gh",
  "git": "/usr/bin/git",
  "reviewer": {
    "argv": ["/usr/local/bin/isolated-codex-reviewer"],
    "model": "configured-subscription-model",
    "home": "/srv/review/reviewer-home",
    "cwd": "/srv/review/empty"
  }
}
```

Use a dedicated, trusted bare repository (`git init --bare /srv/review/engine.git`). Do not point `gitDir` at a builder-controlled repository or allow builders to modify host policy, target programs, the worker executable, its HOME or its state directory. Give only the trusted orchestrator GitHub write access. `GH_TOKEN` is passed only to git/GitHub children. The worker supplies an ephemeral GitHub authentication header to its Git subprocesses. Global and system Git configuration and repository hooks are disabled by the adapter.

Run the review model outside the trusted worker account. A fixed transport may forward only bounded prompt text and the verdict schema to a subscription-authenticated model on another host. It must provide an empty working directory, disable shell, unified execution, subagents and web search, ignore user configuration, and expose no MCP or shipping tools. It must support `login status` and the schema-bound `exec` protocol. Never send the worker HOME, environment, credentials or configurable commands to that endpoint. The adapter strips ambient environment variables, requests read-only sandboxing, disables the shell tool, ignores user configuration, selects the exact configured model, uses the JSON output schema and parses the **full** final message. The 600-character dispatcher display text is never a verdict. A read-only filesystem sandbox alone does not establish credential isolation. Verify the fixed endpoint and a real no-tool review before enabling shipping. The engine does not provision accounts or subscription authentication.

## Runner handoff and evidence

Before submitting, the runner must create or retain a single same-repository PR whose body or branch includes the full card id. The worker discovers it through GitHub and fails closed on unknown or ambiguous PRs. Fork PRs are unsupported and blocked. The existing runner's `move review` is the handoff; it needs no shipping power.

The owner host integration must stage immutable, scrubbed builder evidence at:

```text
<evidenceRoot>/<card-id>/RESULT.md
<evidenceRoot>/<card-id>/run.log
```

Both files are essential. Freeze them before handoff, keep them inaccessible to later builder processes, and replace them only for a new submission round. No runner-supplied absolute path is followed. A nonempty ticket body and explicit acceptance checks are essential; checks may be in a structured completion contract or a Done when, Acceptance or Verify section of the body. The worker collects comments, dependencies, task-linked org conversation threads, run metadata, previous verdicts, project and feature metadata, registered design notes, PR metadata, the patch and current CI checks. Ticket wikilinks resolve only to registered notes or unambiguous Markdown beneath owner-selected noteRoots; unavailable or ambiguous links block. Conversation links use `org-thread:<id>` and must belong to the card's task-linked threads; inaccessible or unrelated threads block. Empty comments, conversations or dependency collections are explicit, valid evidence of absence.

Files are restricted to explicit registered notes within `notesRoot`. Dot paths, credential names, key files, path traversal, escaping symlinks and owner exclusions are denied. Secret-like literals are redacted before model access. The source explicitly records redaction, so the reviewer can distinguish missing semantic context from a clearly labeled test fixture without seeing secret values. PRs touching excluded secret files block before diff collection. Sources carry content hashes and provenance. Individual sources, collection counts, total context and subprocess output are bounded. Essential truncation blocks review; it is never treated as a pass. PR text and logs are untrusted evidence and cannot select commands, URLs or authority.

Model review does not lock chat or project edits. The worker acquires its per-card advisory content lock only for shipping, then re-reads all approval evidence; changed evidence invalidates approval. Database evidence writers contend on that lock during shipping. The worker checks evidence again before merging and final completion. Host evidence files must be immutable while that lock is held; the database cannot lock filesystem files. A late evidence change keeps the actual merge/deployment receipts and blocks completion for owner reconciliation.

## Worker service

Give only the worker service `REVIEW_DB_URL`, using its dedicated login. This standalone CLI intentionally does not load the application's vault `.env`. Supply host policy explicitly:

```sh
node /srv/engine/app/server/dist/cli-review.js tick /etc/secondbrain/review-host.json
```

Run one tick periodically using an owner-installed supervisor or timer. Each tick processes at most one job. Queued work takes priority, oldest retries rotate fairly, and blocked jobs wait at least five minutes before retry. After max_rounds correction runs (default two), repeated rejection blocks for escalation and never implies acceptance. Multiple workers use PostgreSQL session advisory locks for the job, evidence and target. Durable checkpoints and append-only attempts survive worker crashes. Loss of the lock connection terminates the worker. The target bridge independently serializes real effects. Inspect `review_jobs`, `review_attempts` and ticket `review-blocked` events for errors and actual merged/deployed revisions. No model-supplied command or URL reaches a shipping adapter.

On acceptance, all named CI checks must have successful evidence for the current PR head. The adapter uses GitHub's normal PR merge operation with `--match-head-commit`. It requires server-side strict status checks covering the registered checks and disabled force pushes. A worker authenticated as an administrator also requires administrator enforcement; a non-administrator worker can use protected checks while the owner's existing publishing flow retains its own authority. Normal GitHub merging is not an exact base-SHA compare-and-swap in every ancestry case. The worker durably records the actual merge, then separately verifies its first parent against the reviewed base and its second parent against the reviewed head before allowing deployment. A differing base blocks deployment for reconciliation while preserving the actual merge receipt. An uncertain response is reconciled by the PR's confirmed merge receipt. Every resumed deployment revalidates approval evidence and confirms merge parents before any external write; stale unmerged approvals are cleared before readiness checks so fresh head-bound evidence can be staged. It never force-pushes, bypasses branch rules or deletes a source branch. Draft PRs, unresolved review threads, active changes-requested reviews and failed required checks produce actionable rejections. Pending checks wait for retry.

A retry verifies merge parents and recovers a previously successful push before attempting anything else. A changed PR head invalidates approval. Review authorization binds repository, PR, base, head, ticket/source revisions, independent reviewer and target. Health must attest the exact merge commit, not the pre-merge head or a generic HTTP 200.

## Registered target bridge

The included `review/target.js` bridge accepts an owner-owned JSON configuration:

```json
{
  "stateDir": "/srv/review/target-state/application",
  "cwd": "/srv/review",
  "home": "/srv/review/target-home",
  "deployArgv": ["/usr/local/libexec/deploy-registered-app"],
  "healthArgv": ["/usr/local/libexec/health-registered-app"]
}
```

Both programs receive only `revision` and numeric `idempotency-key` appended to their fixed argv. The deploy program must apply that exact revision. The health program must print strict JSON `{"revision":"<40 hex characters>","healthy":true}` only after verifying the running release and health. Scripts and their destinations are owner-installed. A target receives no ambient database, API or GitHub credentials; credentials it needs must be isolated behind its registered program or service account.

The bridge writes an in-flight barrier before running deployment, serializes the target with a filesystem lock and records per-key receipts. A repeat key checks health and never runs deployment again. An unresolved prior effect blocks every different key. Nonzero exits, timeout, malformed receipts, health failure and wrong revision remain open. No automatic replay follows an ambiguous result. After a host crash, the owner must confirm no deployment child remains, remove the stale lock directory, then retry the same job to reconcile exact-revision health. Do not delete the in-flight barrier to skip reconciliation. Run the bridge on a single registered host per target with persistent local storage. Cross-host filesystem lock recovery and remote target provisioning are outside this bridge's contract.

## Rollout

Keep policy disabled until the real PostgreSQL completion and authorization tests pass, inspect the host adapters and worker isolation, then verify a non-shipping queue and rejection round trip. Enable only after required checks, normal PR merge permissions and strict branch checks, immutable runner evidence, registered target programs and exact-revision health are verified:

```sql
-- First: a smoke board, registered repos only, and no shipping.
UPDATE review_policy SET enabled=true, boards=ARRAY['review-smoke'], repositories=ARRAY['engine'], shipping_enabled=false;
-- Only after the queue/rejection and target receipt smoke passes:
UPDATE review_policy SET boards=NULL, shipping_enabled=true;
```

No deployment or production configuration is performed by the implementation card. A passing local fixture does not establish live shipping readiness.

## Immutable host handoff

The trusted host sends bounded JSON on stdin to `cli-review stage /absolute/owner-policy.json`:

```json
{"card":"t_123abc","head":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","result":"Actual completion evidence","log":"Execution index with the full log hash and explicit omissions"}
```

The importer uses the same per-card content lock, stamps both sources with the actual builder revision, sanitizes secret literals and atomically writes private files. It accepts identical retries and refuses replacement after review or merge. The worker requires both stamps to match the PR head. `cli-review retries /absolute/owner-policy.json` preserves the legacy ready-card interface while correction queues are disabled. Worker subprocess errors are kept in the private `review-adapters.log` beneath its configured HOME; board errors contain no raw stderr or credentials.

### Typed feedback and the optional correction queue

`corrections_enabled` is independently disabled by default. When it is false, rejection keeps the existing ready transition and wake. When it is true, `review_save` stores immutable revision-bound feedback, preserves the original assignee, increments the existing bounded correction round once, and creates one correction item in the same transaction. Each feedback ID includes a deterministic digest of the complete normalized finding, so exact replay is idempotent while different locations, evidence, fixes, or verification remain distinct. Scope/context capacity failures and terminal failed CI use the same finding fields as reviewer findings. A capacity rejection explicitly records that full model review did not run. Missing or pending CI waits. Missing essential or private-excluded context, unknown identity, exhausted rounds, authentication uncertainty, and uncertain merge/deploy effects block instead of being treated as code fixes.

Before the first submission, a trusted coordinator registers the original launch by sending strict JSON on stdin. Values below are generic examples; paths and identities are owner configuration:

```sh
node server/dist/cli-review.js register /etc/secondbrain/review-host.json <<'JSON'
{"card":"t_123abc","builder":"builder","persona":"engineer","runtime":"codex","model":"example-model","host":"worker-a","repo":"engine","branch":"card/t_123abc-fix","worktree":"/srv/worktrees/t_123abc","commonDir":"/srv/git/engine","originalRunId":"run-original","stage":"build"}
JSON
```

Only the dedicated review worker login can register or consume launches. Registration is immutable and must match the card's trusted assignee. `stage` is optional for compatibility and, when supplied, is one of `plan`, `build`, or `correction`.

The host loop uses the same owner-owned policy file:

```sh
node server/dist/cli-review.js claim  /etc/secondbrain/review-host.json worker-a
node server/dist/cli-review.js prepare /etc/secondbrain/review-host.json < prepare.json
node server/dist/cli-review.js ack    /etc/secondbrain/review-host.json < acknowledgement.json
node server/dist/cli-review.js retry  /etc/secondbrain/review-host.json < retry.json
node server/dist/cli-review.js finish /etc/secondbrain/review-host.json < finish.json
node server/dist/cli-review.js cancel /etc/secondbrain/review-host.json < cancel.json
node server/dist/cli-review.js status /etc/secondbrain/review-host.json
```

`claim` leases one item with `FOR UPDATE SKIP LOCKED` and a fencing token. It does not move the card to running. Before any process spawn, `prepare` reserves the real unique run ID and marks the lease `starting`; only then may the host launch it. `ack` binds that run ID to the real process ID, revalidates the live PR/card/base/head, and moves the card to running. Repeated prepare, acknowledgement, finish, and poll calls are idempotent.

An expired plain `claimed` lease is a protocol-proven no-start and is returned to bounded transient retry without spending a code round. An expired `starting` lease may already have spawned, so it blocks for owner reconciliation and is never launched again automatically. `retry` is only for a claimed item that has not been prepared, records bounded host/offline backoff separately, and does not increment code rounds. `finish` returns the same card through the existing review submission gate. Cancellation closes only its bound run and compare-and-set blocks the card only while that rejected review is still current; a newer submission or accepted/completed card cannot regress. Closed, cancelled, or changed-head work is cancelled before acknowledgement. Merge, deployment, and exact-revision health receipts remain immutable review-job history.

Enable only after a scratch-database round trip and a real non-shipping host canary:

```sql
UPDATE review_policy SET corrections_enabled=true WHERE singleton;
```

Rollback is `UPDATE review_policy SET corrections_enabled=false WHERE singleton;`. It prevents new correction items and returns later rejections to the legacy wake path. It deliberately retains feedback, queued items, attempts, and shipping receipts. This engine does not install a timer or private host launcher, and unit/database tests do not prove scheduled repair.

### Stable context and historical shipping receipts

Approval fingerprints normalize snapshots through the strict schema, so PostgreSQL JSONB key ordering does not invalidate equivalent evidence. For exact board project/feature sources only, unredacted top-level `updated_at` and `updated_by` audit stamps do not change the fingerprint. Raw sources remain in the audit snapshot; title, owner, stage and every other content field stay significant. Redacted or malformed sources keep their original revisions and conservative invalidation behavior.

Completion attests that the accepted merge was deployed and passed exact-revision health, not that it is still the currently active release. If final bookkeeping fails after both matching deployment and health receipts were durably recorded, a retry revalidates accepted context and merge identity and completes without replaying those effects. Missing or mismatched health receipts still require a successful live check. A newer release does not erase an older release's verified history.

Behind or conflicting open PRs are readiness rejections, not endless tool-error retries. Findings instruct the original builder to update the same branch and rerun checks. These flags are false for merged PRs; legacy snapshots normalize absent flags to false. A branch falling behind invalidates a paused approval before merge.

## Scope checkpoints before building and submitting

The public `review scope` contract implements catalog card `t_45a48733`. A coordinator can use it before launching a builder and after committing the complete intended change. It shares file selection, immediate import resolution and capacity evaluation with the review adapter. It does not launch agents, execute plan commands, register jobs, grant approval or install anything.

After `cd app && npm ci && npm run build`, these commands work in a standalone checkout:

```sh
node server/dist/cli-review.js scope policy
node server/dist/cli-review.js scope schema
node server/dist/cli-review.js scope forecast /tmp/request.json /tmp/owner-scope.json
node server/dist/cli-review.js scope actual /tmp/request.json /tmp/owner-scope.json
```

When the board module is enabled, `secondbrain review scope ...` reaches the same entry point. With `MODULES` empty or board off, that launcher command is unavailable and no board routes, navigation or timers are enabled. The direct Node commands remain available offline without a database, host policy, GitHub credentials or vault settings. They read explicit JSON and local Git objects only, with hooks, external diff/text conversion, inherited Git configuration and filesystem monitoring disabled. They never fetch, check out a revision or write repository files.

Copy [review-scope.example.json](https://github.com/kon-rad/argo/blob/main/app/deploy/review-scope.example.json) to an owner-controlled location. Omit the optional config argument to use `{"softTarget":24,"exclude":[]}`. `exclude` is an owner-maintained list of repository-relative private path prefixes, shared with the host review policy's exclusions. The coordinator must supply the same exclusions at both checkpoints and to the registered reviewer. Keep this configuration outside planner control. Only `softTarget` (1 through 30) and `exclude` are configurable; plans cannot supply hard caps or override policy. Scope config is separate from application environment settings and the privileged worker host policy.

Hard defaults remain 100 changed files, 30 changed reviewable files, 80 gathered code sources including immediate local imports, 80,000 characters per source, 250,000 diff characters and 500,000 combined evidence characters. Equality passes. Forecasts also use the default soft target of 24 changed reviewable files, leaving six files below the reviewer hard limit. Tests, docs, fixtures, configuration and deletions count by the existing reviewer extension rules. A rename counts once under its destination; both paths are validated. Lock files and binary files count toward 100 and contribute to diff size, but are not selected as code sources. Imports are deduplicated, resolved against tracked head paths, and collected one level from changed head sources. Deletions use base contents without collecting their imports.

Live review and actual preflight both measure the final aggregate with `git diff --no-ext-diff --no-textconv --binary <base> <head> --` against full commit IDs. The live adapter fetches those immutable objects into its trusted repository, validates changed paths before reading the diff, and rechecks the PR base/head after source collection. Revision drift blocks collection for a fresh attempt. Correction commits do not multiply the diff input: interim lines that were reverted or removed are absent from the final aggregate. Commit-series `gh pr diff --patch` is not used. Earlier reviewer findings, card comments, PR review threads and exact-revision changed sources/imports remain review evidence. Full-history gitleaks and all required CI, merge, deployment and health checks still apply.

`scope policy` returns the policy version, SHA-256 policy hash, hard/default limits and default scope configuration. `scope schema` returns the authoritative JSON Schema for the strict version 1 plan. Pin both version and hash; regenerate a plan when policy changes. Request JSON has this envelope:

```json
{
  "repository": "/srv/engine",
  "base": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "head": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "contextSources": [{"ref":"ticket-and-evidence","chars":2000}],
  "plan": {
    "version": 1,
    "policyHash": "COPY_FROM_SCOPE_POLICY",
    "card": "example-task",
    "repository": "example/engine",
    "base": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "requirements": [{"id":"r1","description":"A testable acceptance requirement","tasks":["t1"],"tests":["check"]}],
    "tasks": [{"id":"t1","requirements":["r1"],"paths":["src/example.ts","test/example.test.ts"],"tests":["check"],"dependencies":[]}],
    "tests": [{"id":"check","requirements":["r1"],"paths":["test/example.test.ts"],"command":"npm test"}],
    "dependencies": [],
    "files": [
      {"path":"src/example.ts","status":"modified","sourceChars":3000,"imports":[]},
      {"path":"test/example.test.ts","status":"added","sourceChars":2000,"imports":[]}
    ],
    "diffChars": 5000,
    "otherContextChars": 2000,
    "contextSources": [{"ref":"ticket-and-evidence","chars":2000}],
    "confidence": "medium",
    "uncertainty": {"reviewableFiles":2,"sourceChars":2000,"diffChars":2000,"combinedChars":5000,"unknowns":["New local imports may be required"]},
    "verification": ["npm test","npm run build"],
    "decomposition": []
  }
}
```

This is an illustrative envelope: replace revisions, repository, hash, paths and estimates. No sample hash grants admission. Plans list all expected source/test/doc/migration/config paths with Git status and, for a rename/copy, `previousPath`. Map every requirement to declared tasks and tests in both directions, every changed path to a task, and every task to tests covering its requirements. External dependencies declare `id`, full `revision` and `verification`; task dependencies reference task or external dependency IDs and must form an acyclic graph. Verification strings are evidence for the coordinator, never commands the validator executes.

A forecast checks paths and existing contents/imports at the declared base without reading working-tree source files. For renames/copies, content is read from `previousPath` at base and relative imports resolve from the planned destination. If a destination import cannot resolve, forecast returns `invalid` with `unresolved-import`; declare the future destination dependency and its size in `imports` before retrying. Newly introduced imports must be forecast in each file's `imports` list (`path`, `sourceChars`). Existing sources and immediate imports establish minimum size estimates. Listed tests must exist at base or be planned additions. Include future content estimates for every reviewable path. The optional plan `contextSources` list forecasts individual non-code sources (default empty); its sum establishes a minimum for `otherContextChars`, and individual sizes participate in the per-source limit. The coordinator remains responsible for forecasting complete evidence. Low/medium confidence or declared unknowns require positive quantified file, source, diff and combined margins. Observations are conservative upper bounds: the file reserve increases changed/reviewable/source counts; the source reserve increases the largest source; combined evidence includes the diff/source reserves plus the aggregate reserve. A forecast is an estimate, not evidence of actual verification.

An actual check requires full existing base/head commit IDs, base ancestry, current HEAD matching the supplied head, and a clean worktree including untracked files. Commit a checkpoint before invoking it; keep request/config files outside the worktree. It measures complete Git name/status and patch evidence, base contents of deletions and exact head source/import contents. `contextSources` is mandatory in actual requests, including an explicit empty list when appropriate. The trusted coordinator supplies current character counts of every non-code evidence source it will submit (ticket, conversations, notes, logs and receipts); these are included in combined and per-source checks. The CLI cannot attest external evidence that it has not gathered. The reviewer independently evaluates its own gathered evidence with the same policy. Never reuse forecast context estimates as actual measurements.

Every result has `status` (`pass`, `decompose`, `invalid`), `phase`, policy version/hash, effective limits, observations, actionable reasons and base/head/plan-hash binding. Exit codes are respectively 0, 2 and 1. Missing or malformed request/plan/config is structured `invalid`, never pass. Traversal, absolute scope paths, private/secret paths and excluded imports are refused before their contents are read; public env examples are allowed. No context is silently truncated to obtain a pass. A hard collection boundary stops further reads and reports `collection-stopped`; remaining source sizes are explicitly unmeasured. If actual paths/statuses differ from the admitted plan or a planned path is missing, revise the complete plan and repeat both checkpoints. A prior forecast pass cannot authorize an oversized actual diff.

For decomposition, retain every original requirement and planned path in proposed slices. Each slice declares `id`, `requirements`, `paths`, full `base`, `dependencies`, `diffChars`, `otherContextChars` and nonempty `verification`. The validator checks coverage, dependency references/cycles and estimated slice capacities. This is a proposal: admit each child with its own complete plan, margins and independent checks, preserve migration order, then verify parent integration acceptance. Do not remove tests/docs or narrow acceptance to fit a cap.

Private coordinator integration, runtime installation, scheduled repair and reusable lessons are separate phases. The public correction contract does not install or run a host worker. Passing scope, unit or database tests proves none of those private/runtime pieces are installed. Existing independent exact-revision review and registered shipping authority remain required.
