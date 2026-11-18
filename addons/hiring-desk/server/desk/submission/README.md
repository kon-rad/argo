# Hiring Desk ERC-20 integration evidence

Status: **BLOCKED for live integration**, 2026-11-07. This is a reviewable implementation, not a completed payment demo. No merge, deployment, wallet signature or live job payment is claimed.

## Revisions and demo provenance

| Evidence | Observed value |
|---|---|
| Engine implementation commit | `7c22f532b2fe370e1f8c603a6a1f83b825cffbc5` |
| Engine base | `c74c3c2`, merged Phase 1 and rollout documentation |
| Public client repository | https://github.com/kon-rad/hiring-desk-app |
| Public client inspected commit | `5be2f58457cc8c95c6e830ab21eab01664d69746`; no client code changes in this engine implementation |
| Vercel deployment URL and SHA | Not supplied or independently verified |
| Arc Studio project URL | Not supplied; client's provenance file still contains a placeholder |
| Selected interface | `arc:testnet:erc20-usdc:transfer:v1` |
| Chain ID | `5042002`, Arc Testnet |
| USDC contract | `0x3600000000000000000000000000000000000000` |
| Amount precision | Six decimals, exact integer atomic strings |
| Live synthetic-job transaction hash | Not created |
| Selected live Transfer log index | Not available |
| Live durable receipt identity | Not available |

## Implemented behavior

- A separate `ArcErc20UsdcSettlement` prepares unsigned `transfer(recipient, amount)` calldata and zero native value. The native adapter is unchanged and requires explicit selection.
- Independent verification checks RPC chain, transaction/receipt identity, finality, canonical block inclusion, payer, token, zero native value, exact calldata, one token Transfer log and optional native mirror agreement.
- Receipt identity is `arc:5042002:<lowercase-tx-hash>:<decimal-log-index>`. Production reservation uses PostgreSQL and checks released delivery plus accepted-offer and approval digests.
- Public API: `/api/desk/public/jobs`, `/acceptances`, `/jobs/:ref`, `/jobs/:ref/offers`, `/jobs/:ref/payment`, `/payments/prepare`, `/payments/verify`, `/payments/reconcile`, and job-scoped `/jobs/:ref/payments/{verify,reconcile}` aliases.
- Job-scoped verification/reconciliation accepts only `{txHash}`. The engine reloads accepted terms and independently verified provider identity. The existing public client's `VITE_HIRING_DESK_API_URL` must point to the public boundary, ending in `/api/desk/public`.
- Pending resume hints survive process restarts through the assignment aggregate. Only independently matching transactions can create a durable hint; an invented hash cannot lock a job. A hint never establishes payment.
- The public router has a 16KB parser limit, strict schemas, exact configured-origin enforcement, credential-free CORS, per-IP read/write limits, sanitized errors and no operator or generic private routes. Private operator routes retain their session gate.
- Disabled desk mounts no routes, adds no navigation/timers and needs no payment configuration. Enabled boot rejects missing host services and fixtures.

## Verification commands and real output

Run application commands from `app/` unless stated otherwise.

