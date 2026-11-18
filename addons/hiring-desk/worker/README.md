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

## Trusted control service

`control.py` now wraps the runner with a private authenticated HTTP service. Run it on the same dedicated Linux worker host as Docker and the gateway, using a separate control-plane identity and private network. It binds loopback by default. Terminate TLS on a trusted private ingress if the app reaches it remotely. Do not publish this API or its credential to browsers, workers or public CORS origins.

Required environment variables:

| Variable | Purpose |
|---|---|
| `DESK_CONTROL_TOKEN` | Distinct random bearer credential, at least 32 characters; server app and control only |
| `DESK_SIGNING_KEY` | Capability HMAC key shared only by trusted control and gateway |
| `DESK_CONTROL_CORPUS_DIR` | Operator-selected directory containing approved public corpus documents |
| `DESK_CONTROL_RUN_DIR` | Operator-selected private runner artifact/scratch root |
| `DESK_CONTROL_STATE_DIR` | Durable private control SQLite and singleton-lock directory |
| `DESK_STATE_DB` | Existing gateway SQLite file, shared with the control service for durable budget identity and revocation |
| `DESK_CONTROL_ALLOWED_MODELS` | Comma-separated allowlist of approved model identifiers |

Optional configuration: `DESK_CONTROL_BIND` (default loopback), `DESK_CONTROL_PORT` (8790), `DESK_CONTROL_GATEWAY_CONTAINER`, `DESK_CONTROL_WORKER_IMAGE`, `DESK_CONTROL_GATEWAY_URL`. All paths, images and gateway URLs come from trusted service configuration. No request selects a host path, command or URL. Start the gateway first so its SQLite schema exists, build the worker image, then run `python3 addons/desk-worker/control.py` with these values loaded by the service manager. Protect both state directories and key-bearing process environment from other host users. One worker control service owns this dedicated Docker host and its labeled attempt resources.

The service requires a constant-time checked control bearer token on every endpoint. A gateway capability cannot authenticate to control. Requests have a 32 KiB body limit, timeout, strict operation allowlist and no chunked framing. It exposes:

| Operation | Contract |
|---|---|
| `POST /v1/capabilities/issue` | `{spec}`; exact desk/v1 WorkerSpec, corpus and limits validation; returns short-lived capability |
| `POST /v1/attempts/start` | `{spec, capability}`; requires exact persisted spec/token binding; idempotent active attempt |
| `GET /v1/attempts/:attempt` | Durable status and bounded result metadata |
| `POST /v1/attempts/:attempt/cancel` | `{}`; revoke then stop; idempotent |
| `POST /v1/attempts/:attempt/revoke` | `{}`; same revoke-and-stop behavior; idempotent |
| `GET /v1/attempts/:attempt/artifact` | Completed result only, opaque reference, verified SHA-256 and bounded Base64 bytes |

Each attempt ID binds one immutable spec. Capabilities bind model, tools, exact corpus, plan/acceptance digests, micro-USD budget, output limit and expiry. Current research execution requires exactly three safe corpus references, search permission, USD atomic budget, a configured model, maximum one-hour lifetime/runtime and at most 16,000 output tokens. Corpus symlinks, unknown references, changed digests and path traversal are denied. This is a deterministic research worker; it does not generate anime/video.

Control takes a singleton startup lock, verifies Linux/Docker/gateway readiness, removes orphan containers and networks, revokes existing leases and marks issued/starting/running attempts failed before accepting new starts. Completed approved artifact metadata remains readable across restart and is revalidated on fetch. Never restart into an optimistic running state. Orphan cleanup or revocation failure prevents starts. The gateway SQLite file must be the actual file used by the gateway container, not a copied or separate database.

Output retrieval follows only the runner's completed allowlisted `result/result.md` reference under its configured state root. Symlinks, path escapes, empty/oversized output, wrong media type and hash mismatch fail closed. The HTTP response uses an opaque `desk-worker:<attempt>` reference rather than a host path. Node independently verifies its decoded bytes again. No artifact is published by this service.

## Node host bridge

`server/desk/worker/control.ts` exports `TrustedWorkerBridge`. Trusted runtime composition supplies `{url, token}` with HTTPS for remote control or HTTP on loopback. The bridge implements both `DeskRunner` and `CapabilityIssuer`; use it as `runner` and `capabilities`, and supply `artifactBytes: ref => bridge.artifactBytes(ref)` in `DeskServiceOptions`. An optional full `WorkerResult` argument additionally binds the expected artifact hash. The orchestrator still compares fetched bytes to its approved result hash.

The bridge disallows redirect following, arbitrary attempt paths and URL/filesystem artifact references, bounds request/response bytes and time, checks status/result shapes and treats outages as unavailable. Capabilities and the control token remain server-only. Configuring this adapter does not establish live isolation: Linux/Docker/firewall, gateway deployment and a real container denial/cleanup run still need deployment verification.

Focused checks: `python3 -m pytest worker/tests/test_control.py` and `npm test` from this package root. The known stalled concurrent gateway-budget test may be excluded with an explicit recorded reason; do not call that a passing full suite.
