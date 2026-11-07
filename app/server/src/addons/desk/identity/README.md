# Hiring Desk identity readers

`RpcErc8004Reader` implements the existing read-only `Erc8004Reader` interface.
It needs an explicitly selected deployment. Nothing is enabled, registered or
signed by importing it, and there is no default chain, registry or provider ID.
Inject it into `ConfiguredDeskIdentity` through `erc8004` in the host composition:

```ts
const erc8004 = new RpcErc8004Reader({
  chainId: deployment.identityChainId,
  registryAddress: deployment.identityRegistry,
  rpcUrl: deployment.identityRpcUrl,
  metadataHosts: deployment.identityMetadataHosts,
});
```

`chainId` is a positive decimal string. `registryAddress` is a nonzero EVM address;
`rpcUrl` is a trusted server-side HTTPS RPC URL. Keep RPC credentials in server
configuration. This adapter adds no environment variables or deployment constants.
Metadata HTTPS fetching is disabled by default: `metadataHosts` must explicitly
allow each exact DNS hostname. Inline `data:application/json;base64,...` registration
files work without a network metadata service. IPFS and other URI schemes remain
unsupported and report unavailable instead of using an implicit gateway.

The reader checks `eth_chainId`, obtains a finalized block and pins `eth_getCode`
and all three contract calls to its canonical block hash (EIP-1898). Nodes lacking
finalized reads or canonical block-hash calls fail closed. The selected registry
must have code. `ownerOf(uint256)`, `getAgentWallet(uint256)` and
`tokenURI(uint256)` are independent reads. Unset/zero agent wallets return `null`
and are never replaced with the token owner. Only the exact missing-token custom
error for the requested ID returns a missing registration; RPC errors throw.

URI ABI decoding, response bodies, JSON services and metadata are bounded. The
default metadata maximum is 65,536 bytes and each request timeout is 10 seconds.
HTTPS metadata resolves all DNS answers, rejects private/special addresses, pins
the socket to a validated address, keeps TLS validation against the original
hostname, disables connection pooling and refuses redirects or compression. Both
DNS and streaming response time/size are bounded. The conservative IP filter may
reject some legitimate special IPv6 ranges. Service URLs are projected as bounded
strings; this reader does not fetch service endpoints, images or nested links.

Registration reading does not require ENS. Combined `ConfiguredDeskIdentity`
verification still requires its separately configured ENS evidence; absence stays
unresolved and contradictions remain visible. Owner/payment wallet comparisons
stay in that existing identity layer. No feedback, reputation, registry writes,
ENS writes, private keys or new signing capability are introduced.

## Interface evidence

Primary sources inspected 2026-11-07:

- [Official identity registry source](https://github.com/erc-8004/erc-8004-contracts/blob/master/contracts/IdentityRegistryUpgradeable.sol)
- [Official identity ABI](https://github.com/erc-8004/erc-8004-contracts/blob/master/abis/IdentityRegistry.json)
- [ERC-8004 specification](https://ercs.ethereum.org/ERCS/erc-8004)

The three hardcoded read selectors were derived from their official signatures
with Keccak-256. The current source clears the agent wallet on token transfers;
a successful owner read alone therefore cannot establish the payment wallet.
Live identity validation remains a separate operator check against the configured
registry deployment and its finalized records.
