# Live Arkiv desk codec and reader

This isolated package supplies real unsigned EVM calldata and read-only RPC integration for desk/v1. It pins `@arkiv-network/sdk` **1.0.1** and `viem` **2.38.2**; the main app dependencies and lockfile are untouched. It never holds a signing key or sends a transaction.

## Reviewed wire contract

Named schema: `argo.hiring-desk.v1`. Every record type (provider, job, offer, acceptance, claim, delivery, payment evidence) uses the same six attributes:

| Attribute | Type | Indexed | Contents |
|---|---|---|---|
| `arkiv.schema` | str | yes | `argo.hiring-desk.v1` |
| `domain` | str | yes | Configured desk domain, at most 128 UTF-8 bytes |
| `recordType` | str | yes | Exact desk/v1 record discriminator |
| `record` | bytes | no | Canonical sorted-key UTF-8 JSON, at most 128 KiB |
| `idem` | str | yes | Keccak-256 of the nonsecret idempotency key |
| `recordDigest` | str | yes | Keccak-256 of the complete canonical desk/v1 record |

SDK 1.0.1 limits strings to 128 bytes. JSON is therefore **bytes**, not a string or an undocumented legacy payload. Reads reject duplicate/unknown attributes, noncanonical JSON, mismatched digest/type/domain, mutable entities and ownership transfers. The record's declared signer must match the immutable creator. All writes permanently set `readonly` and leave permissionless extension off.

The codec uses the actual SDK 1.0.1 create ABI: Arkiv address `0x4400000000000000000000000000000000000044`, `execute` selector `0x49650044`, Create operation `1`, absolute block expiry, and zero transaction value. Tests compare the complete calldata byte-for-byte with the installed SDK's public `createEntity` through a mocked transport. No test publishes anything.

## Unsigned preparation

```js
import { LiveArkivDeskClient } from '@secondbrain/desk-arkiv/reader';
const client = new LiveArkivDeskClient({
  rpcUrl: process.env.DESK_ARKIV_RPC_URL,
  domain: process.env.DESK_DOMAIN,
  chainId: Number(process.env.DESK_ARKIV_CHAIN_ID),
});
// record and expiry must be loaded from authoritative accepted/operator-approved terms.
const prepared = await client.prepare(record, idempotencyKey, expiresAtBlock);
// Show exact prepared.transaction, signer, chain and bindings; browser wallet signs after a click.
```

`prepareRecordTransaction(record, context)` is the browser-safe pure codec export. Its context explicitly includes domain, numeric chain ID, signer, idempotency key, current block, absolute expiry block and independently loaded entity nonce. It returns an EIP-1193 transaction (`from`, `to`, `data`, `value`) plus chain ID, record digest, idempotency hash and a **predicted** entity reference. The entity nonce can change before mining; a prediction is never confirmation. The caller must reconcile the actual event/record after signing and retain its own durable reviewed-intent binding.

The salt is deterministic from the idempotency key. This permits exact retries but is **not on-chain uniqueness enforcement**: nonce changes can produce another entity. The host must serialize conflicting attempts and reject duplicate intents/records. Preparation refuses an already finalized matching idempotency record; pending or inconsistent lookup is unavailable, not permission to create another record. This package does not implement operator authentication, transaction-intent persistence or signer-session management.

## Concrete read interface

`LiveArkivDeskClient` provides `page`, `get`, `findByIdempotencyKey` and `confirmation` compatible with the engine's `ArkivDeskClient` shapes. `create` explicitly fails with browser signature required. All reads verify RPC chain, schema/domain, creator/owner, readonly attributes, expiry and finality.

Pages use `$key ASC` and `$key > cursor`. Since raw RPC cannot pin query pages, `atBlock` rejects any snapshot change rather than silently joining different blocks. The snapshot may finalize after the query; the final head must cover it, and a canonical block-hash recheck must agree. Single-entity reads require the same latest block before and after fetching. Pending finality stays `finalized: false`; pending idempotency lookup fails explicitly. A malformed matching-schema row denies the scan, an intentional fail-closed availability trade-off.

`createdAt` is the actual creation block's Unix timestamp. `expiresAt` in the returned engine row is a **projection** from snapshot timestamp and remaining blocks using the SDK's nominal two-second block time. It is not a guaranteed wall-clock deadline. Actual expiration is checked against block heights; desk/v1 offer and job deadlines remain their own authoritative Unix terms.

`confirmation` obtains the actual creation transaction hash through a matching `EntityCreated` event and successful receipt in the canonical creation block. It never invents a hash or reports an unsigned prepared transaction as confirmed. Public RPC is a trusted read source; this is not a cryptographic light client.

## Setup and verification

From this package:

```sh
npm ci
./node_modules/.bin/tsc -p ../../app/shared/tsconfig.json --lib ES2022,DOM
npm test
npm run build
```

The shared contracts must be built before importing the package. Runtime values are configuration, not compiled personal defaults. Read-only Rabdi chain check returned `0x76edaf` (7794095) on 2026-11-07. This establishes RPC chain connectivity only: no wallet funding, publication, finalized real job, Swarm output, payment receipt or live E2E is claimed.

This is an independent merged-main slice. Composition into the pending wallet/public API PRs, concrete authenticated endpoints, delivery publishing and the payment evidence bridge remain separate integration work.

Primary references: [raw transaction ABI](https://docs.arkiv.network/json-rpc/mutating-entities/), [read RPC](https://docs.arkiv.network/json-rpc/querying-data/), [creation flags](https://docs.arkiv.network/writing/create/), and the published npm SDK 1.0.1 source (`entity/operations.ts`, `schema/codec.ts`, `schema/types.ts`, `consts.ts`). The ABI encoders are not public SDK exports, so this module implements the documented ABI using viem and tests it against the actual SDK public operation.
