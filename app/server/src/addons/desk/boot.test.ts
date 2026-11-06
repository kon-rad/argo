import { describe, expect, it, vi } from 'vitest';
import { assertLiveDeskHost, bootDesk, reserveReleasedReceipt, type DeskHostRuntime } from './boot.js';
import { navFor, unitsFor } from '../../features/registry.js';
import { ArcJsonRpcReader } from './settlement/rpc.js';
import { digest } from '@secondbrain/desk-contracts/desk';

const txHash = `0x${'a'.repeat(64)}`;
const blockHash = `0x${'b'.repeat(64)}`;
const token = '0x3600000000000000000000000000000000000000';
function rpc(values: Record<string, unknown>) {
  return vi.fn(async (_url: unknown, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body));
    const key = request.method === 'eth_getBlockByNumber' ? `${request.method}:${request.params[0]}` : request.method;
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: values[key] ?? null }), { headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
}
const receipt = { transactionHash: txHash, status: '0x1', blockHash, blockNumber: '0xa', logs: [{ address: token, topics: [`0x${'c'.repeat(64)}`], data: '0x', logIndex: '0x2' }] };

describe('desk production boot boundary', () => {
  it('disabled module needs no config, services, navigation or timers', async () => {
    const load = vi.fn();
    expect(await bootDesk(new Set(), { rpcUrl: 'invalid', paymentInterface: 'invalid' }, load)).toBeUndefined();
    expect(load).not.toHaveBeenCalled();
    expect(navFor(new Set()).some(nav => nav.path === '/desk')).toBe(false);
    expect(unitsFor(new Set())).toEqual([]);
  });
  it('enabled module fails closed without explicit payment and runtime config', async () => {
    await expect(bootDesk(new Set(['desk']), {})).rejects.toThrow('Desk production configuration missing or invalid');
  });
  it('rejects a runtime module that does not export live host composition', async () => {
    const load = vi.fn(async () => ({}));
    await expect(bootDesk(new Set(['desk']), { domain: 'synthetic-desk', chainId: '5042002', publicOrigin: 'https://client.example.com', rpcUrl: 'https://rpc.example.com', runtimeModule: '/srv/example/desk-runtime.mjs', paymentInterface: 'arc:testnet:erc20-usdc:transfer:v1', usdcAddress: token }, load as never)).rejects.toThrow('must export createDeskRuntime');
  });
  it('rejects live labels without actual adapter operations', () => {
    const host = Object.fromEntries(['snapshots', 'publicStore', 'identity', 'runner', 'publisher', 'providerTransactions', 'capabilities'].map(name => [name, { mode: 'live' }])) as unknown as DeskHostRuntime;
    expect(() => assertLiveDeskHost(host)).toThrow('missing a production adapter operation');
  });
  it('does not silently select native or ERC20', async () => {
    const load = vi.fn();
    await expect(bootDesk(new Set(['desk']), { domain: 'synthetic-desk', chainId: '5042002', publicOrigin: 'https://client.example.com', rpcUrl: 'https://rpc.example.com', runtimeModule: '/srv/example/desk-runtime.mjs' }, load)).rejects.toThrow('paymentInterface');
    expect(load).not.toHaveBeenCalled();
  });
  it('rejects wrong token before importing a runtime', async () => {
    const load = vi.fn();
    await expect(bootDesk(new Set(['desk']), { domain: 'synthetic-desk', chainId: '5042002', publicOrigin: 'https://client.example.com', rpcUrl: 'https://rpc.example.com', runtimeModule: '/srv/example/desk-runtime.mjs', paymentInterface: 'arc:testnet:erc20-usdc:transfer:v1', usdcAddress: 'invalid' }, load)).rejects.toThrow('usdcAddress');
    expect(load).not.toHaveBeenCalled();
  });
  it.each(['snapshots', 'publicStore', 'identity', 'runner', 'publisher', 'providerTransactions', 'capabilities'] as const)('rejects fixture %s even outside NODE_ENV production', key => {
    const host = Object.fromEntries(['snapshots', 'publicStore', 'identity', 'runner', 'publisher', 'providerTransactions', 'capabilities'].map(name => [name, { mode: name === key ? 'fixture' : 'live' }])) as unknown as DeskHostRuntime;
    expect(() => assertLiveDeskHost(host)).toThrow();
  });
});

