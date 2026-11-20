import { createPublicClient, custom } from 'viem';
import { mainnet } from 'viem/chains';
import { normalize } from 'viem/ens';
import type { EnsResolver } from '../desk/identity/types.js';
export interface MarketEnsOptions { rpcUrl: string; chainId: string | number; fetcher?: typeof fetch; timeoutMs?: number; maxResponseBytes?: number }
export interface MarketEnsResolver extends EnsResolver { rpcUrl: string; chainId: string }
/** ENSIP-15 and finalized Universal Resolver reads using viem's official mainnet
 * deployment. Offchain CCIP fetching is disabled; unsupported names fail closed. */
export function createMarketEnsResolver(options: MarketEnsOptions): MarketEnsResolver {
  const endpoint = new URL(options.rpcUrl), chainId = String(options.chainId);
  const timeoutMs = options.timeoutMs ?? 10_000, max = options.maxResponseBytes ?? 65_536;
  if (chainId !== String(mainnet.id)) throw new Error('Market ENS supports Ethereum mainnet only');
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.hash || !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000 || !Number.isSafeInteger(max) || max < 1 || max > 1_000_000) throw new Error('Invalid market ENS configuration');
  let id = 0;
  const request = async ({ method, params = [] }: { method: string; params?: unknown }): Promise<unknown> => {
    if (!['eth_chainId', 'eth_call'].includes(method)) throw new Error('Unsupported ENS read method');
    const requestId = ++id, body = JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params });
    if (Buffer.byteLength(body) > 16_000) throw new Error('ENS request exceeds bounds');
    const response = await (options.fetcher ?? fetch)(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(timeoutMs), body });
    if (!response.ok || !response.body) throw new Error('ENS read unavailable');
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
    try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > max) throw new Error('ENS response exceeds bounds'); chunks.push(part.value); } }
    finally { await reader.cancel().catch(() => {}); }
    const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid ENS RPC response');
    const envelope = value as Record<string, unknown>;
    if (envelope.jsonrpc !== '2.0' || envelope.id !== requestId || envelope.error || !Object.hasOwn(envelope, 'result')) throw new Error('Invalid ENS RPC response');
    return envelope.result;
  };
  const client = createPublicClient({ chain: mainnet, cacheTime: 0, ccipRead: false, transport: custom({ request }, { retryCount: 0 }) });
  const normalizeName = (name: string): string => {
    if (typeof name !== 'string' || !name || name.length > 255 || Buffer.byteLength(name) > 1024) throw new Error('Invalid ENS name');
    const normalized = normalize(name);
    if (!normalized || normalized.length > 255) throw new Error('Invalid ENS name');
    return normalized;
  };
  return { rpcUrl: options.rpcUrl, chainId, normalizeName,
    async resolveAddress(name: string): Promise<string | null> {
      const normalized = normalizeName(name);
      try {
        const actual = await request({ method: 'eth_chainId' });
        if (typeof actual !== 'string' || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(actual) || BigInt(actual) !== BigInt(mainnet.id)) throw new Error('ENS RPC chain mismatch');
        return await client.getEnsAddress({ name: normalized, blockTag: 'finalized', strict: true, gatewayUrls: [] });
      } catch { throw new Error('Finalized ENS resolution is unavailable'); }
    },
  };
}
