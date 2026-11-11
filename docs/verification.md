Status: **pilot** - the contract, entry point, CI backend, coordinator checks and review-gate hooks are in the engine; an installation must register its own policy before any of it gates real work.

# Capability-aware verification

Builders write code with no credentials and no services. Verification executes that untrusted code somewhere disposable, records evidence bound to one commit, and the trusted coordinator judges the evidence itself before independent review. This page covers the repository contract, the one command that runs it, the private installation policy, how failures are routed, and the difference between merge-disabled, activation-pending and complete.

## Pieces and who owns them

| Piece | Path | Owner | Trusted? |
|---|---|---|---|
| Verification contract | `verification/contract.json` | Repository (PRs may change it) | No. Admission checks it against policy |
| Entry point | `scripts/verify.mjs` | Repository | No. Its file contents are pinned by policy |
| Disposable verifier | `.github/workflows/ci.yml`, job `app` | Repository | No. Its file contents are pinned by policy |
| Installation policy | outside the repository (example: `app/deploy/verification-policy.example.json`) | Owner | Yes |
| Coordinator | `app/server/src/verification/`, `cli-review verify`, the review worker | Engine release installed by the owner | Yes |

Repository content can never choose a runner, mount, privilege, credential, environment variable or deployment target. Contract fields outside the schema are rejected.

## The contract

```json
{
  "version": 1,
  "capabilities": ["postgres", "loopback-listeners", "dependency-download:npm"],
  "checks": [
    {"id": "dependencies", "covers": ["dependencies"], "cwd": "app", "argv": ["npm", "ci", "--no-audit", "--no-fund"], "requires": ["dependency-download:npm"], "timeoutSeconds": 900, "count": "none"},
    {"id": "tests", "covers": ["unit", "migrations", "integration", "regression"], "cwd": "app", "argv": ["npm", "test", "--", "--reporter=default", "--reporter=json", "--outputFile.json={report}"], "requires": ["postgres", "loopback-listeners"], "timeoutSeconds": 1500, "count": "required", "report": "vitest-json"}
  ],
  "externalIntegrations": []
}
```

- Capabilities in version 1: `postgres`, `loopback-listeners`, `dependency-download:npm`, `dependency-download:pypi`. Anything else (a GPU, a Docker socket, a host shell) is **verification infrastructure unavailable**, reported immediately.
- `argv[0]` must be `npm`, `npx`, `node` or `python3`. No shells, `sudo` or absolute host paths. `cwd` is repository-relative.
- Each check has a timeout (at most 1800 seconds, 3600 in total). Logs are capped at 2,000,000 bytes per check; truncation is recorded.
- `count: "required"` needs a machine-readable report (`vitest-json`, written to the `{report}` placeholder). A count is reported by the tool or recorded as `unknown`; it is never parsed from log text. A required count that is missing, zero or failing never passes.
- `covers` names what a check proves: `dependencies`, `build`, `unit`, `migrations`, `integration`, `regression`. In this repository the `tests` check covers migrations and integration because the test harness rebuilds the database from migrations on a real Postgres.

## One command, locally and in CI

```sh
node scripts/verify.mjs validate          # check the contract; runs nothing
node scripts/verify.mjs preflight         # is a safe disposable backend available here?
node scripts/verify.mjs run --out <dir>   # execute; <dir> must be outside the checkout
```

Exit codes: 0 pass, 1 a check failed, 2 contract or request invalid, 3 verification infrastructure unavailable.

On a workstation, `preflight` and `run` report `no-disposable-backend` and exit 3 without running any check. That is correct: this engine provides only the GitHub-hosted backend. The local container backend is not implemented, so a running Docker daemon is reported but not used. Do not give a builder Docker, host or network permissions to work around this; push the branch and let CI verify it.

In CI, the `app` job runs the same `run` command. The job uses a GitHub-hosted Ubuntu VM, a throwaway `pgvector/pgvector:pg16` service with the fake `postgres`/`postgres` login, `permissions: contents: read`, `persist-credentials: false`, no repository secrets, a 60 minute job timeout, and checks out the exact PR head rather than GitHub's synthetic merge commit. It uploads `evidence.json`, `logs/` and `reports/` as the `verification-evidence` artifact for 14 days.

