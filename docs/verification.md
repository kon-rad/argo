Status: **pilot** - the contract, entry point, isolated CI backend, coordinator checks and review-gate hooks are in the engine; an installation must register its own policy before any of it gates real work.

# Capability-aware verification

Builders write code with no credentials and no services. Verification executes that untrusted code somewhere disposable, under an identity that cannot touch the evidence, records evidence bound to one commit, and the trusted coordinator judges the evidence itself before independent review. This page covers the repository contract, the one command that runs it, the sandbox, the private installation policy, how failures are routed, and the difference between merge-disabled, activation-pending and complete.

## Pieces and who owns them

| Piece | Path | Owner | Trusted? |
|---|---|---|---|
| Verification contract | `verification/contract.json` | Repository (PRs may change it) | No. Admission checks it against policy |
| Entry point and supervisor | `scripts/verify.mjs` | Repository | Only at the contents the installation pinned |
| Disposable verifier | `.github/workflows/ci.yml`, job `app` | Repository | Only at the contents the installation pinned |
| Installation policy | outside the repository (example: `app/deploy/verification-policy.example.json`) | Owner | Yes |
| Coordinator | `app/server/src/verification/`, `cli-review verify`, the review worker | Engine release installed by the owner | Yes |

Repository content can never choose a runner, mount, privilege, credential, environment variable, download source or deployment target. Contract fields outside the schema are rejected.

## The contract

```json
{
  "version": 1,
  "capabilities": ["postgres", "loopback-listeners", "dependency-download:npm"],
  "checks": [
    {"id": "dependencies", "covers": ["dependencies"], "cwd": "app", "argv": ["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"], "requires": ["dependency-download:npm"], "timeoutSeconds": 900, "count": "none"},
    {"id": "tests", "covers": ["unit", "migrations", "integration", "regression"], "cwd": "app", "argv": ["npm", "test", "--", "--reporter=default", "--reporter=json", "--outputFile.json={report}"], "requires": ["postgres", "loopback-listeners"], "timeoutSeconds": 1500, "count": "required", "report": "vitest-json"}
  ],
  "externalIntegrations": []
}
```

- Capabilities in version 1: `postgres`, `loopback-listeners`, `dependency-download:npm`. Anything else (a GPU, a Docker socket, a host shell, `dependency-download:pypi`, whose install hooks this version cannot disable) is **verification infrastructure unavailable**, reported immediately.
- `argv[0]` must be `npm`, `npx`, `node` or `python3`. No shells, `sudo` or absolute host paths. `cwd` is repository-relative.
- A check that needs a dependency download must be `npm ci --ignore-scripts ...`: package lifecycle scripts never run.
- Each check has a timeout (at most 1800 seconds, 3600 in total). Logs are capped at 2,000,000 bytes per check; truncation is recorded.
- `count: "required"` needs a machine-readable report (`vitest-json`, written to the `{report}` placeholder). Every count field must be present and consistent (`passed + failed + pending + todo = total`), the number of typed failures must equal the failed count, and a required count must have no pending or todo (skipped) tests. Anything else is recorded as `unknown` and never passes. A count is never parsed from log text.
- `covers` names what a check proves: `dependencies`, `build`, `unit`, `migrations`, `integration`, `regression`. In this repository the `tests` check covers migrations and integration because the test harness rebuilds the database from migrations on a real Postgres.

## One command, locally and in CI

```sh
node scripts/verify.mjs validate          # check the contract; runs nothing
node scripts/verify.mjs preflight         # is a safe disposable backend available here?
node scripts/verify.mjs run --out <dir>   # execute; <dir> must be outside the checkout and empty
```

Exit codes: 0 pass, 1 a check failed, 2 contract or request invalid, 3 verification infrastructure unavailable.

On a workstation, `preflight` and `run` report `no-disposable-backend` and exit 3 without running any check. That is correct: this engine provides only the GitHub-hosted backend. The local container backend is not implemented, so a running Docker daemon is reported but not used. Do not give a builder Docker, host or network permissions to work around this; push the branch and let CI verify it.

In CI, the `app` job runs the same `run` command on a GitHub-hosted Ubuntu VM with a throwaway `pgvector/pgvector:pg16` service and the fake `postgres`/`postgres` login, `permissions: contents: read`, `persist-credentials: false`, no repository secrets, no npm cache and a 60 minute job timeout. It checks out the exact PR head rather than GitHub's synthetic merge commit and uploads `evidence.json`, `logs/` and `reports/` as the `verification-evidence` artifact for 14 days.

## The sandbox

`scripts/verify.mjs` is a supervisor. It never runs repository code as itself.

