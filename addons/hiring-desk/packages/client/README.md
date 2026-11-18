# Public desk client

`@secondbrain/desk-client` implements the frozen `DeskClient` contract in `@secondbrain/desk-contracts/desk`. It has no server, database, login, secret or RPC implementation. All HTTP calls are restricted to `/public/*`; failed and pending reads stay explicit `Result` values.

## Use

```js
import { PublicHttpDeskClient } from '@secondbrain/desk-client';

const client = new PublicHttpDeskClient('https://public-desk.example');
const jobs = await client.discover();
const offerList = await client.offers('arkiv:CHAIN_ID/ENTITY_ID');
const state = await client.inspect('arkiv:CHAIN_ID/ENTITY_ID');
const evidence = await client.independentRead('arkiv:CHAIN_ID/ENTITY_ID');
```

`post(job, idempotencyKey)`, `accept(acceptance, idempotencyKey)` and `preparePayment(intent)` use the desk/v1 wire shapes without copying schemas. For injected-wallet authorship, use `postWithWallet(wallet, job, key)` and `acceptWithWallet(wallet, acceptance, key)`. Their explicit wallet interface is `address()` plus `publishRecord(record, idempotencyKey)`; the helper checks the record's declared client against the connected wallet and turns user rejection into a recoverable `denied` result. The injected chain integration must publish the actual public record; a detached signature does not count as execution.

Payment submission requires `submitPreparedTransaction(wallet, intent, prepared)` and the same injected wallet implementing `submit(chainId, transaction)`. The helper checks the accepted payer and chain first. Wallet rejection becomes a recoverable `denied` result. A transaction hash is not payment confirmation.

Public endpoint route shapes used by this adapter are `/public/discover`, `/public/jobs`, `/public/jobs/:ref`, `/public/jobs/:ref/offers`, `/public/acceptances`, `/public/payments/prepare`, and `/public/read/:ref`. These are the adapter boundary expected from integration; this package never calls the operator routes. API wiring and route compatibility require the P2 integration adapter.

## Independent reader

After installing the package alongside `@secondbrain/desk-contracts`, run:

```sh
DESK_PUBLIC_RPC_URL=https://public-rpc.example desk-reader 'chain:network/entity' ./my-chain-reader.mjs
```

The adapter module must export `readPublicEvidence({ rpcUrl, jobRef })` and return `{ observations, verifiedPayments }`. It must return the complete paginated, finalized observations only after independently verifying chain, creator, timestamp, inclusion and finality; payment entries must come from a receipt verifier that independently confirms and reserves the receipt. The command passes both arrays through `reducePublicState`, prints the job, acceptance, artifact hash and payment evidence references, and exits nonzero for an unknown, conflicting or structurally rejected state. A pending payment is reported without claiming it is verified. Do not implement this adapter from unverified event payloads.

A conservative raw Arkiv reader is included as `src/arkiv-reader.mjs`. It checks the RPC chain, immutable creator, matching current owner, immutable (`readonly`) attributes, exact desk/v1 records and domain, block-based entity expiry, creation-block timestamps, keyset ordering and snapshot consistency. It captures the query block, then requires the finalized head to cover it and the canonical snapshot hash to remain unchanged. Pagination drift or pending finality fails explicitly; rerun after finality. It never supplies verified payments, so it cannot establish `paid`.

The SDK-compatible defaults are schema `argo.hiring-desk.v1` and attribute `record` of type `bytes`, containing UTF-8 desk/v1 JSON. SDK 1.0.1 limits `str` values to 128 bytes, so full records must not be encoded as strings. These defaults match the concrete `addons/desk-arkiv` codec; they are **not a claim that an existing deployment uses this representation**. `DESK_ARKIV_SCHEMA` and `DESK_ARKIV_RECORD_ATTRIBUTE` can override the schema/attribute explicitly. A programmatic `recordEncoding: "str"` remains available only for compatible small legacy records and is limited to 128 UTF-8 bytes. Mutable records and transferred ownership are rejected, because an immutable creator field alone cannot prove authorship of later-modified bytes. A malformed or unrelated same-schema row also fails the entire scan rather than producing an incomplete proof; a public schema tag is not an access-control boundary, so this conservative behavior has an availability cost. The old schema-1 draft uses separate attributes and a payload; it is not desk/v1 and is deliberately unsupported until a reviewed mapping is supplied. The adapter never guesses an undocumented RPC payload field.

```sh
DESK_DOMAIN=example \
DESK_ARKIV_SCHEMA=argo.hiring-desk.v1 \
DESK_ARKIV_RECORD_ATTRIBUTE=record \
DESK_PUBLIC_RPC_URL=https://your-public-rpc.example \
node addons/desk-client/bin/desk-reader.mjs 'arkiv:7794095/0xENTITY_KEY' ./addons/desk-client/src/arkiv-reader.mjs
```

Use an actual full hex entity key. No signing key, Argo login or private database is used. Access keys in RPC URL paths are never included in transport errors. Public RPC errors, unsupported finalized tags, missing job data, malformed records and over-limit responses fail closed. The default bounds are 100 pages of at most 100 entities, 2 MB per RPC response, 128 KiB per record JSON and a 10-second timeout per request.

`verifyArtifactBytes(bytes, expectedHash, maxBytes)` checks SHA-256 of separately downloaded bytes with a size bound. It does not fetch URLs or prove Swarm publication. The caller must obtain the bytes through its independent reader. Payment verification and receipt allocation still require a separately reviewed real verifier.

Primary method and network references: [Arkiv raw reads](https://docs.arkiv.network/json-rpc/querying-data/), [Rabdi](https://docs.arkiv.network/networks/rabdi/), [creation flags](https://docs.arkiv.network/writing/create/#fix-properties-at-creation), [ownership and mutation](https://docs.arkiv.network/writing/change/).

## Build and checks

From the vault app workspace, build contracts first, then build the browser bundle with Vite. The public app is standalone under `addons/desk-public`; the main app workspace and route registry are untouched. Run `npm test --prefix addons/desk-client` for serialization, public-route and bundle-boundary checks after the browser build.

The desk/v1 contract README is the source of truth for record validation, reducer semantics, payment evidence and public-reference rules. This client preserves unavailable/pending outcomes and does not treat fixture data as live evidence.
