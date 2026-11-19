# Hiring desk addon

The hiring desk is an optional product package extracted from the second-brain engine. It owns the server implementation, browser console, wire contracts, client and Arkiv packages, public site, bounded worker, ENS tooling, tests and supporting docs.

## Install in a second-brain checkout

```bash
cd app
npm install @secondbrain/hiring-desk
npm run build
secondbrain doctor
```

Then add `desk` to the vault's addon list and configure the `DESK_*` settings documented in the engine. A disabled desk does not load this package or make network connections. An enabled desk fails startup with an install command when the package is absent.

## Develop and test this package

```bash
cd addons/hiring-desk
npm ci
npm run build
npm test
```

The single `vitest.config.ts` contains server, contracts and browser projects. PostgreSQL integration tests remain opt-in through `DESK_TEST_DATABASE_URL` and `DESK_PUBLICATION_TEST_DATABASE_URL`, each restricted to a disposable `sb_*_test` database. The Python worker suite runs as part of `npm test`.

The engine host supplies database query and transaction adapters through the lifecycle hook. The package does not import engine source. Two forward-only engine migrations remain in the host because existing installations already record their migration history.

## Private operator views

The `/desk` page keeps the legacy Overview, Inbox, Jobs and Agents views. Active and Review filter the existing job list by execution status; they do not create another job state or change approval and release. A board card with `contract.cybazaarJobId` gets a Cybazaar source label. A separate `contract.deskJobRef` adds a link to `/desk?job=<ref>` when a bridge knows the operator assignment ID, which is the Arkiv job reference. The marketplace ID alone does not imply that mapping. Cards without the Cybazaar marker keep their standard appearance. The legacy release action still publishes its public destination; it is not a pay-to-unlock release.

## Cybazaar backend publication

The production composition owns Arkiv and Swarm publication in the server process. `DESK_ARKIV_PRIVATE_KEY` is a master signer key held only by the service environment. It is never included in routes, unsigned wallet intents, worker capabilities, logs or audit details. The signer can publish only a `desk/v1` record whose frozen creator field equals its derived address. This supports signer-owned Cybazaar jobs and signer-owned reviewed responses without allowing the backend to impersonate another provider. Other provider records keep the existing browser wallet path.

The trusted `DESK_RUNTIME_MODULE` now exports `createCybazaarDependencies({domain, persistence})` for the remaining operational seams: configured provider profiles, ENS resolution, the bounded worker runner, capability issuance, exact artifact reads and unsigned transaction preparation for non-master providers. The addon constructs the Arkiv SDK writer/reader, finalized snapshots, ERC-8004 reader, PostgreSQL publication ledger, Bee client, hash/readback checks and reviewed publisher. Signer-owned job, offer and acceptance records enter through session-gated `POST /api/desk/publications`; signer-backed stores refuse the unauthenticated public write routes. Job brief Markdown is replaced by its verified `swarm://` reference before Arkiv publication. Production boot rejects the legacy all-injected runtime and fails closed when any concrete publication setting is absent.

| Setting | Purpose |
|---|---|
| `DESK_ARKIV_RPC_URL`, `DESK_ARKIV_CHAIN_ID` | HTTPS Arkiv RPC and exact numeric network |
| `DESK_ARKIV_PRIVATE_KEY` | Server-only 32-byte EVM signer key |
| `DESK_ARKIV_LIFETIME_BLOCKS` | Immutable entity lifetime, bounded to 1,296,000 blocks |
| `DESK_BEE_URL`, `DESK_BEE_POSTAGE_BATCH_ID` | HTTPS Bee endpoint (loopback HTTP is allowed) and funded 32-byte batch ID |
| `DESK_IDENTITY_RPC_URL`, `DESK_IDENTITY_CHAIN_ID`, `DESK_ERC8004_REGISTRY_ADDRESS` | Finalized identity RPC and selected ERC-8004 deployment |
| `DESK_ENS_RPC_URL`, `DESK_ENS_CHAIN_ID` | HTTPS endpoint and chain required from the operational ENS resolver |
| `DESK_IDENTITY_METADATA_HOSTS` | Comma-separated HTTPS metadata hostname allowlist |
| `DESK_TRANSPORT_TIMEOUT_MS` | External-call deadline, 100 to 30,000 ms |
| `DESK_MAX_RESPONSE_BYTES`, `DESK_MAX_ARTIFACT_BYTES` | RPC and Markdown readback byte limits |
| `DESK_PUBLICATION_DESTINATION` | Allowed public reference prefix; this slice requires `swarm://` |

