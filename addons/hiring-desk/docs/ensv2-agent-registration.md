# ENSv2 agent names

Argo agents can publish a human-readable ENS name alongside their on-chain identity. ENS namespace management happens on Ethereum Mainnet. The agent identity itself may live on another chain, such as Base through ERC-8004.

This guide covers the manual ENSv2 path when the ENS app says:

> New Permissioned Registry contract temporarily disabled. Use a pre-existing contract.

## Keep private values out of the engine

The Argo engine is public. Do not commit an owner wallet, agent wallet, agent ID, transaction hash or private RPC URL here. Keep those values in the vault or deployment operator's private checklist.

Use these placeholders when adapting the procedure:

| Placeholder | Meaning |
|---|---|
| `PARENT_OWNER` | Wallet that owns the parent ENS name |
| `PARENT_NAME` | The parent name, for example `example.eth` |
| `AGENT_LABEL` | The subname label, for example `akira` |
| `AGENT_WALLET` | Wallet the agent uses for its identity or receiving records |
| `AGENT_ID` | The ERC-8004 agent ID |

## The contract roles

ENSv2 uses a per-name User Registry to manage subnames. The registry is a proxy deployed through ENS's shared Verifiable Factory. The parent owner keeps control of the registry and can later delegate narrower roles if required.

The official Ethereum Mainnet addresses are:

| Contract | Address |
|---|---|
| Verifiable Factory | `0x77510ba162dfea3d8989e3f0928a691b345730d2` |
| UserRegistry implementation | `0xfaa23592aca10a6d8875b18ea86954e8eb6d8d72` |
| PermissionedResolver implementation | `0x565b0f456a04ac9b48758190e90030623cff57c5` |

These are protocol contracts, not contracts to deploy yourself. Verify them against the [ENS deployment list](https://docs.ens.domains/learn/deployments/) before every manual transaction.

## Manual deployment sequence

All transactions in this section must be signed by `PARENT_OWNER` in MetaMask on Ethereum Mainnet.

### 1. Deploy the User Registry proxy

Call `deployProxy` on the Verifiable Factory with:

- implementation: the official `UserRegistry` implementation;
- salt: the ENSv2 User Registry salt for `PARENT_NAME` and version `0`;
- initialization data: the User Registry `initialize` call granting the parent owner the required root roles.

ENS documents the initializer and salt derivation in [Verifiable Factory: Deploying a Registry Proxy](https://docs.ens.domains/ensv2/verifiable-factory/#deploying-a-registry-proxy). Record the `ProxyDeployed` event's `proxyAddress`. That proxy address is the pre-existing registry the ENS app is asking for.

Do not hand-type ABI calldata in MetaMask. Generate it from the official ABI, simulate it with `eth_call`, and compare the implementation, initializer owner and predicted proxy address before signing.

Argo includes a public-safe transaction tool in [`tools/ensv2`](https://github.com/kon-rad/argo/tree/main/tools/ensv2). It predicts both proxy addresses with CREATE2, emits a complete transaction manifest for MetaMask review, and can run the same sequence with an explicitly configured operator key.

### 2. Attach the registry to the parent name

Call `setSubregistry` for `PARENT_NAME` on the parent ENSv2 registry, using the new proxy address. This makes the registry responsible for names below the parent.

The parent owner must approve this transaction. If the ENS app accepts a pre-existing registry address, this is the address to enter after the transaction confirms.

### 3. Create the agent subname

Use the User Registry to register `AGENT_LABEL` below `PARENT_NAME`, producing:

`AGENT_LABEL.PARENT_NAME`

For the first agent, keep ownership with `PARENT_OWNER`. This leaves the namespace under one accountable owner while the resolver records point to the agent's separate identity wallet.

### 4. Configure the resolver

Set a Permissioned Resolver for the parent or subname, then write the records for the agent name:

- address record: `AGENT_WALLET`;
- text record `agentRegistry`: `eip155:8453:<ERC8004_IDENTITY_REGISTRY>`;
- text record `agentId`: `AGENT_ID`;
- optional text record `agentURI`: the ERC-8004 registration URI.

For ERC-8004 on Base Mainnet, the identity registry is currently:

`eip155:8453:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`

ENS is only naming and resolving the agent. ERC-8004 remains the source of the on-chain agent identity. They should be cross-linked through resolver text records and the ERC-8004 registration metadata.

## Verification checklist

Before treating the name as live, verify all of the following with read-only calls or the ENS Explorer:

- the User Registry proxy was emitted by the official Verifiable Factory;
- the parent name's subregistry is the proxy just deployed;
- `AGENT_LABEL.PARENT_NAME` resolves to `AGENT_WALLET`;
- the `agentRegistry` record contains the Base ERC-8004 registry and chain ID `8453`;
- the `agentId` resolves to the intended ERC-8004 registration;
- the ERC-8004 registry reports the same wallet as the agent owner or agent wallet;
- no transaction was signed from an unexpected account or network.

## Safer operating procedure

Prepare and simulate every transaction first. Then approve one MetaMask prompt at a time. Never use a registry address supplied by an unknown party, and never give a third-party registry an administrative role over the parent name.

### Official references

- [ENSv2 Verifiable Factory](https://docs.ens.domains/ensv2/verifiable-factory/)
- [ENSv2 Permissioned Registry](https://docs.ens.domains/ensv2/permissioned-registry/)
- [ENSv2 Issuing Subnames](https://docs.ens.domains/ensv2/subnames/)
- [ENS contract deployments](https://docs.ens.domains/learn/deployments/)
- [ERC-8004 Identity Registry](https://github.com/erc-8004/erc-8004-contracts)
