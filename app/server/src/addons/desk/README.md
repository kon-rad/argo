# Hiring Desk orchestration and public integration

Status: **blocked for live operation**. ERC-20 settlement, the server RPC reader, durable receipt reservation, the narrow public API and explicit boot configuration are implemented. The concrete host runtime and hash-only Arc-to-Arkiv payment evidence bridge remain unresolved. See [submission evidence and limitations](submission/README.md).

## Public client boundary

The Vercel client uses `/api/desk/public`. It loads accepted terms with `GET /jobs/:ref/payment` and sends only `{txHash}` to `POST /jobs/:ref/payments/verify` or `/reconcile`. The engine resolves the provider identity and accepted offer itself. A pending hash is persisted only after its independently read transaction matches the accepted payer, token, zero native value and exact calldata. Pending hints never establish payment. The router enforces the configured browser origin, request limits and rate limits, and exposes no operator or generic vault routes.

Public job/offers reads, job/acceptance publications and payment preparation are also available. Job and acceptance publication require exact `desk/v1` records and bounded idempotency keys. The configured public store must authenticate actual chain authorship. Operator controls remain under session-gated `/api/desk`.

The P3 package provides an injectable private orchestration service, session-gated operator router, and Postgres persistence for assignment revisions, idempotency responses, audit events, and one-time payment receipt allocation. It consumes the frozen `@secondbrain/desk-contracts/desk` desk/v1 types. This package deliberately does not register a feature manifest or touch central configuration; the integration lead owns those paths.

## Injection seams

`DeskOrchestrator` takes a `DeskServiceOptions` object. `DeskPersistence`, `DeskSnapshots`, `DeskPublicStore`, `DeskIdentity`, `DeskRunner`, `DeskPublisher`, `DeskSettlement`, `CapabilityIssuer`, provider eligibility, provider transaction preparation and exact-byte artifact reads are injected. `MemoryDeskPersistence` supports fixture/service development. `PgDeskPersistence` uses the app's database pool and `withTransaction` by default. Production boot must reject any adapter whose mode is `fixture`.

The private router is created with `deskOperatorRouter(api, sessionGate)`. It throws if a gate is absent and applies it to every route. It exposes inbox, jobs, provider lookup, approve, decline, cancel, preview, dispatch, claim reconciliation, runner reconciliation, release, and payment reconciliation. The integration owner mounts this router under `/api/desk` behind the module feature's existing session boundary.

## State and recovery

Each assignment aggregate has a monotonic revision. Mutation idempotency responses and audit events commit in the same transaction as the aggregate. Mutations lock their assignment row and reject stale revisions. A unique payment receipt allocation prevents one verified receipt from being assigned to two jobs. External calls happen after a durable assignment mutation and are reconciled through their injected adapters.

Approval binds the accepted public digest and worker execution limits. Provider choices are filtered through `DeskIdentity.resolve` and must match the configured wallet, skill version and payment address. Dispatch reserves an attempt and immutable worker spec before asking the provider wallet to publish a claim. Only a finalized claim observation with the expected provider and execution ID permits runner start. Repeated dispatch with the same idempotency key returns the same reserved attempt. Cancellation persists first, then revokes the capability and requests runner stop. Worker output remains in review until the operator release action.

## Provider authoring constraint and P2 integration requirement

The frozen contract requires the public claim and delivery entities to be authored by the configured provider wallet. The server does not sign on behalf of a provider, and worker capabilities cannot publish. `ProviderTransactionIntents` must therefore prepare an unsigned wallet transaction for the provider. A finalized provider-authored claim is required before runner start. Release validates exact artifact bytes against the reviewed SHA-256, then returns the provider-authored delivery transaction intent to the operator client; it does not mark the assignment released until the finalized public snapshot includes the matching delivery. `updatePublicState` performs that transition.

P2 must provide a concrete `ProviderTransactionIntents` implementation (or an equivalent wallet-facing API) for Claim and Delivery, plus complete verified snapshots that include entity references and immutable creators. A generic server-side `DeskPublisher.publish` that signs as the server is not a valid substitute. The frozen `DeskOperatorApi.release` return type does not represent a wallet transaction intent; P7/P9 must consume the extra `transactionIntent` response field or version the shared contract before integration. The `Claim` object lacks its own ref, so P3 resolves that ref only by matching the verified observation's execution ID.

Acceptance and offer digests use the P1 canonical digest implementation. A failed, pending or incomplete public read never becomes an empty successful observation set or an advancement of state. Public chain records remain authoritative; private aggregates only store the operator lifecycle and a cached verified snapshot.

## Migration

`app/db/migrations/1756000017000_hiring-desk.sql` creates the private assignment aggregate, mutation idempotency, audit and payment-allocation tables. It is forward-only and was reserved on the G0 base. No production database was accessed or migrated by this package.

## Not included

The concrete host bindings for Arkiv/Swarm/identity/worker services, capability cryptography, provider wallet UI and live deployment remain prerequisites. The engine now supplies manifest/configuration integration and real native/ERC-20 settlement with an independent RPC reader. No server signing key or worker token is accepted for public Claim/Delivery publication.

## Production boot contract

`bootDesk()` runs before the HTTP listener. It returns immediately when `desk` is disabled. Enabled boot validates explicit payment settings, loads the trusted local `DESK_RUNTIME_MODULE`, and requires its `createDeskRuntime({domain, persistence})` export to return the live `DeskHostRuntime` described in `boot.ts`. The module path is server configuration, never request input. Treat this module as privileged server code and keep it outside the public repository when it contains deployment-specific wiring.

The engine constructs `PgDeskPersistence`, a read-only `ArcJsonRpcReader`, the explicitly selected ERC-20 or native settlement adapter and `DeskOrchestrator`. The settlement callback checks the accepted assignment binding before reserving a chain/transaction/log identity in PostgreSQL. Fixture marketplace, identity, worker, publisher, snapshot, provider-transaction or capability adapters are rejected in every boot mode. There is no production in-memory receipt ledger.

The RPC reader checks JSON-RPC envelopes and hashes, bounds responses, rejects redirects, and requires finalized canonical block inclusion. Missing receipt data remains pending. Unsupported finality reads or RPC errors fail closed as unavailable through the settlement adapter. It never signs or sends a transaction.

This boot composition does not supply the missing host implementations. A usable runtime still needs a concrete Arkiv SDK client with trusted creator/finality and atomic publication idempotency, real ENS/ERC-8004 readers and configured deployments, a durable Swarm publication ledger and release authorization, provider-authorized unsigned claim/delivery transactions, and an authenticated bridge plus capability issuer for the isolated Linux worker. No such host runtime or deployment was verified in this change. Until these are supplied, production integration and the live end-to-end test are blocked.
