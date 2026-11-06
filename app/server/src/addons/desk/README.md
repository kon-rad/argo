# Hiring Desk private orchestration (P3)

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

Central manifest wiring, module configuration, real Arkiv/Swarm/identity/runner/payment adapters, capability cryptography, provider wallet UI, live chain verification and deployment belong to integration packages. No server signing key or worker token is accepted for public Claim/Delivery publication.
