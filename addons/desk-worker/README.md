# Hiring Desk isolated worker

P4's runner and bounded model gateway. The runner launches one short-lived container per attempt; the gateway is a separate trusted service. Worker output is a private artifact and has no publication or payment authority.

## Isolation model

Run this on a dedicated Linux VM with Docker Engine. The worker image runs as an unprivileged UID, drops all capabilities, enables `no-new-privileges`, uses a read-only root filesystem, has CPU, memory, PID and wall-clock bounds, and receives only a read-only synthetic corpus plus a per-attempt scratch directory. The scratch mount is the only writable mount. Each attempt gets a unique internal Docker network with only the gateway attached, preventing worker-to-worker network access. The gateway has a second outbound network for its configured model provider; it is not an HTTP proxy and accepts only the narrow model operation. Never attach the gateway to a public-facing network.

The deployment caller (P3) must authenticate the trusted control API and mint a short-lived HMAC capability for the gateway audience. The gateway signing key is configured only on the gateway and trusted control plane, never mounted in the worker. A capability binds job, attempt, expiry, canonical WorkerSpec SHA-256 (`json.dumps(spec, sort_keys=True, separators=(",", ":"))` UTF-8 bytes), model, tools, input references, corpus digest, output-token limit and atomic cost limit. Every tool request repeats the spec digest; the gateway rejects a mismatch. Cancellation revokes the attempt. SQLite `BEGIN IMMEDIATE` reservations serialize concurrent calls; reservations are reconciled against provider usage and are not released on ambiguous provider failure.

The included research worker compares exactly three supplied Markdown documents, writes a cited Markdown brief, and reports a SHA-256. The corpus digest is SHA-256 of UTF-8 canonical JSON mapping sorted refs to each document's SHA-256. It has no shell tool, package manager, arbitrary URL fetch, or executable content path. Container cleanup removes the scratch directory and revokes the attempt. The caller must durably retain the approved result and audit record before destruction.

## Build and run

Build the worker image on the target Linux VM:

```sh
docker build -t desk-worker:dev addons/desk-worker
docker compose -f addons/desk-worker/compose.yaml up -d --build
```

The gateway needs `DESK_SIGNING_KEY` (at least 32 random bytes), `DESK_MODEL_URL`, `DESK_MODEL_NAME`, `DESK_MODEL_API_KEY`, and integer micro-USD prices `DESK_INPUT_MICRO_USD_PER_1K` and `DESK_OUTPUT_MICRO_USD_PER_1K`. `WorkerLimits.maxCostAtomic` is reserved in micro-USD units (1 USD = 1,000,000 units); the gateway uses UTF-8 input-byte count as a conservative token upper bound and reserves the full requested output. Configure the model URL for the approved provider only. Missing pricing or provider configuration makes model calls unavailable. The key is read from the service environment and must not be copied into the worker environment. `DESK_STATE_DB` selects the gateway's durable SQLite state file.

`runner.py` is the Python `DeskRunner`-side adapter reference. Its `start(spec, capability)` launches Docker with a caller-supplied immutable spec and capability, creates the per-attempt network and attaches the gateway; `status` returns bounded result metadata; `cancel` revokes the gateway attempt and stops/removes the container and network. The service must run `reap_orphans()` under a single-runner startup lock before accepting dispatches; it removes labeled containers/networks left after process restart. It reports `unavailable` on non-Linux hosts or when Docker is unavailable. The control caller must issue and validate capabilities against the frozen `WorkerSpec` contract.

## Checks and evidence

Run policy/unit tests with `python3 -m pytest addons/desk-worker/tests`. For the real-container checks, start the internal gateway with an approved test configuration and provide a test-only `DESK_SIGNING_KEY`; run `DESK_WORKER_CONTAINER_TESTS=1 DESK_SIGNING_KEY=... python3 -m pytest addons/desk-worker/tests/test_container_denials.py`. The test probes forbidden file reads and raw/private/metadata egress inside a container, then runs the actual three-document worker against the gateway and verifies the result hash. It is deliberately skipped by default; a mocked policy test is not isolation evidence.

The current builder environment has a Docker CLI but no reachable daemon. Therefore no container-level denial result is claimed. Linux kernel, Docker daemon, host firewall, gateway egress rules, provider pricing correctness and live model behavior remain deployment verification requirements. Docker policy is defense in depth and does not replace a VM boundary or host firewall review.
