import { beforeAll, afterAll, afterEach, describe, it, expect, vi } from 'vitest';
import { createMarketRuntime, marketConfigSchema } from './runtime.js';
import { RpcErc8004Reader } from '../desk/identity/erc8004.js';
import { bootDesk } from '../desk/boot.js';
import { scratchMarketStore } from './test-support.js';
const owner = '0x' + '1'.repeat(40), payout = '0x' + '2'.repeat(40), registry = '0x' + '3'.repeat(40);
const configuration = { domain: 'fixture-market', envelopeSecret: 'synthetic-secret-with-at-least-32bytes', artifactRoot: '/tmp/fixture-artifacts', baseRpcUrl: 'https://base.example/rpc', executionAgent: 'fixture-worker', profiles: [{ id: 'fixture-provider', name: 'Fixture provider', serviceTitle: 'Fixture service', description: 'Fixture', priceAtomic: '1000', payoutWallet: payout, ownerWallet: owner, ensName: 'fixture.eth', agentId: '1' }], arkivRpcUrl: 'https://arkiv.example/rpc', arkivChainId: 1, arkivPrivateKey: '0x' + '1'.repeat(64), arkivLifetimeBlocks: 100, beeUrl: 'https://bee.example', beePostageBatchId: 'a'.repeat(64), identityRpcUrl: 'https://identity.example/rpc', identityChainId: '8453' as const, erc8004RegistryAddress: registry, ensRpcUrl: 'https://ens.example/rpc', ensChainId: '1', metadataHosts: [] };
const ens = { rpcUrl: configuration.ensRpcUrl, chainId: configuration.ensChainId, normalizeName: (x: string) => x, resolveAddress: async () => owner };
describe('market boot config isolation', () => {
    afterEach(() => vi.restoreAllMocks());
    it('disabled addon does not load/validate market settings or touch database', async () => { const load = vi.fn(); expect(await bootDesk(new Set(), { marketEnabled: 'true', marketEnvelopeSecret: 'invalid' }, load)).toBeUndefined(); expect(load).not.toHaveBeenCalled(); });
    it('rejects missing market dependencies before loading privileged code', async () => { const load = vi.fn(); await expect(bootDesk(new Set(['desk']), { marketEnabled: 'true' }, load)).rejects.toThrow('host board adapter'); expect(load).not.toHaveBeenCalled(); });
    it('does not accept configuration identityBound as proof', () => { expect(marketConfigSchema.safeParse({ ...configuration, profiles: [{ ...configuration.profiles[0], identityBound: true }] }).success).toBe(false); });
});
describe.skipIf(!process.env.CYBA_TEST_DB_URL)('market concrete composition and live-reader gate', () => {
    let db: Awaited<ReturnType<typeof scratchMarketStore>>;
    beforeAll(async () => { db = await scratchMarketStore(); });
    afterAll(async () => { await db?.close(); });
    afterEach(() => vi.restoreAllMocks());
    const board = { get: async () => null, create: async () => { throw Error('not invoked'); }, assign: async () => { throw Error('not invoked'); }, move: async () => { throw Error('not invoked'); } };
    it('only lists actual matching ENS/ERC-8004 bindings and clears stale verification on outages', async () => {
        const read = vi.spyOn(RpcErc8004Reader.prototype, 'readRegistration').mockResolvedValue({ agentRegistry: 'eip155:8453:' + registry, agentId: '1', owner, paymentWallet: payout, services: [] });
        const runtime = createMarketRuntime({ config: marketConfigSchema.parse(configuration), database: db.database, board, operational: { ens } });
        expect(await runtime.verifiedProfiles()).toHaveLength(1);
        expect((await db.store.getProfile('fixture-provider'))?.identityBound).toBe(true);
        read.mockRejectedValue(new Error('Private RPC detail'));
        expect(await runtime.verifiedProfiles()).toEqual([]);
        expect((await db.store.getProfile('fixture-provider'))?.identityBound).toBe(false);
        await expect(db.store.createJob(owner, { providerId: 'fixture-provider', title: 'Fixture', brief: 'Public text', requestKey: 'runtime-fixture-request' })).rejects.toMatchObject({ status: 503 });
    });
    it('boots the built-in ENS path from configuration without an operational module', async () => {
        const load = vi.fn();
        const raw = { marketEnabled: 'true', marketEnvelopeSecret: configuration.envelopeSecret, marketArtifactRoot: configuration.artifactRoot, marketBaseRpcUrl: configuration.baseRpcUrl, marketExecutionAgent: configuration.executionAgent, marketProfiles: JSON.stringify(configuration.profiles), domain: configuration.domain, arkivRpcUrl: configuration.arkivRpcUrl, arkivChainId: '1', arkivPrivateKey: configuration.arkivPrivateKey, arkivLifetimeBlocks: '100', beeUrl: configuration.beeUrl, beePostageBatchId: configuration.beePostageBatchId, identityRpcUrl: configuration.identityRpcUrl, identityChainId: '8453', erc8004RegistryAddress: registry, ensRpcUrl: ens.rpcUrl, ensChainId: ens.chainId };
        const result = await bootDesk(new Set(['desk']), raw, load, { ...db.database, marketBoard: board });
        expect(result?.market).toBeDefined(); expect(load).not.toHaveBeenCalled();
        await expect(bootDesk(new Set(['desk']), { ...raw, ensChainId: '999' }, load, { ...db.database, marketBoard: board })).rejects.toThrow();
    });
    it('boots standalone Base market without Arc settings', async () => {
        const load = vi.fn(async () => ({ createCybaMarketDependencies: async () => ({ ens }) }));
        const result = await bootDesk(new Set(['desk']), { marketEnabled: 'true', marketEnvelopeSecret: configuration.envelopeSecret, marketArtifactRoot: configuration.artifactRoot, marketBaseRpcUrl: configuration.baseRpcUrl, marketExecutionAgent: configuration.executionAgent, marketProfiles: JSON.stringify(configuration.profiles), domain: configuration.domain, runtimeModule: '/tmp/fixture-runtime.mjs', arkivRpcUrl: configuration.arkivRpcUrl, arkivChainId: '1', arkivPrivateKey: configuration.arkivPrivateKey, arkivLifetimeBlocks: '100', beeUrl: configuration.beeUrl, beePostageBatchId: configuration.beePostageBatchId, identityRpcUrl: configuration.identityRpcUrl, identityChainId: '8453', erc8004RegistryAddress: registry, ensRpcUrl: ens.rpcUrl, ensChainId: ens.chainId }, load, { ...db.database, marketBoard: board });
        expect(result?.market).toBeDefined();
        expect(result?.public).toBeUndefined();
        expect(result?.operator).toBeUndefined();
        expect(load).toHaveBeenCalledOnce();
    });
});
