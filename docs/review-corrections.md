# Automatic correction queue

The optional queue returns actionable review findings to the original builder. It is disabled by default and does not install a host launcher or timer. Configure the [automatic review gate](automatic-review.md) and its dedicated worker login first. Hosts and paths below are examples; use your own owner-owned policy and registered repository.

## Enable after a non-shipping canary

Apply the engine migrations, keep shipping disabled, and verify the scratch-database lifecycle tests plus a real non-shipping host round trip. Register the original launch before the first review submission. Only the trusted coordinator or dedicated worker may attest that identity; a builder's result text cannot replace it.

```sh
node server/dist/cli-review.js register /etc/secondbrain/review-host.json <<'JSON'
{"card":"t_123abc","builder":"builder","persona":"engineer","runtime":"codex","model":"example-model","host":"worker-a","repo":"engine","branch":"card/t_123abc","worktree":"/srv/worktrees/t_123abc","commonDir":"/srv/git/engine","originalRunId":"run-original","stage":"build"}
JSON
```

The card assignee must match the registered builder. Registration is immutable. Optional stage is `plan`, `build`, or `correction`. After verification, the database owner can opt in through the existing review policy:

```sql
UPDATE review_policy SET corrections_enabled=true WHERE singleton;
```

This does not enable shipping. The original review policy and exact-revision review, merge, deployment and health checks remain authoritative. Missing identity and exhausted correction rounds require operator reconciliation.

## Host protocol

All commands use the same owner-owned policy file and dedicated worker database identity. Payloads are data on stdin, not model-selected shell commands.

```sh
node server/dist/cli-review.js claim /etc/secondbrain/review-host.json worker-a
node server/dist/cli-review.js prepare /etc/secondbrain/review-host.json < prepare.json
node server/dist/cli-review.js ack /etc/secondbrain/review-host.json < acknowledgement.json
node server/dist/cli-review.js retry /etc/secondbrain/review-host.json < retry.json
node server/dist/cli-review.js finish /etc/secondbrain/review-host.json < finish.json
node server/dist/cli-review.js cancel /etc/secondbrain/review-host.json < cancel.json
node server/dist/cli-review.js status /etc/secondbrain/review-host.json
```

`claim` returns one leased item with its immutable feedback, original runtime/persona/model/host, branch/worktree, revision binding, lease token and fence. It leaves the card ready. Before spawning, send `prepare` with `id`, `leaseToken`, `fence`, a real unique `runId`, and `head`. Only a successful `starting` reservation allows the host to spawn. Send `ack` with those fields plus the real `processId`; acknowledgement revalidates the live PR and makes the bound attempt running. Do not launch after a cancelled, blocked or uncertain response.

For unprepared host unavailability, `retry` takes `id`, `leaseToken`, a safe `reason`, and `delaySeconds`. Backoff is bounded and spends no code-fix round. `finish` takes `id`, `leaseToken`, `fence`, `runId`, and `head`; it submits only the current bound run through the existing review gate. `cancel` takes `id`, `leaseToken`, `fence`, the reserved `runId` or `null` before reservation, and a safe `reason`. The host must retain these values from its own claim and reservation. It must never fill missing callback identity from a newly queried correction row. Repeated confirmed operations are idempotent. Late callbacks must not alter another active run, a newer submission, accepted completion or shipping receipt.

## Failures and recovery

A confirmed closed, unrelated or changed PR is stale work and may be cancelled. A temporary GitHub or network lookup failure is not evidence that a PR closed. Before launch, bounded backoff can safely return a proven no-start item to the queue. During acknowledgement, the worker retries only the same read-only lookup for a short fixed bound inside the actual remaining lease, while retaining the same correction, run ID, fence, process ID and reservation. A later success within that bound acknowledges once; a late success or exhaustion reconciles that reserved run and never redispatches it. Authentication or identity uncertainty blocks immediately for operator action. Surface only a safe error kind; raw child stderr and credentials never belong in card findings or CLI evidence.

An expired plain claimed lease is a protocol-proven no-start. A reclaimed row has a new token and incremented fence, so callbacks from the old holder are rejected. An expired prepared lease may already have spawned; reconcile its reserved run ID before any new process. A running callback remains valid when its original claim TTL passes because its immutable token, fence and reserved run identity, not the old deadline, bind it. Ambiguous starts or external shipping effects never permit blind replay. Current-attempt checks and the card lock protect newer work when cancelling or finishing old callbacks.

Revision-bound feedback is immutable and retains every distinct finding. Producer origin is an authenticated worker argument, separate from the finding code: model-generated `ci-failure` or `scope-*` codes remain reviewer findings, while deterministic coordinator findings must be saved through the trusted coordinator path. Replaying identical feedback cannot relabel its producer. It moves the same assigned card to ready and creates one correction item transactionally, while preserving the existing bounded correction limit. A capacity rejection is not model acceptance. Private, excluded or incomplete essential context remains blocked.

Successful correction work creates a new commit. At `finish`, the trusted host reads the registered worktree, branch and Git common directory, requires a clean descendant of the rejected head, and derives the completion head directly from Git. It then revalidates that exact head, base, branch and open PR before submitting. The rejected head remains immutable queue evidence. A changed or closed PR cancels only the old attempt; temporary, authentication or identity uncertainty retains and blocks the reserved run for reconciliation. Builder result text cannot supply either producer authority or completion attestation.

To stop new queue activity, set `corrections_enabled=false`. Later rejections use the legacy wake path; stored feedback, queued evidence and shipping receipts remain for reconciliation. Database and unit tests prove their tested contracts only. Verify the real scheduled host loop separately before enabling unattended operation.

This B1 change is queue-only and remains default off. It does not install or enable a timer, worker or scheduled host loop. B2 must still connect typed deterministic preflight and failed-CI production, add bounded typed reviewer-execution retries and escalation, and prove the full orchestration before unattended enablement. The broader architecture and onboarding expansions are tracked separately.