Arkiv writes use canonical `desk/v1` bytes and indexed idempotency hashes. An uncertain write is never blindly repeated: retrying the same key first scans finalized records, same-key changed bytes are rejected, and confirmation is recovered from the canonical creation event and receipt. The legacy desk/v1 publisher accepts Markdown only, rejects redirects and encrypted/key-bearing references, read back through the configured endpoint, and compare SHA-256 before publishing a `swarm://` delivery. The reviewed release must bind the exact content-addressed `swarm://<64-hex-reference>`; publication rejects a Bee reference that differs from that approval. PostgreSQL checkpoints make upload and delivery retries restart-safe.

For the legacy desk/v1 path, live prerequisites still outstanding are a funded Arkiv signer, a funded Bee postage batch with a retention plan, a verified ENS resolver supplied by the operational module, real provider/ENS/ERC-8004 configuration, a trusted pre-release step that derives or stages the exact Swarm reference for operator approval, the isolated worker control services, and a live end-to-end publication/finality run. Tests use fake transports and do not publish or hold a real key.


## Separate Base pay-to-unlock marketplace

The optional `cybazaar/v1` marketplace uses PostgreSQL `cyba_*` tables and
server-attested Arkiv evidence. It preserves the existing `desk/v1` protocol and
Arc settlement. Set `CYBA_MARKET_ENABLED=true` only with the `desk` addon enabled.
Without that flag the new runtime does not connect to its database or networks.

Configure `CYBA_ENVELOPE_SECRET` (at least 32 bytes, shared server-side with the
Bun gateway), `CYBA_ARTIFACT_ROOT` (absolute private staging root),
`CYBA_BASE_RPC_URL`, `CYBA_EXECUTION_AGENT`, and `CYBA_PROFILES_JSON` (an array
containing exactly one service with `id`, `name`, `serviceTitle`, `description`,
`priceAtomic`, `payoutWallet`, `ownerWallet`, `ensName`, and `agentId`). Price is a
positive decimal string of atomic six-decimal USDC units within uint256 bounds.
The profile is unavailable until independent finalized ERC-8004 reads and ENS
resolution match its configured owner and payout wallet. A configured
`identityBound` boolean is never accepted as evidence.

Reuse `DESK_DOMAIN`, the Arkiv writer/network/lifetime settings, Bee endpoint and
funded postage batch, identity RPC/chain/registry/metadata allowlist, and ENS
RPC/chain settings from the existing addon. The Base marketplace does not require
legacy Arc chain/payment settings. Built-in ENS support is restricted to the
explicitly supported chain; unsupported configurations fail closed. A trusted
`DESK_RUNTIME_MODULE` can override the resolver through
`createCybaMarketDependencies({ domain, ensRpcUrl, ensChainId })`, returning
`{ ens }` with matching `rpcUrl`, `chainId`, `normalizeName` and `resolveAddress`.
It must implement real supported normalized reads; a fixture resolver is not a
production prerequisite substitute.

The fixed client API is `/api/desk/market/agents`, `/jobs`, `/jobs/:id`,
`/jobs/:id/payment-terms` and `/jobs/:id/payment`. The gateway keeps wallet auth
local and signs allow-listed requests using a 60-second HMAC envelope bound to
method, full path, body digest, wallet and timestamp. Job reads require that same
authenticated wallet. Owner routes live under `/api/desk/market/operator` and
always require the existing owner session; gateway credentials cannot authorize
them. The reviewed MP4 preview route is owner-only and rejects a stale `hash`
query before streaming private bytes.

One hire creates one unassigned triage card. Owner approval permits the ordinary
board workflow. Stage a private MP4, inspect the exact bytes, then Release its
hash and reviewed summary. No Swarm reference is public at Release. A submitted
payment hash is persisted independently from a verified receipt, so reloads and
RPC outages reconcile that hash instead of requesting another transfer.

Verified Base payment is durably reserved before upload. An interrupted upload
with no known reference is never automatically repeated; the owner can use
`POST /operator/jobs/:id/reconcile-delivery` with `{ reference }`, which downloads
and matches the reviewed hash. Arkiv outbox effects similarly retain uncertain
writes and use finalized readback rather than duplicate submission. Only the
paid, downloaded and attested projection exposes `downloadRef` and proof refs.
After publication the Swarm reference is public; this is pay-to-first-release,
not persistent per-viewer access control or escrow.

Run market tests with an isolated local scratch database named `sb_*_test` on a
non-master port using `CYBA_TEST_DB_URL`. Each test creates an independent schema.
These controlled tests do not establish a funded paid job, current identity
binding, funded postage or deployed revision health.
