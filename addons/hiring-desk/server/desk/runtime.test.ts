import { describe, expect, it, vi } from 'vitest';
import { createCybazaarBackend, cybazaarConfigSchema } from './runtime.js';
import type { PgDeskPersistence } from './persistence/store.js';

vi.mock('@secondbrain/desk-arkiv/server', () => ({ ServerArkivDeskClient: class {} }));

const signer = `0x${'1'.repeat(40)}`;
const config = {
  arkivRpcUrl: 'https://arkiv.example.test', arkivChainId: 12345, arkivPrivateKey: `0x${'2'.repeat(64)}`,
  arkivLifetimeBlocks: 1000, beeUrl: 'https://bee.example.test', beePostageBatchId: '3'.repeat(64),
  identityRpcUrl: 'https://identity.example.test', identityChainId: '1', erc8004RegistryAddress: `0x${'4'.repeat(40)}`,
  ensRpcUrl: 'https://ens.example.test', ensChainId: '1',
  metadataHosts: ['profiles.example.test'], timeoutMs: 1000, maxResponseBytes: 65536, maxArtifactBytes: 65536,
  publicationDestination: 'swarm://',
};

describe('concrete Cybazaar backend composition', () => {
  it('wires live Arkiv, identity, Swarm and operational seams without exposing the signer', () => {
    const arkivClient = { signerAddress: () => signer, page: vi.fn(), get: vi.fn(), create: vi.fn(), findByIdempotencyKey: vi.fn(), confirmation: vi.fn() };
    const live = { mode: 'live' as const };
    const host = createCybazaarBackend({
      domain: 'example-desk', config, persistence: { list: vi.fn().mockResolvedValue([]) } as unknown as PgDeskPersistence,
      publicationQuery: vi.fn(), arkivClient,
      operational: {
        providers: [], ens: { rpcUrl: config.ensRpcUrl, chainId: config.ensChainId, normalizeName: value => value.toLowerCase(), resolveAddress: vi.fn() },
        runner: { ...live, start: vi.fn(), status: vi.fn(), cancel: vi.fn() },
        providerTransactions: { ...live, prepareClaim: vi.fn(), prepareDelivery: vi.fn() },
        capabilities: { ...live, issue: vi.fn(), revoke: vi.fn() }, eligibleProviders: vi.fn().mockResolvedValue({ kind: 'ok', value: [] }), artifactBytes: vi.fn(),
      },
    });
    expect(host.backendSigner).toBe(signer);
    expect(host.publicStore.mode).toBe('live'); expect(host.snapshots.mode).toBe('live'); expect(host.identity.mode).toBe('live'); expect(host.publisher.mode).toBe('live');
    expect(JSON.stringify(host)).not.toContain(config.arkivPrivateKey);
  });

  it('fails closed on missing bounds without including secret values', () => {
    const secret = config.arkivPrivateKey;
    const parsed = cybazaarConfigSchema.safeParse({ ...config, timeoutMs: undefined });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.message).not.toContain(secret);
  });
});
