# Arc Testnet settlement

`ArcNativeUsdcSettlement` implements the frozen `DeskSettlement` contract for direct client-signed Arc Testnet native USDC transfers. `prepare()` returns an EVM native-value transaction for the connected client wallet; the application must show the destination, exact amount, Arc Testnet status and wallet-estimated fees before asking the client to sign. This module has no signer and never sends a transaction.

## Selected interface and units

- Chain ID: `5042002` (Arc Testnet).
- Asset/interface: `USDC`, `arc:testnet:native-usdc:eip-7708:v1`.
- Amount unit: integer atomic units at 18 decimal places because the Arc native-value interface uses 18 decimals. Convert human decimal strings with `parseDecimalToAtomic`; do not use `Number` for money.
- Transaction: direct `to=recipient`, `value=amountAtomic`, empty calldata.
- Receipt stream: exactly one `Transfer` log emitted by Arc's EIP-7708 system address `0xfffffffffffffffffffffffffffffffffffffffe`; the event value is 18 decimals. The regular USDC ERC-20 contract emits an additional 6-decimal mirror for ERC-20 interface activity. Verification deliberately selects the system emitter only, checks native tx and log against accepted terms, and records the selected system log index. It rejects a contract call and multiple system transfer logs.
- Receipt identity: `arc:<chainId>:<lowercase tx hash>:<log index>`. The injected `reserve` callback must atomically bind this identity to one job/acceptance in durable storage. Without an RPC reader and durable reservation, verification returns `unavailable`; there is no fixture or inferred-success fallback.

`ArcReadClient` is deliberately injectable. No chain SDK, RPC secret, default live network request, or deployment configuration is included. The lead/P9 integration must provide a reviewed RPC implementation and durable reservation store. Arc's documented deterministic finality means a successful receipt is final; missing transaction/receipt data remains `pending` and should be reconciled before any retry.

Arc documentation: [Connect to Arc](https://docs.arc.io/integrate/connect-to-arc) documents Arc Testnet chain ID `5042002`, its RPC endpoint, and native USDC's 18 decimals. [How to: Index Arc Events](https://docs.arc.io/integrate/infrastructure/indexing-events) documents the system emitter, event signature, 18-decimal system event, 6-decimal ERC-20 mirror and deterministic finality. Source reviewed 2026-11-06.

## Separate ERC-20 interface for public wallet clients

`ArcErc20UsdcSettlement` implements `DeskSettlement` without changing the native adapter or the `desk/v1` evidence contract. Select it explicitly using `DESK_PAYMENT_INTERFACE=arc:testnet:erc20-usdc:transfer:v1`; configure `DESK_CHAIN_ID=5042002`, `DESK_USDC_ADDRESS=0x3600000000000000000000000000000000000000` and a server-only `DESK_RPC_URL`. The ERC-20 adapter requires the configured token to match that documented Arc Testnet predeploy. Neither payment interface substitutes for the other. Existing native deployments must retain their explicit native interface selection.

ERC-20 amounts are integer atomic strings at **six decimal places**. For example, `parseDecimalToAtomic('1.25', 6)` returns `'1250000'`. `prepare()` returns only `transfer(recipient, amountAtomic)` calldata to the configured token, with `value: '0x0'`. The client wallet signs and submits; the engine adapter never signs or submits.

Verification independently reads the chain ID, transaction and receipt. A successful receipt is final on Arc; absent or non-final data remains `pending`. The transaction must have the accepted payer, configured token destination, zero native value and the exact canonical `transfer(address,uint256)` calldata without trailing bytes. Exactly one token-emitted `Transfer` must match the accepted payer, recipient and six-decimal amount. When a native system-emitted mirror is present, its payer, recipient and 18-decimal amount must match after exact integer scaling by `10^12`; its log index must be distinct. The mirror never creates another allocation.

The adapter selects the token log index, normalizes an RPC hex index to decimal and reserves `arc:5042002:<lowercase-tx-hash>:<decimal-log-index>` through the injected durable callback. The assignment key is the existing `jobRef + NUL + acceptanceRef` binding. That callback must be atomic, reject allocation to another assignment and return success for a retry by the same assignment. The adapter contains no in-memory production allocation fallback. A database or RPC failure yields `unavailable`, never verified success. Verification and reconciliation perform the same independent read and reservation checks, so reconciliation cannot send another payment.

Construction uses `new ArcErc20UsdcSettlement({ usdcAddress, reader, reserve })`. `reader` and `reserve` use the existing native adapter's `ArcReadClient` and `ReserveReceipt` interfaces. `VerifiedPayment` and the signed evidence shape remain unchanged. Preparation can run without a reader; verification cannot succeed without both the reader and durable reservation.

Sources checked 2026-11-07: [Arc network reference](https://docs.arc.io/arc/references/connect-to-arc) documents testnet chain `5042002`. [Arc event indexing](https://docs.arc.io/integrate/infrastructure/indexing-events) documents USDC contract `0x3600000000000000000000000000000000000000`, six-decimal token events, the 18-decimal system view and deterministic finality. Live chain preflight and demo evidence belong in the integration submission, not in synthetic unit fixtures.

Run the settlement unit suite from the repository root after installing the app workspace and building the shared package:

```sh
cd app
npm ci
npm run build:shared
cd ..
npm test
```

The suite runs synthetic native and ERC-20 transfer cases without live RPC requests or PostgreSQL setup. Production RPC-reader and boot coverage lives in `../boot.test.ts` and runs with `../boot.vitest.config.ts`.
