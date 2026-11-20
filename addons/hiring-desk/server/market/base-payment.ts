/** Independent, read-only Base USDC verification. No signing or send-transaction API. */
export const BASE_CHAIN_ID = 8453;
export const BASE_USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
export const BASE_USDC_DECIMALS = 6;
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const ADDRESS = /^0x[0-9a-f]{40}$/i, HASH = /^0x[0-9a-f]{64}$/i;
const quantity = (x: unknown): bigint => { if (typeof x !== 'string' || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(x)) throw new Error('Invalid RPC quantity'); return BigInt(x); };
const equal = (a: unknown, b: string): boolean => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
const object = (x: unknown): Record<string, unknown> => { if (!x || typeof x !== 'object' || Array.isArray(x)) throw new Error('Invalid RPC object'); return x as Record<string, unknown>; };
export interface BasePaymentTerms { chainId: number; tokenAddress: string; payer: string; recipient: string; amountAtomic: string }
export interface BaseRpc { request(method: string, params: unknown[]): Promise<unknown> }
export type BasePaymentVerification = { status: 'confirmed'; txHash: string; blockNumber: string; confirmations: number } | { status: 'invalid' | 'pending' | 'unavailable'; reason: string };
function validTerms(t: BasePaymentTerms): boolean {
  return !!t && t.chainId === BASE_CHAIN_ID && equal(t.tokenAddress, BASE_USDC_ADDRESS)
    && ADDRESS.test(t.payer) && ADDRESS.test(t.recipient) && !/^0x0{40}$/i.test(t.payer) && !/^0x0{40}$/i.test(t.recipient)
    && typeof t.amountAtomic === 'string' && /^[1-9][0-9]{0,77}$/.test(t.amountAtomic) && BigInt(t.amountAtomic) < (1n << 256n);
}
export function baseTransferData(terms: BasePaymentTerms): string {
  if (!validTerms(terms)) throw new Error('Invalid Base payment terms');
  return `0xa9059cbb${terms.recipient.slice(2).toLowerCase().padStart(64, '0')}${BigInt(terms.amountAtomic).toString(16).padStart(64, '0')}`;
}
export async function verifyBaseTransfer(terms: BasePaymentTerms, txHash: string, rpc: BaseRpc, requiredConfirmations = 2): Promise<BasePaymentVerification> {
  const invalid = (reason: string): BasePaymentVerification => ({ status: 'invalid', reason });
  if (!validTerms(terms) || !HASH.test(txHash) || !Number.isSafeInteger(requiredConfirmations) || requiredConfirmations < 1 || requiredConfirmations > 1000) return invalid('Invalid Base terms, transaction hash or confirmation policy');
  try {
    if (quantity(await rpc.request('eth_chainId', [])) !== BigInt(BASE_CHAIN_ID)) return { status: 'unavailable', reason: 'RPC is connected to the wrong chain; payment outcome is unknown' };
    const rawTx = await rpc.request('eth_getTransactionByHash', [txHash]);
    const rawReceipt = await rpc.request('eth_getTransactionReceipt', [txHash]);
    if (rawTx === null || rawReceipt === null) return { status: 'pending', reason: 'Transaction or receipt is pending; reconcile before another transfer' };
    const tx = object(rawTx), receipt = object(rawReceipt);
    if (!equal(tx.hash, txHash) || !equal(receipt.transactionHash, txHash)) return invalid('Transaction/receipt hash mismatch');
    if (quantity(tx.chainId) !== BigInt(BASE_CHAIN_ID)) return invalid('Transaction chain mismatch');
    if (quantity(receipt.status) !== 1n) return invalid('Transaction failed');
    if (!equal(tx.from, terms.payer) || !equal(receipt.from, terms.payer) || !equal(tx.to, terms.tokenAddress) || !equal(receipt.to, terms.tokenAddress)) return invalid('Sender or token target mismatch');
    if (quantity(tx.value) !== 0n || !equal(tx.input, baseTransferData(terms))) return invalid('Transaction is not the exact zero-value token transfer');
    if (tx.data !== undefined && !equal(tx.data, baseTransferData(terms))) return invalid('Conflicting transfer calldata');
    if (!HASH.test(String(receipt.blockHash)) || !equal(tx.blockHash, String(receipt.blockHash)) || quantity(tx.blockNumber) !== quantity(receipt.blockNumber)) return { status: 'unavailable', reason: 'Transaction/receipt canonical block is inconsistent; reconcile before another transfer' };
    const logs = receipt.logs;
    if (!Array.isArray(logs)) return invalid('Receipt logs unavailable');
    const transfers = logs.map(object).filter(l => equal(l.address, terms.tokenAddress) && Array.isArray(l.topics) && equal(l.topics[0], TRANSFER_TOPIC));
    if (transfers.length !== 1) return invalid('Expected exactly one token Transfer log');
    const log = transfers[0]!, topics = log.topics as unknown[];
    if (topics.length !== 3 || !equal(topics[1], `0x${terms.payer.slice(2).toLowerCase().padStart(64, '0')}`) || !equal(topics[2], `0x${terms.recipient.slice(2).toLowerCase().padStart(64, '0')}`) || typeof log.data !== 'string' || !/^0x[0-9a-f]{64}$/i.test(log.data) || BigInt(log.data) !== BigInt(terms.amountAtomic) || log.removed === true || !equal(log.transactionHash, txHash) || !equal(log.blockHash, String(receipt.blockHash)) || quantity(log.blockNumber) !== quantity(receipt.blockNumber)) return invalid('Transfer event binding mismatch');
    quantity(log.logIndex);
    const blockNumber = quantity(receipt.blockNumber), head = quantity(await rpc.request('eth_blockNumber', []));
    const confirmations = head >= blockNumber ? head - blockNumber + 1n : 0n;
    if (confirmations < BigInt(requiredConfirmations)) return { status: 'pending', reason: 'Payment needs more confirmations' };
    const block = object(await rpc.request('eth_getBlockByNumber', [receipt.blockNumber, false]));
    if (!equal(block.hash, String(receipt.blockHash)) || quantity(block.number) !== blockNumber) return { status: 'pending', reason: 'Payment block changed; reconcile canonical receipt before another transfer' };
    return { status: 'confirmed', txHash: txHash.toLowerCase(), blockNumber: blockNumber.toString(), confirmations: Number(confirmations > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : confirmations) };
  } catch { return { status: 'unavailable', reason: 'Independent Base verification is unavailable; reconcile before another transfer' }; }
}
/** Bounded HTTPS JSON-RPC transport. Error text never echoes RPC credentials or response bodies. */
export function createBaseRpc(url: string, options: { fetcher?: typeof fetch; timeoutMs?: number; maxResponseBytes?: number } = {}): BaseRpc {
  const endpoint = new URL(url), timeoutMs = options.timeoutMs ?? 10_000, max = options.maxResponseBytes ?? 2_000_000;
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.hash || !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000 || !Number.isSafeInteger(max) || max < 1 || max > 10_000_000) throw new Error('Invalid Base RPC configuration');
  let id = 0;
  return { async request(method, params) {
    if (!['eth_chainId','eth_getTransactionByHash','eth_getTransactionReceipt','eth_blockNumber','eth_getBlockByNumber'].includes(method)) throw new Error('Unsupported read-only Base RPC method');
    const requestId = ++id, response = await (options.fetcher ?? fetch)(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(timeoutMs), body: JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) });
    if (!response.ok || !response.body) throw new Error('Base RPC unavailable');
    const reader = response.body.getReader(); let length = 0; const chunks: Uint8Array[] = [];
    try { while (true) { const part = await reader.read(); if (part.done) break; length += part.value.length; if (length > max) throw new Error('Base RPC response exceeds bounds'); chunks.push(part.value); } } finally { await reader.cancel().catch(() => {}); }
    const bytes = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const envelope = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    if (envelope.jsonrpc !== '2.0' || envelope.id !== requestId || envelope.error || !Object.hasOwn(envelope, 'result')) throw new Error('Invalid Base RPC response');
    return envelope.result;
  } };
}
