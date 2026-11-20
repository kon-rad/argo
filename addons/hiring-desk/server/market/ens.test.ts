import { describe, expect, it } from 'vitest';
import { decodeFunctionData, encodeAbiParameters, encodeFunctionResult, parseAbi } from 'viem';
import { mainnet } from 'viem/chains';
import { createMarketEnsResolver } from './ens.js';
// Exact signature in viem/constants/abis.ts universalResolverResolveAbi.
const abi = parseAbi(['function resolveWithGateways(bytes name, bytes data, string[] gateways) view returns (bytes, address)']);
const resolved = '0x0000000000000000000000000000000000000002', resolver = '0x0000000000000000000000000000000000000003';
const result = (address: `0x${string}`) => encodeFunctionResult({ abi, functionName: 'resolveWithGateways', result: [encodeAbiParameters([{ type: 'address' }], [address]), resolver] });
function rpc(handler: (method: string, params: unknown[]) => unknown) {
  return (async (_url: unknown, init?: RequestInit) => {
    expect(init?.redirect).toBe('error'); expect(init?.credentials).toBe('omit'); expect(init?.signal).toBeInstanceOf(AbortSignal);
    const input = JSON.parse(String(init?.body));
    return Response.json({ jsonrpc: '2.0', id: input.id, result: handler(input.method, input.params) });
  }) as typeof fetch;
}
describe('concrete market ENS resolver', () => {
  it('normalizes ENSIP-15 names and calls official mainnet Universal Resolver at finalized', async () => {
    const methods: string[] = [];
    const reader = createMarketEnsResolver({ rpcUrl: 'https://rpc.example', chainId: '1', fetcher: rpc((method, params) => {
      methods.push(method); if (method === 'eth_chainId') return '0x1';
      expect(method).toBe('eth_call'); expect(params[1]).toBe('finalized');
      const call = params[0] as { to: string; data: `0x${string}` };
      expect(call.to.toLowerCase()).toBe(mainnet.contracts.ensUniversalResolver.address.toLowerCase());
      const decoded = decodeFunctionData({ abi, data: call.data });
      expect(decoded.functionName).toBe('resolveWithGateways'); expect(decoded.args[2]).toEqual([]);
      return result(resolved);
    }) });
    expect(reader.rpcUrl).toBe('https://rpc.example'); expect(reader.chainId).toBe('1');
    expect(reader.normalizeName('FIXTURE.eth')).toBe('fixture.eth');
    expect(() => reader.normalizeName('bad..eth')).toThrow(); expect(() => reader.normalizeName('a'.repeat(256))).toThrow();
    expect(await reader.resolveAddress('FIXTURE.eth')).toBe(resolved);
    expect(methods).toEqual(['eth_chainId', 'eth_call']);
  });
  it('returns null for a zero address, not verified identity authority', async () => {
    const reader = createMarketEnsResolver({ rpcUrl: 'https://rpc.example', chainId: 1, fetcher: rpc(method => method === 'eth_chainId' ? '0x1' : result('0x0000000000000000000000000000000000000000')) });
    expect(await reader.resolveAddress('fixture.eth')).toBeNull();
  });
  it('rejects unsupported chains and insecure or unbounded config before reading', () => {
    for (const chainId of ['8453', '11155111', '01', 0]) expect(() => createMarketEnsResolver({ rpcUrl: 'https://rpc.example', chainId })).toThrow('mainnet');
    for (const rpcUrl of ['http://rpc.example', 'file://localhost/a', 'https://user:pass@rpc.example', 'https://rpc.example/#fragment']) expect(() => createMarketEnsResolver({ rpcUrl, chainId: 1 })).toThrow('configuration'); // public-ok: synthetic credentials test rejection only.
    expect(() => createMarketEnsResolver({ rpcUrl: 'https://rpc.example', chainId: 1, timeoutMs: 60_000 })).toThrow();
    expect(() => createMarketEnsResolver({ rpcUrl: 'https://rpc.example', chainId: 1, maxResponseBytes: 1_000_001 })).toThrow();
  });
  it('checks RPC chain on every resolution and never resolves on the wrong chain', async () => {
    let calls = 0;
    const reader = createMarketEnsResolver({ rpcUrl: 'https://rpc.example', chainId: 1, fetcher: rpc(method => { calls++; expect(method).toBe('eth_chainId'); return '0x2105'; }) });
    await expect(reader.resolveAddress('fixture.eth')).rejects.toThrow('unavailable');
    await expect(reader.resolveAddress('fixture.eth')).rejects.toThrow('unavailable'); expect(calls).toBe(2);
  });
  it('rejects oversized, malformed and unavailable replies without leaking diagnostics', async () => {
    const variants = [
      (() => Promise.resolve(new Response('private-fixture-response', { status: 503 }))) as typeof fetch,
      (() => Promise.resolve(Response.json({ jsonrpc: '2.0', id: -1, result: '0x1' }))) as typeof fetch,
      (() => Promise.resolve(new Response('x'.repeat(1000)))) as typeof fetch,
      (() => Promise.reject(new Error('credential-bearing diagnostic'))) as typeof fetch,
    ];
    for (const fetcher of variants) await expect(createMarketEnsResolver({ rpcUrl: 'https://rpc.example', chainId: 1, maxResponseBytes: 100, fetcher }).resolveAddress('fixture.eth')).rejects.toThrow(/^Finalized ENS resolution is unavailable$/);
  });
});