| Command | Result |
|---|---|
| `npx vitest run --project desk` | `Test Files 6 passed (6); Tests 102 passed (102)` |
| `npx vitest run --config server/src/addons/desk/settlement/vitest.config.ts` | `2 passed; 59 passed`, including 54 ERC-20 cases and 5 native regressions |
| `npx vitest run --config server/src/addons/desk/boot.vitest.config.ts` | `1 passed; 23 passed` |
| `npx vitest run --config server/src/addons/desk/public-vitest.config.ts` | `2 passed; 16 passed` |
| `DESK_TEST_DATABASE_URL=<disposable-sb-test-db> npx vitest run --config server/src/addons/desk/persistence/vitest.postgres.config.ts` | `1 passed; 1 passed`; real PostgreSQL, competing allocations, separate connection readback and same-job retry |
| `npm run build` | Exit 0, server and web; bundle-size warning |
| `NODE_OPTIONS=--no-experimental-webstorage npx vitest run --project web --maxWorkers 1` | `26 passed; 155 passed` |
| Environment-schema focused rerun | `1 passed; 3 passed`; test-only database variable documented in the existing baseline |
| `cd zen-agent && npm ci && npm test` | `79 tests; 79 pass; 0 fail` |
| Public client `bun test tests` | `47 pass; 0 fail` at the inspected client revision |
| Public client `npx vite build` | Exit 0; bundle-size warning |
| Public client `bun run typecheck` | Fails: existing `scripts/compass-deploy.ts` cannot resolve `@circlefin/compass-chains` |
| Initial full `npm test` against disposable PostgreSQL | `145 passed / 11 failed files; 1381 passed / 19 failed tests`; web timeouts/native-storage failures subsequently passed serially; the new environment-schema omission was fixed and its three tests passed |
| `python -m pytest harness tools addons` | Run interrupted after the existing worker concurrent-budget test stalled; not a passing full suite |
| Same Python suite with stalled worker test deselected | `1 failed, 136 passed, 5 skipped, 1 deselected`; failure: unchanged `tools/test_sbsync.py::test_refuses_a_planted_key` |
| `scripts/check-public.sh <changed-files...>` | Exit 0 |
| Repository-wide `scripts/check-public.sh` | Fails on existing denylist hits and the local worktree `.git` pointer; no clean full-repository privacy claim |
| `git diff --check` | Exit 0 |
| `mkdocs build --strict` | Exit 0 after correcting three links outside the published documentation tree |

The desk project is included in the normal application Vitest configuration. The live PostgreSQL test is separately opt-in and refuses database names outside `sb_*_test`. It rebuilds only the four desk tables in that explicitly selected disposable database. Fixture tests and synthetic receipts are not live Arc acceptance evidence.

## Independent reader output

Official [Arc event documentation](https://docs.arc.io/integrate/infrastructure/indexing-events) identifies the token's six-decimal Transfer stream and the system emitter's eighteen-decimal mirror. The [network reference](https://docs.arc.io/arc/references/connect-to-arc) identifies testnet chain `5042002`.

Read-only RPC checks on 2026-11-07 returned:

```text
https://rpc.testnet.arc.io
eth_chainId: 0x4cef52 = 5042002

https://rpc.blockdaemon.testnet.arc.io
eth_chainId: 0x4cef52 = 5042002
eth_getCode(USDC): 1798 code bytes
eth_call(USDC, decimals() selector 0x313ce567): 6
eth_getBlockByNumber(finalized):
  number: 0x43cb95f
  hash: 0x29cae20a3a400f36d6648c3f8f3d8afdba671a5d6f48bfd86565388c33c5f217
  transactionCount: 11
```

A separate SQL reader observed the synthetic durable allocation after the integration test:

```text
arc:5042002:0xabababababababababababababababababababababababababababababababab:7|arkiv:1/job-a
```

This repeated-byte hash is synthetic test data. It is not a chain transaction. No independent live payment receipt is available from this run.

## Blocking limitations and next decisions

1. **Payment evidence linkage:** the unchanged reducer requires a finalized, client-authored Arkiv payment record with its exact evidence reference/digest. The wallet verifier returns an Arc receipt reference and its digest. A hash-only browser request supplies no client-authored Arkiv publication. Even a valid reserved Arc transfer therefore remains pending. No observation is fabricated and no reducer check is bypassed. Review a separate durable engine settlement projection or an authenticated publication bridge before changing this contract.
2. **Real production host:** `DESK_RUNTIME_MODULE` is an explicit trusted composition seam, not a supplied live runtime. Concrete Arkiv SDK binding, identity readers/deployments, durable Swarm publication ledger, provider-authored transaction intents and authenticated isolated-worker/capability services remain unimplemented or unverified.
3. **Live E2E:** requires the real host runtime, deployed public boundary, configured Vercel origin/API base, actual Studio and deployment URLs, a dedicated testnet signer and a resolved evidence bridge. Fresh-browser/fresh-process live payment acceptance has not been run.
4. **Operational limits:** public rate limits are per-process; multiple replicas require a shared edge limiter. Unsupported finality methods and RPC throttling fail closed. A known pending payer transaction replaced in the mempool needs an authenticated replacement policy; the current public API does not silently replace its hash.

No custom contract, escrow, refunds, disputes, mainnet funds or autonomous spending is introduced.
