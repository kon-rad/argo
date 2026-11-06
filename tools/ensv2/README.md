# ENSv2 registration tool

This tool prepares an ENSv2 transaction manifest for an agent subname. It is public-safe: wallet addresses, agent IDs and RPC URLs are supplied at runtime, never committed.

## Install

```bash
cd tools/ensv2
npm install
```

## Prepare transactions for MetaMask

```bash
npm run register -- \
  --parent-name example.eth \
  --label akira \
  --parent-owner 0xYOUR_PARENT_OWNER \
  --agent-wallet 0xYOUR_AGENT_WALLET \
  --agent-id YOUR_ERC8004_AGENT_ID \
  --parent-registry 0xPARENT_REGISTRY \
  --parent-id PARENT_TOKEN_ID \
  --output ensv2-registration-txs.json
```

The parent registry and parent token ID are required because ENSv2 attaches a subregistry to a specific parent registry entry. Obtain both from ENS Explorer or a read-only query, then verify them before signing.

The default mode only prepares and validates inputs. It does not sign or broadcast. The first two transactions deploy the official UserRegistry and PermissionedResolver proxies through the ENS Verifiable Factory. Their CREATE2 addresses are predicted in the manifest and must be checked against the `ProxyDeployed` events before the dependent attach, register and resolver-record calls are signed.

## Automated signer mode

For a dedicated operator key, set `ENS_PRIVATE_KEY` in the shell environment and rerun the same command. Never put the key in this repository, a JSON file or a shell history. Signer mode simulates each dependent call and stops if either proxy receipt does not match its predicted address or official implementation.

## Sign with a browser wallet

```bash
cd tools/ensv2
python3 -m http.server 8787
```

Open `http://127.0.0.1:8787/wallet-runner.html` where Ronin Wallet is installed. Choose the generated JSON manifest, switch Ronin to Ethereum Mainnet, and click each `Review and sign` button in order. The page checks the chain and connected account, waits for confirmation, and does not continue automatically after a rejection.

Never host this page publicly or put a private key in the manifest.

## Contract sources

- [ENSv2 Verifiable Factory](https://docs.ens.domains/ensv2/verifiable-factory/)
- [ENSv2 Permissioned Registry](https://docs.ens.domains/ensv2/permissioned-registry/)
- [ENSv2 Issuing Subnames](https://docs.ens.domains/ensv2/subnames/)