Before any check runs, the entry point refuses a self-hosted runner, `GITHUB_TOKEN`/`GH_TOKEN`/OIDC/npm tokens in its environment, a persisted checkout authorization header, a non-loopback `PGHOST`, an unreachable declared Postgres and a denied loopback listener. Checks receive only `PATH`, `HOME`, `LANG`, `LC_ALL`, `TMPDIR`, `CI=true` and, when `postgres` is declared, the `PG*` settings. Execution stops at the first failing check; later checks are recorded as `not-run`, which never passes.

## Installation policy

Copy `app/deploy/verification-policy.example.json` to an owner-owned location (mode 0600 or 0644, never group- or world-writable) and replace the placeholder hashes:

```sh
sha256sum .github/workflows/ci.yml scripts/verify.mjs   # on the reviewed base you trust
```

| Field | Meaning |
|---|---|
| `workflow.path`, `workflow.job`, `workflow.artifact`, `workflow.events` | The only workflow, job, artifact and events whose evidence counts |
| `trustedFiles` | SHA-256 of approved workflow and runner contents. Must pin both. A PR that edits either is refused (`verifier-trust`) until the owner reviews and adds the new hash |
| `runner.group`, `runner.labels` | GitHub-hosted runner group (`GitHub Actions`) and allowed labels. There is no self-hosted option in version 1 |
| `capabilities` | What this installation's verifier provides |
| `requiredChecks` | Minimum checks with exact argv, coverage and count strictness. A contract that drops, rewrites or weakens one is invalid |
| `mergeDisabled` | Default `false`. When `true`, an unverified external integration may merge only if its off-state check passed |
| `activation` | Optional owner program that attests live authorization and integration (below) |

