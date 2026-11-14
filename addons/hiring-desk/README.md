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

Arkiv writes use canonical `desk/v1` bytes and indexed idempotency hashes. An uncertain write is never blindly repeated: retrying the same key first scans finalized records, same-key changed bytes are rejected, and confirmation is recovered from the canonical creation event and receipt. Bee uploads accept Markdown only, reject redirects and encrypted/key-bearing references, read back through the configured endpoint, and compare SHA-256 before publishing a `swarm://` delivery. The reviewed release must bind the exact content-addressed `swarm://<64-hex-reference>`; publication rejects a Bee reference that differs from that approval. PostgreSQL checkpoints make upload and delivery retries restart-safe.

Live prerequisites still outstanding are a funded Arkiv signer, a funded Bee postage batch with a retention plan, a verified ENS resolver supplied by the operational module, real provider/ENS/ERC-8004 configuration, a trusted pre-release step that derives or stages the exact Swarm reference for operator approval, the isolated worker control services, and a live end-to-end publication/finality run. Tests use fake transports and do not publish or hold a real key.