describe('durable receipt reservation delivery guard', () => {
  it('reserves released delivery once accepted offer and approval bindings match', async () => {
    const offer = { version: 'desk/v1', domain: 'synthetic-desk', chainId: '7794095', type: 'offer', jobRef: 'public-job', providerId: 'synthetic-provider', provider: token, skillVersion: 'v1', amountAtomic: '1000000', paymentChainId: '5042002', asset: 'USDC', recipient: token, transferInterface: 'arc:testnet:erc20-usdc:transfer:v1', expiresAt: 2000000000 };
    const acceptance = { version: 'desk/v1', domain: 'synthetic-desk', chainId: '7794095', type: 'acceptance', jobRef: 'public-job', offerRef: 'public-offer', client: token, offerDigest: await digest('offer-terms', offer), nonce: 'synthetic-acceptance', expiresAt: 2000000000 };
    const acceptanceDigest = await digest('acceptance', acceptance);
    const row = { id: 'public-job', execution: 'released', publicState: { acceptanceRef: 'public-acceptance', acceptanceDigest, acceptance, offer, offerRef: 'public-offer', job: { client: token }, delivery: { publicRef: 'swarm://synthetic' } }, approval: { acceptanceDigest, skillVersion: 'v1' } };
    const reservePayment = vi.fn(async () => true);
    const get = vi.fn(async () => row);
    expect(await reserveReleasedReceipt({ get, reservePayment } as never, 'receipt', 'public-job\u0000public-acceptance')).toBe(true);
    expect(reservePayment).toHaveBeenCalledWith('public-job', 'receipt');
    row.publicState.offer.amountAtomic = '2000000';
    expect(await reserveReleasedReceipt({ get, reservePayment } as never, 'receipt', 'public-job\u0000public-acceptance')).toBe(false);
    expect(reservePayment).toHaveBeenCalledTimes(1);
  });

  it('does not reserve an unreleased assignment', async () => {
    const reservePayment = vi.fn();
    const get = vi.fn(async () => ({ id: 'public-job', execution: 'review', publicState: { acceptanceRef: 'public-acceptance' } }));
    expect(await reserveReleasedReceipt({ get, reservePayment } as never, 'receipt', 'public-job\u0000public-acceptance')).toBe(false);
    expect(reservePayment).not.toHaveBeenCalled();
  });
  it('does not reserve a released assignment without delivery or matching acceptance', async () => {
    const reservePayment = vi.fn();
    const get = vi.fn(async () => ({ id: 'public-job', execution: 'released', publicState: { acceptanceRef: 'public-acceptance' } }));
    expect(await reserveReleasedReceipt({ get, reservePayment } as never, 'receipt', 'public-job\u0000public-acceptance')).toBe(false);
    expect(await reserveReleasedReceipt({ get, reservePayment } as never, 'receipt', 'public-job\u0000other-acceptance')).toBe(false);
    expect(reservePayment).not.toHaveBeenCalled();
  });
});

describe('independent server Arc RPC reader', () => {
  it('reads chain and transaction independently, without submission', async () => {
    const fetcher = rpc({ eth_chainId: '0x4cef52', eth_getTransactionByHash: { hash: txHash, from: token, to: token, value: '0x0', input: '0x' } });
    const reader = new ArcJsonRpcReader('https://rpc.example.com', fetcher);
    expect(await reader.chainId()).toBe('5042002');
    expect(await reader.transaction(txHash)).toMatchObject({ value: '0x0', input: '0x' });
    expect(vi.mocked(fetcher).mock.calls.map(call => JSON.parse(String(call[1]?.body)).method)).toEqual(['eth_chainId', 'eth_getTransactionByHash']);
  });
  it('requires finalized canonical inclusion and exposes decimal block/log index', async () => {
    const reader = new ArcJsonRpcReader('https://rpc.example.com', rpc({ eth_getTransactionReceipt: receipt, 'eth_getBlockByNumber:finalized': { hash: blockHash, number: '0xb' }, 'eth_getBlockByNumber:0xa': { hash: blockHash, number: '0xa' } }));
    expect(await reader.receipt(txHash)).toMatchObject({ status: 'success', blockNumber: '10', logs: [{ logIndex: '2' }] });
  });
  it('keeps a non-final receipt pending', async () => {
    const reader = new ArcJsonRpcReader('https://rpc.example.com', rpc({ eth_getTransactionReceipt: receipt, 'eth_getBlockByNumber:finalized': { hash: blockHash, number: '0x9' } }));
    expect((await reader.receipt(txHash))?.status).toBe('pending');
  });
  it('keeps removed or noncanonical logs pending', async () => {
    const reader = new ArcJsonRpcReader('https://rpc.example.com', rpc({ eth_getTransactionReceipt: { ...receipt, logs: [{ ...receipt.logs[0], removed: true }] } }));
    expect((await reader.receipt(txHash))?.status).toBe('pending');
  });
  it('returns null when receipt unavailable', async () => {
    expect(await new ArcJsonRpcReader('https://rpc.example.com', rpc({})).receipt(txHash)).toBeNull();
  });
  it('rejects mismatched transaction hashes and RPC errors', async () => {
    const reader = new ArcJsonRpcReader('https://rpc.example.com', rpc({ eth_getTransactionReceipt: { ...receipt, transactionHash: blockHash } }));
    await expect(reader.receipt(txHash)).rejects.toThrow('hash mismatch');
    const bad = vi.fn(async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { message: 'private provider detail' } }))) as unknown as typeof fetch;
    await expect(new ArcJsonRpcReader('https://rpc.example.com', bad).chainId()).rejects.toThrow('invalid or unavailable');
  });
  it('does not follow redirects or return provider HTTP details', async () => {
    const bad = vi.fn(async () => new Response('private provider detail', { status: 429 })) as unknown as typeof fetch;
    await expect(new ArcJsonRpcReader('https://rpc.example.com', bad).chainId()).rejects.toThrow('request unavailable');
    expect(vi.mocked(bad).mock.calls[0]?.[1]?.redirect).toBe('error');
  });
});
