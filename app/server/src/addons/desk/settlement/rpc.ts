import { z } from 'zod';
import type { ArcReadClient, ArcReceipt, ArcTransaction } from './arc.js';

const quantity = z.string().regex(/^0x(?:0|[1-9a-f][0-9a-f]*)$/i);
const hash = z.string().regex(/^0x[0-9a-f]{64}$/i);
const address = z.string().regex(/^0x[0-9a-f]{40}$/i);
const bytes = z.string().regex(/^0x(?:[0-9a-f]{2})*$/i);
const transaction = z.object({ hash, from: address, to: address.nullable(), value: quantity, input: bytes });
const receipt = z.object({
  transactionHash: hash, status: quantity.optional(), blockHash: hash.nullable(), blockNumber: quantity.nullable(),
  logs: z.array(z.object({ address, topics: z.array(hash).max(4), data: bytes, logIndex: quantity, removed: z.boolean().optional() })).max(1000),
});
const block = z.object({ hash, number: quantity });

export interface ArcRpcReceipt extends ArcReceipt { blockNumber?: string }

/** Server-only JSON-RPC reader. It has no signing or submission method. */
export class ArcJsonRpcReader implements ArcReadClient {
  private sequence = 0;
  private readonly url: URL;
  constructor(rpcUrl: string, private readonly fetcher: typeof fetch = fetch, private readonly timeoutMs = 15_000) {
    this.url = new URL(rpcUrl);
    if (!['http:', 'https:'].includes(this.url.protocol) || this.url.hash || timeoutMs < 1) throw new Error('Invalid desk RPC configuration');
  }

  async chainId(): Promise<string> { return BigInt(quantity.parse(await this.request('eth_chainId', []))).toString(); }

  async transaction(txHash: string): Promise<ArcTransaction | null> {
    hash.parse(txHash);
    const value = await this.request('eth_getTransactionByHash', [txHash]);
    if (value === null) return null;
    const tx = transaction.parse(value);
    if (tx.hash.toLowerCase() !== txHash.toLowerCase()) throw new Error('RPC transaction hash mismatch');
    return { from: tx.from, to: tx.to, value: tx.value, input: tx.input };
  }

  async receipt(txHash: string): Promise<ArcRpcReceipt | null> {
    hash.parse(txHash);
    const value = await this.request('eth_getTransactionReceipt', [txHash]);
    if (value === null) return null;
    const r = receipt.parse(value);
    if (r.transactionHash.toLowerCase() !== txHash.toLowerCase()) throw new Error('RPC receipt hash mismatch');
    const result: ArcRpcReceipt = {
      transactionHash: r.transactionHash,
      status: 'pending',
      logs: r.logs.map(log => ({ address: log.address, topics: log.topics, data: log.data, logIndex: BigInt(log.logIndex).toString() })),
      ...(r.blockNumber === null ? {} : { blockNumber: BigInt(r.blockNumber).toString() }),
    };
    if (!r.blockNumber || !r.blockHash || r.logs.some(log => log.removed)) return result;
    // Fail closed when the RPC cannot demonstrate finalized, canonical inclusion.
    // No latest-block fallback turns an unsupported finality read into success.
    const finalizedValue = await this.request('eth_getBlockByNumber', ['finalized', false]);
    if (finalizedValue === null) return result;
    const finalized = block.parse(finalizedValue);
    if (BigInt(finalized.number) < BigInt(r.blockNumber)) return result;
    const canonicalValue = await this.request('eth_getBlockByNumber', [r.blockNumber, false]);
    if (canonicalValue === null) return result;
    const canonical = block.parse(canonicalValue);
    if (canonical.hash.toLowerCase() !== r.blockHash.toLowerCase() || BigInt(canonical.number) !== BigInt(r.blockNumber)) return result;
    result.status = r.status === '0x1' ? 'success' : r.status === '0x0' ? 'reverted' : 'unknown';
    return result;
  }

  private async request(method: string, params: unknown[]): Promise<unknown> {
    const id = ++this.sequence;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetcher(this.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }), signal: controller.signal, redirect: 'error' });
      if (!response.ok) throw new Error('Desk RPC request unavailable');
      const maxBytes = 2_000_000;
      if (Number(response.headers.get('content-length')) > maxBytes) throw new Error('Desk RPC response exceeded limit');
      const reader = response.body?.getReader();
      if (!reader) throw new Error('Desk RPC response is empty');
      const chunks: Uint8Array[] = []; let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          size += value.byteLength;
          if (size > maxBytes) { await reader.cancel(); throw new Error('Desk RPC response exceeded limit'); }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      const body = z.object({ jsonrpc: z.literal('2.0'), id: z.number(), result: z.unknown().optional(), error: z.unknown().optional() }).parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      if (body.id !== id || body.error !== undefined || !Object.hasOwn(body, 'result')) throw new Error('Desk RPC response is invalid or unavailable');
      return body.result;
    } finally { clearTimeout(timer); }
  }
}
