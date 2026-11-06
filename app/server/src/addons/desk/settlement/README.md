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
