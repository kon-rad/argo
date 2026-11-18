# Hiring Desk orchestration and public integration

Status: **concrete Cybazaar publication runtime implemented; live prerequisites remain**. The server now composes the installed Arkiv SDK writer/reader, Bee/Swarm publication with readback, PostgreSQL checkpoints, ERC-8004 identity reads, orchestration and routes. The hash-only Arc-to-Arkiv payment evidence bridge and live funded deployment remain unresolved. See [submission evidence and limitations](submission/README.md).

## Public client boundary

The Vercel client uses `/api/desk/public`. It loads accepted terms with `GET /jobs/:ref/payment` and sends only `{txHash}` to `POST /jobs/:ref/payments/verify` or `/reconcile`. The engine resolves the provider identity and accepted offer itself. A pending hash is persisted only after its independently read transaction matches the accepted payer, token, zero native value and exact calldata. Pending hints never establish payment. The router enforces the configured browser origin, request limits and rate limits, and exposes no operator or generic vault routes.

Public job/offers reads, job/acceptance publications and payment preparation are also available. Job and acceptance publication require exact `desk/v1` records and bounded idempotency keys. The configured public store must authenticate actual chain authorship. Operator controls remain under session-gated `/api/desk`.

The P3 package provides an injectable private orchestration service, session-gated operator router, and Postgres persistence for assignment revisions, idempotency responses, audit events, and one-time payment receipt allocation. It consumes the frozen `@secondbrain/desk-contracts/desk` desk/v1 types. This package deliberately does not register a feature manifest or touch central configuration; the integration lead owns those paths.

## Injection seams

`DeskOrchestrator` takes a `DeskServiceOptions` object. `DeskPersistence`, `DeskSnapshots`, `DeskPublicStore`, `DeskIdentity`, `DeskRunner`, `DeskPublisher`, `DeskSettlement`, `CapabilityIssuer`, provider eligibility, provider transaction preparation and exact-byte artifact reads are injected. `MemoryDeskPersistence` supports fixture/service development. `PgDeskPersistence` uses the app's database pool and `withTransaction` by default. Production boot must reject any adapter whose mode is `fixture`.

The private router is created with `deskOperatorRouter(api, sessionGate)`. It throws if a gate is absent and applies it to every route. It exposes inbox, jobs, provider lookup, approve, decline, cancel, preview, dispatch, claim reconciliation, runner reconciliation, release, and payment reconciliation. The integration owner mounts this router under `/api/desk` behind the module feature's existing session boundary.

Signer-owned job, offer and acceptance publication uses `POST /api/desk/publications` under that same session gate. A signer-backed public store returns 403 from unauthenticated job/acceptance write routes. Job briefs are treated as untrusted Markdown data, uploaded to Bee with bounded transport, read back and SHA-256 checked, then replaced by the resulting `swarm://` reference before canonical Arkiv publication.

## State and recovery

Each assignment aggregate has a monotonic revision. Mutation idempotency responses and audit events commit in the same transaction as the aggregate. Mutations lock their assignment row and reject stale revisions. A unique payment receipt allocation prevents one verified receipt from being assigned to two jobs. External calls happen after a durable assignment mutation and are reconciled through their injected adapters.

Approval binds the accepted public digest and worker execution limits. Provider choices are filtered through `DeskIdentity.resolve` and must match the configured wallet, skill version and payment address. Dispatch reserves an attempt and immutable worker spec before asking the provider wallet to publish a claim. Only a finalized claim observation with the expected provider and execution ID permits runner start. Repeated dispatch with the same idempotency key returns the same reserved attempt. Cancellation persists first, then revokes the capability and requests runner stop. Worker output remains in review until the operator release action.

## Provider authoring constraint and narrow backend authority

The frozen contract requires public records to be authored by the wallet named in each record. The configured server master signer may publish only when that creator field equals its own derived address. This is the first Cybazaar slice: signer-owned job requests and signer-owned offers, claims, acceptances and reviewed deliveries can use the backend. The server cannot sign on behalf of any different provider. Those providers continue through `ProviderTransactionIntents` and browser signing. Worker capabilities never contain the signer or publish directly. A finalized creator-bound claim is still required before runner start, and release remains in review until the matching finalized delivery is read back.

P2 must provide a concrete `ProviderTransactionIntents` implementation (or an equivalent wallet-facing API) for Claim and Delivery, plus complete verified snapshots that include entity references and immutable creators. A generic server-side `DeskPublisher.publish` that signs as the server is not a valid substitute. The frozen `DeskOperatorApi.release` return type does not represent a wallet transaction intent; P7/P9 must consume the extra `transactionIntent` response field or version the shared contract before integration. The `Claim` object lacks its own ref, so P3 resolves that ref only by matching the verified observation's execution ID.

