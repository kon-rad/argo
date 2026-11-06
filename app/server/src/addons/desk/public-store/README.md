# Desk public records and publication boundary

This package implements the desk/v1 public-store guard layer and reviewed markdown publication flow. Arkiv and Bee client instances are injected by the host. This branch deliberately does not add runtime dependencies or select a network, RPC endpoint, signer, schema registry, postage batch, or finality policy.

## Arkiv adapter contract

The host's `ArkivDeskClient` must implement the selected SDK using schema-tagged reads and writes. Reads must return the immutable `$creator`, entity key, authoritative timestamp, expiry, snapshot block, and a finality assertion. Expiry and timestamps are Unix seconds at this boundary; Arkiv itself expresses expiry in blocks. A query page uses `$key ASC` with `$key > cursor`, pinned to one snapshot. Any incomplete page, moving snapshot, unknown schema, expired entity, creator mismatch, or unfinalized result fails the read.

The public-store guard checks the expected author for each record type: provider owner, job client, offer/claim/delivery provider, acceptance client, and payment payer. It validates the exact desk/v1 record shape and chain/domain before exposing an observation. `reducePublicState` remains responsible for cross-record relations and conflicts.

Writes are retried by an idempotency key and compared against the prior canonical record. The concrete SDK host must back `findByIdempotencyKey` and `create` with a durable atomic reservation or deterministic signed transaction. A read-then-create query without a reservation is not concurrency-safe. Unknown transaction outcomes remain pending/unavailable until `confirmation` can reconcile them.

The reducer requires provider-authored claims and deliveries. Therefore a broker deployment cannot sign these writes with an unrelated broker key. It needs a provider wallet authorization/transaction-intent path, or a reviewed versioned contract change that allows a separate trusted publisher creator. Worker capabilities are never sufficient authorization.

## Swarm publication

`BeeHttpSwarmGateway` uses Bee's `/bzz` upload/download API with an explicitly configured postage batch. The host must supply an upload-capable Bee node and funded batch. Upload accepts bounded markdown bytes only; the publisher downloads the returned hash, recomputes SHA-256 over the exact bytes, and refuses to write a delivery record if they differ. Public references are bare 64-character lowercase content hashes wrapped as `swarm://…`; encrypted references carrying access keys are rejected.

`PublicationLedger` must be backed by durable transactional storage. It atomically binds the idempotency key to claim, artifact hash, media type, and destination, then checkpoints the upload reference and delivery entity reference. After timeouts, retry or `reconcile` with the same key. A changed binding is denied. The `ReleaseAuthorization` and `TrustedClaimResolver` adapters must verify trusted operator approval and the finalized provider-authored claim before publication.

## Verification and source docs

The adapter logic and retry boundaries are tested with synthetic Arkiv rows, mocked Bee calls, and an injected ledger. These tests do not establish live network compatibility.

- Arkiv's official [TypeScript SDK query docs](https://docs.arkiv.network/typescript-sdk/querying-data/) identify `$creator` as the immutable entity creator and distinguish it from `$owner`.
- Arkiv's official [pagination guide](https://docs.arkiv.network/querying/paginate/) documents a 100-row page maximum, stable keyset paging, and why offset pages can shift between requests.
- Arkiv's official [expiry guide](https://docs.arkiv.network/writing/expiration/) documents block-based expiry and the entity's `$expiresAt` field.
- Swarm's official [upload and download guide](https://docs.ethswarm.org/docs/develop/upload-and-download/) requires a postage batch for upload and documents Bee's `/bzz` upload and download API.

Unverified live prerequisites: exact Arkiv network and SDK version, schema/index definitions, trusted signer/provider transaction flow, finality threshold and timestamp conversion, Bee endpoint, funded postage batch, and production ledger/authorization implementations.