1. **Preflight.** It refuses a self-hosted runner, `GITHUB_TOKEN`/`GH_TOKEN`/OIDC/`ACTIONS_RUNTIME_TOKEN`/npm tokens in its environment, a persisted checkout authorization header, a non-loopback `PGHOST` and an unreachable declared Postgres. It needs Linux, passwordless `sudo` (GitHub-hosted runners have it), `iptables` and `ip6tables`, and a VM where the sandbox user does not exist yet. Anything missing is `isolation-unavailable`, exit 3.
2. **Identity.** It creates the user `sbverify` with its own group and one supplementary group, no shell, and no membership in `docker`, `adm` or `sudo`, and copies the exact clean checkout into `/home/sbverify/work`. Reports go to `/home/sbverify/reports`. The evidence directory stays owned by the supervisor with mode 0700.
3. **Egress.** `iptables` and `ip6tables` owner rules for `sbverify`: DNS (port 53) refused, loopback allowed, everything else refused. The disposable Postgres is reached on loopback.
4. **Boundary probe.** Before any check, the supervisor runs an adversarial probe as `sbverify`. Each of these must be denied: read the evidence canary, write the evidence directory, write the supervisor's checkout, read the supervisor's `/proc/<pid>/environ`, signal the supervisor, connect to the Docker socket, `sudo -n true`, connect to the registry address the supervisor itself just reached, resolve a name through the resolver, and resolve a name through the system lookup. Each declared capability must work: Postgres reachable, a loopback listener bindable. Any other outcome is infrastructure unavailable and no check runs. The probe results are part of the evidence.
5. **Dependencies.** For a check that requires `dependency-download:npm`, the supervisor first refuses any lockfile entry that is not a `https://registry.npmjs.org/` download with sha512 integrity (`dependency: unlocked-source`). It then starts a CONNECT-only proxy on loopback that reaches `registry.npmjs.org:443` and nothing else, and runs the check with `npm_config_ignore_scripts=true`, the fixed registry and that proxy. The proxy stops when the check ends, so later checks have no route out. The allowed hosts are part of `scripts/verify.mjs`, whose contents the installation pins, so a PR cannot widen them.
6. **Execution.** Each check runs as `sudo -n -u sbverify -- /usr/bin/env -i -C <cwd> <fixed environment> <argv>`. Checks receive only `PATH`, `HOME=/home/sbverify`, `LANG`, `CI=true`, the `PG*` settings when `postgres` is declared, and the npm settings above for a download. The supervisor captures exit status and output from pipes, writes the log itself, and on timeout or completion kills every `sbverify` process. It then copies the report (read as `sbverify`, size-bounded) into the evidence directory and checks that the evidence directory, its mode and its canary are exactly as it left them. A tampered directory or a surviving process is `isolation-breach`, exit 3.

Execution stops at the first failing check; later checks are recorded as `not-run`, which never passes.

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
| `requiredChecks` | Minimum checks. Each pins `id`, `argv`, `cwd`, `requires`, `report` (or `null`), `covers`, `count` and `minTimeoutSeconds`. A contract that drops a required check, changes its argv, cwd or report, drops a required capability, narrows coverage, weakens the count or shortens the timeout below the minimum is invalid |
| `externalEvidence.documentationOrigins` | https origins whose pages the coordinator fetches itself to confirm a documentation quote. Default none |
| `externalEvidence.observed` | SHA-256 of sanitized observed responses that an integration validator recorded. Default none |
| `backend.maxAgeDays` | Admission needs a successful hosted run of the configured job on the base branch this recent. Default 14 |
| `mergeDisabled` | Default `false`. When `true`, an unverified external integration may merge only if its off-state check passed and the target attests the flag is off |
| `activation` | Optional owner program for activation and off-state receipts (below) |