To gate automatic review, put the same object under `repositories.<name>.verification` in the review host policy ([automatic review](automatic-review.md#owner-setup)). Without it the worker behaves as before.

## Coordinator commands

```sh
node app/server/dist/cli-review.js verify admit request.json /etc/secondbrain/verification-policy.json
node app/server/dist/cli-review.js verify check request.json /etc/secondbrain/verification-policy.json
```

- `admit`, before a builder is launched: request `{"repository":"/srv/engine","revision":"<40-hex base>"}`. Reads the contract from local Git objects only and answers `admitted` (exit 0), `unavailable` (exit 3, for example a capability the installation does not offer) or `invalid` (exit 1). This is the generic hook a private card runner calls; launching a builder after `unavailable` only wastes a run.
- `check`, after CI: request `{"github":"example/engine","gitDir":"/srv/review/engine.git","head":"<40-hex>","gh":"/usr/bin/gh","git":"/usr/bin/git","home":"/srv/review/service-home"}`. Prints the verification record and exits 0 on pass, 3 when the failure is infrastructure, 1 otherwise.

Neither command executes repository checks. Both run on the coordinator host, so they must not.

## What makes evidence acceptable

The coordinator fetches everything itself. It never reads builder-produced JSON, PR text or URLs:

1. The newest run of `workflow.path` for the exact head SHA and an allowed event, which must be completed.
2. The configured job from GitHub's jobs API: runner group and labels must be GitHub-hosted; `self-hosted` is refused.
3. The single unexpired artifact with the configured name belonging to that run, within `maxArtifactBytes`.
4. The contract, workflow and runner contents at the head from Git objects. Their hashes must match the evidence (contract) or the policy pins (workflow, runner).
5. In `evidence.json`: the source SHA equals the head and the checkout was clean; the run ID and attempt match the artifact's run; every contract check is present with the same argv, exit code 0, a log whose SHA-256 and byte length match the retained file, and a machine count where required. The run conclusion must be `success`.

A new commit, an edited contract or an edited workflow or runner gives a different head, contract hash or pin, so old evidence stops applying. In review, the verification record joins the review evidence as `verification:<head>`, so a re-run with different results also invalidates an earlier approval.

## Failure routing

| Type | Route | Raised when |
|---|---|---|
| `assertion` | the original builder | A machine-reported test count shows failing tests |
| `infrastructure` | the verifier | Unsupported or unoffered capability, unreachable service, sandbox denial, missing executable, killed process, untrusted runner |
| `dependency` | reproducible-environment repair | A `dependencies` check failed |
| `unknown` | verifier triage | A nonzero exit with no machine-reported assertion, a suite that failed before any test (often a service), a timeout, a conclusion mismatch |
| `evidence` | the verifier | No run yet, pending run, stale SHA, contract mismatch, forged pass, tampered or missing log, missing or skipped check, missing count |
| `verifier-trust` | the owner | The workflow or runner differs from the pinned contents |
| `contract` | the builder | The contract is missing, malformed or weaker than the installation minimum |
| `external-contract` | integration validation | An external assumption lacks documentation or a sanitized observation and merge-disabled is not allowed |
| `authorization` | activation pending | Reserved for owner authorization; activation reports it as pending, never as a failure of the code |

A nonzero exit or a log line such as `AssertionError` is not enough to call something an assertion. The review gate returns findings to the builder only when every failure is an assertion; anything else blocks the job with an error such as `Verification infrastructure -> verifier [service-unreachable]: ...`. A red CI job whose cause is infrastructure is therefore not sent back to the builder.

## External integrations: merge-disabled, activation-pending, complete

```json
"externalIntegrations": [{
  "id": "photos", "operation": "GET /v1/media", "flag": "PHOTOS_ENABLED", "offStateCheck": "tests",
  "assumptions": [{"id": "token-scope", "statement": "A read token can list media",
    "evidence": [{"kind": "documentation", "url": "https://docs.example.com/media", "quote": "Read tokens may list media."}]}]
}]
```

Each assumption needs `documentation` (an https URL and the quoted passage, which the independent reviewer checks) or an `observed-response` (a sanitized file under `verification/observed/` with its SHA-256). A `fixture` shows internal behaviour under an assumption, not what the provider does, so a fixture-only assumption leaves the integration **experimental**.

| Outcome | Meaning | Board state |
|---|---|---|
| Blocked (`external-contract`) | Experimental integration and the installation does not allow merge-disabled, or its off state was not proven | job `blocked`, nothing merged |
| **Merge-disabled** | Policy `mergeDisabled: true`, all checks passed, the `offStateCheck` passed, independent review accepted; merged and deployed with the flag off | job `blocked`, error starts `merge-disabled:`; never done |
| **Activation-pending** | Supported integration deployed; waiting for owner authorization or a successful live integration on the exact merged revision | job `blocked`, error starts `activation-pending:`; never done |
| **Complete** | Deployed, exact-revision health passed, and every supported integration has an authorized, observed live receipt for the merged revision | job `done` |

Merge and health never satisfy activation. The `activation` program is called as `<argv> activation <merged-revision> <integration-id>` and must print one receipt:

```json
{"integration":"photos","revision":"<40-hex>","authorized":true,"observed":true,"evidenceSha256":"<64-hex>"}
```

A missing program, a failed call, a different revision, `authorized: false` or `observed: false` keeps the job pending. An experimental integration stays pending until a later revision supplies real evidence.

## Operator recovery

| Symptom | Do this |
|---|---|
| `verifier-trust: trusted-file-changed` | Review the workflow or runner diff yourself. If acceptable, add the new SHA-256 to `trustedFiles` and let the worker retry |
| `evidence: run-missing` or `run-pending` | Wait for CI. If the run never started, re-run the workflow for that head |
| `evidence: stale-run`, `stale-evidence`, `contract-mismatch` | The head or contract moved. Wait for the new head's run; do not reuse old artifacts |
| `infrastructure: ...` | Fix the verifier (service image, runner availability), then re-run the workflow. Do not widen builder permissions |
| `dependency: dependency-install` | Repair lock files or registry access reproducibly, then re-run |
| `unknown: ...` | Read the retained log in the artifact, decide the cause, then route it by hand |
| `activation-pending: ...` | Authorize and observe the live integration through the activation program; the worker retries every five minutes |

## Limitations

- The only backend is a GitHub-hosted VM. The container backend is not implemented, so local `run` always reports unavailable.
- Checks run on the same VM as the entry point, so a hostile test could tamper with files there. The pins, the run conclusion, log hashes and independent review of the diff are the defences; a stronger split (a separate job that never executes repository code) is follow-up work.
- Hosted runners have open egress. `dependency-download:*` is declared and admitted by policy, not enforced at the network layer.
- Documentation evidence is checked for shape only; the reviewer must confirm the quote supports the assumption.
- Only the `app` job runs under the contract. The `python`, `vault`, `zen-agent` and `leaks` jobs remain ordinary required checks.
- The coordinator's GitHub runner checks rely on the documented `runner_group_name` and `labels` job fields.