Acceptance and offer digests use the P1 canonical digest implementation. A failed, pending or incomplete public read never becomes an empty successful observation set or an advancement of state. Public chain records remain authoritative; private aggregates only store the operator lifecycle and a cached verified snapshot.

## Migration

`app/db/migrations/1756000017000_hiring-desk.sql` creates the private assignment aggregate, mutation idempotency, audit and payment-allocation tables. It is forward-only and was reserved on the G0 base. No production database was accessed or migrated by this package.

## Not included

Deployment-specific provider profiles, the ENS resolver, isolated worker services, capability cryptography, provider wallet UI and live deployment remain prerequisites. The concrete runtime now owns Arkiv/Swarm/ERC-8004 composition and may publish a Claim or Delivery only when its configured signer is the record's frozen provider. Other providers remain on the unsigned wallet path. A trusted pre-release step must derive or stage the exact content-addressed Swarm URI before the operator approves it; the backend rejects any upload whose returned reference differs.

## Production boot contract

`bootDesk()` runs before the HTTP listener. It returns immediately when `desk` is disabled. Enabled boot validates explicit payment settings, loads the trusted local `DESK_RUNTIME_MODULE`, and requires its `createDeskRuntime({domain, persistence})` export to return the live `DeskHostRuntime` described in `boot.ts`. The module path is server configuration, never request input. Treat this module as privileged server code and keep it outside the public repository when it contains deployment-specific wiring.

The engine constructs `PgDeskPersistence`, a read-only `ArcJsonRpcReader`, the explicitly selected ERC-20 or native settlement adapter and `DeskOrchestrator`. The settlement callback checks the accepted assignment binding before reserving a chain/transaction/log identity in PostgreSQL. Fixture marketplace, identity, worker, publisher, snapshot, provider-transaction or capability adapters are rejected in every boot mode. There is no production in-memory receipt ledger.

The RPC reader checks JSON-RPC envelopes and hashes, bounds responses, rejects redirects, and requires finalized canonical block inclusion. Missing receipt data remains pending. Unsupported finality reads or RPC errors fail closed as unavailable through the settlement adapter. It never signs or sends a transaction.

Production boot uses `createCybazaarBackend` for Arkiv, finalized snapshots, ERC-8004 identity, PostgreSQL publication checkpoints, Bee readback and reviewed delivery publication. The runtime module supplies only deployment-specific providers, ENS resolution, isolated worker/capability services, artifact reads and unsigned transactions for non-master providers. Production rejects fixture/in-memory adapters and rejects the legacy fully injected runtime. Remaining live prerequisites are funded Arkiv/Bee accounts, verified endpoint/deployment values, the operational module, and a real end-to-end finality run. No live key or network publication is required by the test suite.

## Provider browser wallet signing

The private Desk exposes `claim/prepare`, `claim/intent`, `claim/submit`,
`claim/reconcile` and matching `release/*` routes under `/api/desk/jobs/:id`.
All require the existing operator session. Prepare uses the approved immutable
execution specification or reviewed release binding, never browser-supplied
provider, amount, chain or calldata. `desk-wallet/v1` intents are stored in the
assignment aggregate with an opaque reference, expiry and execution/acceptance
binding. GET intent resumes the same review after reload; submit accepts only
`intentRef` and `txHash` and records pending. A hash is a recovery hint, never
proof of claim, delivery or payment. Concurrent submissions cannot replace it.

The provider transaction adapter must return an unsigned EVM transaction
`{ to, data, value? }` and an explicit decimal or hexadecimal EVM chain ID.
Its idempotency key must identify identical transaction payloads on retries.
Only `from`, `to`, `chainId`, `data` and integer `value` reach the browser wallet.
Unsupported adapter-specific transaction shapes return unavailable rather than
being coerced into an EVM transfer. The concrete Arkiv SDK composition handles
only records owned by the configured backend signer. Other providers still require
the host wallet adapter, funded browser wallets and a configured worker.

The browser asks for account access after a click, shows the exact signing
binding and calldata, blocks wrong account/network and detects wallet changes.
A nonsecret session-storage hint retains the hash if server submission fails;
reloading or retrying that hint never establishes confirmation. Claim finality
starts the worker only through the existing verified reducer gate. Release
requires the exact provider-authored claim, artifact hash, media type and public
destination. Operator release publishes only for a matching configured backend
signer; all other providers still sign the delivery themselves.
Expired intents fail closed and require operator intervention; automatic expiry
renewal, transaction replacement and live client posting/acceptance are outside
this independent provider slice.