To gate automatic review, put the same object under `repositories.<name>.verification` in the review host policy ([automatic review](automatic-review.md#owner-setup)). Without it the worker behaves as before.

## Coordinator commands

```sh
node app/server/dist/cli-review.js verify admit request.json /etc/secondbrain/verification-policy.json
node app/server/dist/cli-review.js verify check request.json /etc/secondbrain/verification-policy.json
```

- `admit`, before a builder is launched: request `{"repository":"/srv/engine","revision":"<40-hex base>","github":"example/engine","gh":"/usr/bin/gh","home":"/srv/review/service-home"}`. It reads the contract from local Git objects and admits it against the policy. Then it establishes the backend: GitHub Actions enabled for the repository, the configured workflow `active`, and a successful `push` run of it within `backend.maxAgeDays` whose configured job ran on a GitHub-hosted runner and whose evidence proved the sandbox and every capability the contract requests. Answers `admitted` (exit 0), `unavailable` (exit 3: an unoffered capability, Actions disabled, workflow disabled, no recent proven run, GitHub unreachable) or `invalid` (exit 1). This is the generic hook a private card runner calls; on exit 3 it must not launch the builder.
- `check`, after CI: request `{"github":"example/engine","gitDir":"/srv/review/engine.git","head":"<40-hex>","gh":"/usr/bin/gh","git":"/usr/bin/git","home":"/srv/review/service-home"}`. Prints the verification record and exits 0 on pass, 3 when the failure is infrastructure, 1 otherwise.

Neither command executes repository checks. Both run on the coordinator host, so they must not.

## What makes evidence acceptable

The coordinator fetches everything itself. It never reads builder-produced JSON, PR text or URLs:

1. The newest run of `workflow.path` for the exact head SHA and an allowed event, which must be completed.
2. The configured job from GitHub's jobs API: runner group and labels must be GitHub-hosted; `self-hosted` is refused.
3. The single unexpired artifact with the configured name belonging to that run, within `maxArtifactBytes`, downloaded by id into memory. Nothing is extracted to disk. Before any member is inflated, the central directory is checked: at most 64 members, names only `evidence.json`, `logs/<id>.log` or `reports/<id>.json`, regular files only (no links or special files), no duplicates, no zip64 or encryption, per-member limits (1 MB evidence, 2 MB log, 10 MB report) and the expanded total. Inflation is capped at each member's declared size and its CRC must match.
4. The contract, workflow and runner contents at the head from Git objects. Their hashes must match the evidence (contract) or the policy pins (workflow, runner).
5. In `evidence.json` (version 2, strict schema): the source SHA equals the head and the checkout was clean; the run ID and attempt match the artifact's run; the isolation record is the `sbverify` loopback-only user with every probe as required. There is exactly one record per contract check (duplicates and extras are refused). Each record's template argv equals the contract, and its executed argv and cwd equal the fixed sandbox paths. A pass needs exit 0, no signal and an observed exit. The log and report match their recorded SHA-256 and size. The coordinator re-reads the report itself and its count must equal the recorded count. A required count must be positive with no failed, pending or todo tests. The run conclusion must be `success`.

A new commit, an edited contract or an edited workflow or runner gives a different head, contract hash or pin, so old evidence stops applying. In review, the verification record joins the review evidence as `verification:<head>`, so a re-run with different results also invalidates an earlier approval.

## Failure routing

| Type | Route | Raised when |
|---|---|---|
| `assertion` | the original builder | Every failed test in the runner's own report is a serialized `AssertionError` |
| `infrastructure` | the verifier | Unsupported or unoffered capability, unprovable or breached sandbox, unreachable or lost service (`ECONNREFUSED`, `Connection terminated`, Postgres admin shutdown in the report), sandbox permission denial (`EACCES`, `EPERM`), killed process, untrusted runner, unusable backend at admission |
| `dependency` | reproducible-environment repair | A `dependencies` check failed, a lockfile source is not locked to the registry, or a test failed to load a module or package |
| `unknown` | verifier triage | A nonzero exit with no report, failures that are not all typed assertions (a `TypeError`, a mix), a timeout, a conclusion mismatch |
| `evidence` | the verifier | No run yet, pending run, stale SHA, contract mismatch, forged pass, tampered or missing log or report, count mismatch, skipped tests, duplicate or extra record, missing or skipped check, a hostile artifact |
| `verifier-trust` | the owner | The workflow or runner differs from the pinned contents |
| `contract` | the builder | The contract is missing, malformed or weaker than the installation minimum |
| `external-contract` | integration validation | An external assumption lacks independent support and merge-disabled is not allowed |
| `authorization` | activation pending | Reserved for owner authorization; activation reports it as pending, never as a failure of the code |

A nonzero exit or a log line such as `AssertionError` is not enough to call something an assertion. The review gate routes each failure independently. Typed assertions and contract errors go back to the builder as findings. Every other failure is recorded in the job error (`Retained blockers for other routes: ...`), with trust failures listed first, so a real assertion is not hidden behind an unrelated external blocker and the blocker is not lost. With no builder-actionable failure, the job blocks with an error such as `Verification infrastructure -> verifier [service-lost]: ...`. A red CI job whose cause is infrastructure is therefore not sent back to the builder.

## External integrations: merge-disabled, activation-pending, complete

```json
"externalIntegrations": [{
  "id": "photos", "operation": "GET /v1/media", "flag": "PHOTOS_ENABLED", "offStateCheck": "tests",
  "assumptions": [{"id": "token-scope", "statement": "A read token can list media",
    "evidence": [{"kind": "documentation", "url": "https://docs.example.com/media", "quote": "Read tokens may list media."}]}]
}]
```

Each assumption needs independent support:

- `documentation`: an https URL and the quoted passage. It counts only if the URL's origin is in `externalEvidence.documentationOrigins` and the coordinator fetched the page itself (no redirects, 15 s, 2 MB) and found the quote in its text. A fabricated quote, an unlisted origin or an unreachable page does not count.
- `observed-response`: a sanitized file under `verification/observed/` with its SHA-256. It counts only if an integration validator recorded that hash in `externalEvidence.observed`. A builder-written observation alone does not count.
- `fixture` shows internal behaviour under an assumption, not what the provider does. It never counts.

An integration without that support is **experimental**.

| Outcome | Meaning | Board state |
|---|---|---|
| Blocked (`external-contract`) | Experimental integration and the installation does not allow merge-disabled, or its off-state check did not pass | job `blocked`, nothing merged |
| Blocked (`off-state-unproven` or `off-state-violated`) | Merge-disabled is allowed, but the target did not attest the flag is off, or attests it is on. Checked before merge and again before deploy | job `blocked`, nothing deployed |
| **Merge-disabled** | Policy `mergeDisabled: true`, all checks passed, the `offStateCheck` passed, independent review accepted, the target attested the flag is off; merged and deployed with the flag off | job `blocked`, error starts `merge-disabled:`; never done |
| **Activation-pending** | Supported integration deployed; waiting for owner authorization or a successful live integration on the exact merged revision | job `blocked`, error starts `activation-pending:`; never done |
| **Complete** | Deployed, exact-revision health passed, and every supported integration has an authorized, observed live receipt for the merged revision | job `done` |

Merge and health never satisfy activation. The owner's `activation` program answers two calls with one JSON receipt each:

```sh
<argv> off-state <target> <flag>              # {"target":"<target>","flag":"<flag>","enabled":false,"evidenceSha256":"<64-hex>"}
<argv> activation <merged-revision> <id>      # {"integration":"<id>","revision":"<40-hex>","authorized":true,"observed":true,"evidenceSha256":"<64-hex>"}
```

A missing program, a failed call, a different target, flag or revision, `enabled: true`, `authorized: false` or `observed: false` keeps the job blocked or pending. An experimental integration stays pending until a later revision supplies real evidence.

## Operator recovery

| Symptom | Do this |
|---|---|
| `verifier-trust: trusted-file-changed` | Review the workflow or runner diff yourself. If acceptable, add the new SHA-256 to `trustedFiles` and let the worker retry |
| `evidence: run-missing` or `run-pending` | Wait for CI. If the run never started, re-run the workflow for that head |
| `evidence: stale-run`, `stale-evidence`, `contract-mismatch` | The head or contract moved. Wait for the new head's run; do not reuse old artifacts |
| `infrastructure: isolation-unavailable`, `isolation-unproven` or `isolation-breach` | Read the probe results in `evidence.json`. Fix the runner image or the supervisor through a reviewed change, pin it, re-run. Never weaken the probe or give the builder more access |
| `infrastructure: ...` (other) | Fix the verifier (service image, runner availability), then re-run the workflow. Do not widen builder permissions |
| `admit` exits 3 | Re-enable Actions or the workflow, or let a push to the base branch produce a fresh proven run, then admit again |
| `dependency: ...` | Repair lock files or registry access reproducibly, then re-run |
| `unknown: ...` | Read the retained log and report in the artifact, decide the cause, then route it by hand |
| `off-state-unproven` or `off-state-violated` | Turn the flag off at the target, make the activation program attest it, let the worker retry |
| `activation-pending: ...` | Authorize and observe the live integration through the activation program; the worker retries every five minutes |

## Limitations

- The only backend is a GitHub-hosted VM. The container backend is not implemented, so local `run` always reports unavailable.
- The sandbox is a separate Linux user on the same VM as the supervisor, not a separate VM. Its strength is ordinary Unix permissions plus owner-match firewall rules; a kernel privilege escalation would defeat it. The supervisor has `sudo`; repository code does not.
- The probe tests the system name lookup. If a runner image resolves names through a local daemon socket rather than port 53, the probe reports `dns-lookup: allowed` and the run is unavailable until the image or rules change.
- Loopback Postgres works because Docker's userland proxy serves the published port on loopback. A runner image that routes published ports through NAT instead makes the `postgres` probe fail, and the run reports unavailable.
- The npm proxy allows the whole registry host, so a malicious lockfile can still fetch any published package from it. Integrity hashes are pinned by the lockfile, which the independent reviewer sees in the diff.
- A test report is written by the test runner, which is repository code. The coordinator re-reads and types it, but a hostile suite can still misreport its own results; independent review of the diff remains a defence.
- Only the `app` job runs under the contract. The `python`, `vault`, `zen-agent` and `leaks` jobs remain ordinary required checks.
- The coordinator's GitHub checks rely on the documented `runner_group_name`, `labels`, workflow `state`, Actions `permissions` and artifact zip API fields.
