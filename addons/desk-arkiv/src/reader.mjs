import { ENTITY_EVENTS_ABI } from '@arkiv-network/sdk';
import { decodeEventLog, decodeFunctionResult, encodeFunctionData, parseAbi, toEventSelector } from 'viem';
import { ARKIV_ADDRESS, SCHEMA_TAG, decodeRecordAttributes, idempotencyHash, prepareRecordTransaction, recordAuthor } from './codec.mjs';
const KEY = /^0x[0-9a-f]{64}$/i, ADDRESS = /^0x[0-9a-f]{40}$/i;
const num = value => { if (typeof value !== 'string' || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value)) throw new Error('Unavailable: invalid quantity'); return BigInt(value); };
const safe = value => { if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Unavailable: unsafe timestamp'); return Number(value); };
const literal = value => "str('" + value.replaceAll("'", "''") + "')";
const CREATE_TOPIC = toEventSelector('EntityCreated(bytes32,address,uint64,uint8)');
const NONCE_ABI = parseAbi(['function entityNonce(address owner) external view returns (uint64)']);

/** Concrete read-only implementation of the existing ArkivDeskClient boundary. */
export class LiveArkivDeskClient {
  constructor({ rpcUrl, domain, chainId, fetchImpl = globalThis.fetch, timeoutMs = 10000, maxResponseBytes = 2_000_000 }) {
    const url = new URL(rpcUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || !domain || typeof domain !== 'string' || new TextEncoder().encode(domain).length > 128 || !Number.isSafeInteger(chainId) || chainId < 1) throw new Error('Invalid Arkiv configuration');
    Object.assign(this, { rpcUrl: url, domain, chainId, fetchImpl, timeoutMs, maxResponseBytes }); this.requestId = 0;
  }
  async rpc(method, params) {
    const id = ++this.requestId;
    let response, raw = '', length = 0;
    try {
      response = await this.fetchImpl(this.rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }), credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs) });
      if (!response.ok || !response.body) throw Error();
      const decoder = new TextDecoder();
      for await (const chunk of response.body) { length += chunk.length; if (length > this.maxResponseBytes) throw Error(); raw += decoder.decode(chunk, { stream: true }); }
      raw += decoder.decode();
      const envelope = JSON.parse(raw);
      if (envelope.id !== id || envelope.jsonrpc !== '2.0' || envelope.error || !Object.hasOwn(envelope, 'result')) throw Error();
      return envelope.result;
    } catch { throw new Error('Unavailable: Arkiv RPC request failed or exceeded bounds'); }
  }
  async checkChain() { if (num(await this.rpc('eth_chainId', [])) !== BigInt(this.chainId)) throw new Error('Unavailable: Arkiv chain mismatch'); }
  async block(tag) {
    const b = await this.rpc('eth_getBlockByNumber', [typeof tag === 'bigint' ? `0x${tag.toString(16)}` : tag, false]);
    if (!b || !KEY.test(b.hash ?? '')) throw new Error('Unavailable: missing canonical block');
    num(b.number); num(b.timestamp); return b;
  }
  async finality(snapshot) {
    const finalized = await this.block('finalized');
    if (num(finalized.number) < num(snapshot.number)) return false;
    const canonical = await this.block(snapshot.number);
    if (canonical.hash !== snapshot.hash) throw new Error('Unavailable: canonical snapshot changed');
    return true;
  }
  async decode(entity, snapshot) {
    if (!entity || !KEY.test(entity.key ?? '') || !ADDRESS.test(entity.creator ?? '') || entity.owner !== entity.creator || entity.creationFlags?.readonly !== true) throw new Error('Unavailable: missing creator-authorized immutable entity');
    const height = num(snapshot.number), expiry = num(entity.expiresAt), created = num(entity.createdAt), updated = num(entity.updatedAt);
    if (created > updated || updated > height || expiry <= height) throw new Error('Unavailable: expired or unfinalized entity');
    const { record } = decodeRecordAttributes(entity.attributes);
    if (record.domain !== this.domain || record.chainId !== `arkiv:${this.chainId}` || recordAuthor(record) !== entity.creator) throw new Error('Unavailable: record authority/domain/chain mismatch');
    const creation = await this.block(entity.createdAt);
    if (num(creation.number) !== created || num(creation.timestamp) > num(snapshot.timestamp)) throw new Error('Unavailable: invalid creation block');
    const finalized = await this.finality(snapshot);
    const finalHead = await this.block('finalized');
    if (expiry <= num(finalHead.number)) throw new Error('Unavailable: entity expired during finality');
    // Expiry is a block height. Unix projection uses the SDK's documented nominal 2-second blocks.
    return { key: entity.key, creator: entity.creator, createdAt: safe(num(creation.timestamp)), expiresAt: safe(num(snapshot.timestamp) + (expiry - height) * 2n), finalized, record };
  }
  async page({ afterKey, limit, atBlock } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || (afterKey !== undefined && !KEY.test(afterKey))) throw new Error('Invalid Arkiv page');
    await this.checkChain();
    const query = `arkiv.schema = ${literal(SCHEMA_TAG)} AND domain = ${literal(this.domain)}${afterKey ? ` AND $key > key(${afterKey})` : ''} ORDER BY $key ASC`;
    const result = await this.rpc('arkiv_query', [query, { select: { key: true, creator: true, owner: true, createdAt: true, updatedAt: true, expiresAt: true, creationFlags: true, attributes: true }, limit: `0x${limit.toString(16)}` }]);
    const height = num(result?.blockNumber);
    if (!Array.isArray(result.data) || result.data.length > limit || (atBlock !== undefined && atBlock !== height)) throw new Error('Unavailable: Arkiv snapshot drift or invalid page');
    const snapshot = await this.block(result.blockNumber);
    if (num(snapshot.number) !== height) throw new Error('Unavailable: missing query snapshot');
    const rows = []; let cursor = afterKey;
    for (const entity of result.data) {
      if (!KEY.test(entity.key ?? '') || (cursor && BigInt(entity.key) <= BigInt(cursor))) throw new Error('Unavailable: unordered keyset page');
      rows.push(await this.decode(entity, snapshot)); cursor = entity.key;
    }
    const finalized = await this.finality(snapshot);
    return { rows: rows.map(r => ({ ...r, finalized: r.finalized && finalized })), blockNumber: height, finalized };
  }
  async get(key) {
    if (!KEY.test(key ?? '')) throw new Error('Invalid Arkiv key');
    await this.checkChain();
    const before = await this.block('latest');
    const entity = await this.rpc('arkiv_getEntity', [key]);
    const after = await this.block('latest');
    if (before.hash !== after.hash) throw new Error('Unavailable: entity snapshot drift');
    if (!entity) return null;
    if (entity.key !== key) throw new Error('Unavailable: entity key mismatch');
    return this.decode(entity, after);
  }
  /** @returns {Promise<never>} */
  async create() { throw new Error('Unavailable: browser signature required; use prepareRecordTransaction'); }
  async findByIdempotencyKey(key) {
    const hash = idempotencyHash(key); let cursor, snapshot; const matches = [];
    for (let page = 0; page < 100; page++) {
      const result = await this.page({ afterKey: cursor, limit: 100, atBlock: snapshot }); snapshot = result.blockNumber;
      if (!result.finalized) throw new Error('Unavailable: idempotency lookup has not finalized');
      for (const row of result.rows) {
        // Re-read the canonical attributes to bind lookup to the permanent idempotency attribute.
        const entity = await this.rpc('arkiv_getEntity', [row.key]);
        if (entity && decodeRecordAttributes(entity.attributes).idempotencyHash === hash) matches.push(row.key);
      }
      if (matches.length > 1) throw new Error('Unavailable: conflicting idempotency records');
      if (result.rows.length < 100) {
        if (!matches.length) return null;
        const confirmed = await this.confirmation(matches[0]);
        if (!confirmed) throw new Error('Unavailable: matching idempotency record is pending reconciliation');
        return confirmed;
      }
      cursor = result.rows.at(-1).key;
    }
    throw new Error('Unavailable: idempotency scan exceeds limit');
  }
  async confirmation(key) {
    const row = await this.get(key);
    if (!row || !row.finalized) return null;
    // Event/receipt readback recovers the real creation transaction; no synthetic tx hashes.
    const entity = await this.rpc('arkiv_getEntity', [key]);
    const logs = await this.rpc('eth_getLogs', [{ address: ARKIV_ADDRESS, fromBlock: entity.createdAt, toBlock: entity.createdAt, topics: [CREATE_TOPIC, key] }]);
    if (!Array.isArray(logs) || logs.length !== 1) throw new Error('Unavailable: creation transaction evidence missing');
    const log = logs[0], block = await this.block(entity.createdAt);
    if (log.removed || log.address?.toLowerCase() !== ARKIV_ADDRESS.toLowerCase() || !KEY.test(log.transactionHash ?? '') || log.blockHash !== block.hash || num(log.blockNumber) !== num(entity.createdAt)) throw new Error('Unavailable: invalid creation log');
    const decoded = decodeEventLog({ abi: ENTITY_EVENTS_ABI, data: log.data, topics: log.topics });
    if (decoded.eventName !== 'EntityCreated' || decoded.args.entityKey !== key || decoded.args.owner.toLowerCase() !== row.creator.toLowerCase() || (decoded.args.creationFlags & 1) !== 1) throw new Error('Unavailable: creation event binding mismatch');
    const receipt = await this.rpc('eth_getTransactionReceipt', [log.transactionHash]);
    if (!receipt || receipt.status !== '0x1' || receipt.blockHash !== block.hash || receipt.transactionHash !== log.transactionHash) throw new Error('Unavailable: creation receipt unconfirmed');
    return { key, transactionHash: log.transactionHash, confirmed: true, record: row.record };
  }
  async prepare(record, idempotencyKey, expiresAtBlock) {
    await this.checkChain();
    const signer = recordAuthor(record);
    const existing = await this.findByIdempotencyKey(idempotencyKey);
    if (existing) throw new Error('Idempotency key already published; reconcile existing record');
    const latest = await this.block('latest');
    const data = encodeFunctionData({ abi: NONCE_ABI, functionName: 'entityNonce', args: [signer] });
    const entityNonce = decodeFunctionResult({ abi: NONCE_ABI, functionName: 'entityNonce', data: await this.rpc('eth_call', [{ to: ARKIV_ADDRESS, data }, latest.number]) });
    return prepareRecordTransaction(record, { domain: this.domain, chainId: this.chainId, signer, idempotencyKey, currentBlock: num(latest.number), expiresAtBlock, entityNonce });
  }
}
