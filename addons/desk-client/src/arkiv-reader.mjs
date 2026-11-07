import { parseRecord } from '@secondbrain/desk-contracts/desk';

const HEX = /^0x[0-9a-f]{64}$/i;
const ADDRESS = /^0x[0-9a-f]{40}$/i;
const quantity = value => {
  if (typeof value !== 'string' || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value)) throw new Error('Unavailable: malformed block quantity');
  return BigInt(value);
};
const number = value => {
  const n = quantity(value);
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Unavailable: timestamp exceeds safe integer');
  return Number(n);
};
function text(value, label) {
  if (typeof value !== 'string' || !value || value.length > 200 || /[\x00-\x1f]/.test(value)) throw new Error(`Unavailable: configure ${label}`);
  return value;
}
function literal(value) { return "str('" + value.replaceAll("'", "''") + "')"; }

/** Read only a complete finalized snapshot. No payload encoding or payment proof is guessed. */
export async function readPublicEvidence({ rpcUrl, jobRef, domain = process.env.DESK_DOMAIN,
  schema = process.env.DESK_ARKIV_SCHEMA, recordAttribute = process.env.DESK_ARKIV_RECORD_ATTRIBUTE,
  fetchImpl = globalThis.fetch, maxPages = 100, pageSize = 100, timeoutMs = 10000, maxResponseBytes = 2_000_000 }) {
  text(domain, 'DESK_DOMAIN'); text(schema, 'DESK_ARKIV_SCHEMA'); text(recordAttribute, 'DESK_ARKIV_RECORD_ATTRIBUTE');
  const match = /^arkiv:([1-9][0-9]*)\/(0x[0-9a-f]+)$/i.exec(jobRef ?? '');
  if (!match || !HEX.test(match[2])) throw new Error('Unavailable: expected arkiv:<decimal-chain>/<hex-key>');
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 1000 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new Error('Unavailable: invalid pagination bounds');
  const url = new URL(rpcUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('Unavailable: RPC must use HTTPS without URL credentials');
  let requestId = 0;
  async function rpc(method, params) {
    const id = ++requestId;
    let response;
    try { response = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }), signal: AbortSignal.timeout(timeoutMs), redirect: 'error', credentials: 'omit' }); }
    catch { throw new Error('Unavailable: public RPC request failed'); }
    if (!response.ok) throw new Error('Unavailable: public RPC returned an HTTP error');
    const chunks = []; let size = 0;
    if (!response.body) throw new Error('Unavailable: missing RPC response');
    try {
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > maxResponseBytes) throw new Error('response limit');
        chunks.push(chunk);
      }
    } catch { throw new Error(size > maxResponseBytes ? 'Unavailable: RPC response exceeds limit' : 'Unavailable: RPC response stream failed'); }
    let envelope;
    try { envelope = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('Unavailable: malformed RPC response'); }
    if (envelope.jsonrpc !== '2.0' || envelope.id !== id || envelope.error || !Object.hasOwn(envelope, 'result')) throw new Error('Unavailable: RPC rejected or malformed response');
    return envelope.result;
  }
  if (quantity(await rpc('eth_chainId', [])) !== BigInt(match[1])) throw new Error('Unavailable: RPC chain differs from job');
  const observations = [], keys = new Set(); let cursor, snapshot, block, now, earliestExpiry;
  for (let page = 0; ; page++) {
    if (page >= maxPages) throw new Error('Unavailable: pagination limit reached');
    const filter = `arkiv.schema = ${literal(schema)}${cursor ? ` AND $key > key(${cursor})` : ''} ORDER BY $key ASC`;
    const result = await rpc('arkiv_query', [filter, { select: { key: true, creator: true, owner: true, creationFlags: true, createdAt: true, updatedAt: true, expiresAt: true, attributes: true }, limit: `0x${pageSize.toString(16)}` }]);
    if (!result || !Array.isArray(result.data) || result.data.length > pageSize) throw new Error('Unavailable: malformed query page');
    if (!snapshot) {
      block = quantity(result.blockNumber);
      snapshot = await rpc('eth_getBlockByNumber', [result.blockNumber, false]);
      if (!snapshot || quantity(snapshot.number) !== block || !/^0x[0-9a-f]{64}$/i.test(snapshot.hash ?? '')) throw new Error('Unavailable: snapshot block missing');
      now = number(snapshot.timestamp);
    }
    // Raw queries cannot pin a block. A later snapshot could omit a deleted record.
    if (quantity(result.blockNumber) !== block) throw new Error('Unavailable: query snapshot drift');
    for (const entity of result.data) {
      if (!HEX.test(entity.key ?? '') || keys.has(entity.key.toLowerCase()) || (cursor && BigInt(entity.key) <= BigInt(cursor))) throw new Error('Unavailable: invalid or repeated entity key');
      cursor = entity.key; keys.add(cursor.toLowerCase());
      if (entity.creationFlags?.readonly !== true || entity.owner !== entity.creator) throw new Error('Unavailable: creator-authored immutable content is not established');
      if (!ADDRESS.test(entity.creator ?? '') || quantity(entity.createdAt) > block || quantity(entity.updatedAt) > block || quantity(entity.createdAt) > quantity(entity.updatedAt) || quantity(entity.expiresAt) <= block) throw new Error('Unavailable: expired or unfinalized entity');
      earliestExpiry = earliestExpiry === undefined || quantity(entity.expiresAt) < earliestExpiry ? quantity(entity.expiresAt) : earliestExpiry;
      if (!Array.isArray(entity.attributes)) throw new Error('Unavailable: missing record attributes');
      const fields = entity.attributes.filter(a => a.name === recordAttribute);
      if (fields.length !== 1 || fields[0].type !== 'str' || typeof fields[0].value !== 'string' || Buffer.byteLength(fields[0].value) > 65536) throw new Error('Unavailable: configured JSON record attribute missing or oversized');
      let record;
      try { record = parseRecord(JSON.parse(fields[0].value)); } catch { throw new Error('Unavailable: malformed desk record'); }
      if (record.domain !== domain || record.chainId !== `arkiv:${match[1]}`) throw new Error('Unavailable: record domain or chain mismatch');
      const creator = record.type === 'provider' ? record.owner : record.type === 'job' || record.type === 'acceptance' ? record.client : record.type === 'payment' ? record.payer : record.provider;
      if (!ADDRESS.test(creator) || creator !== entity.creator) throw new Error('Unavailable: immutable creator differs from record authority');
      // Creator time comes from a finalized block header, never from mutable payload.
      const creation = await rpc('eth_getBlockByNumber', [entity.createdAt, false]);
      if (!creation || quantity(creation.number) !== quantity(entity.createdAt) || !/^0x[0-9a-f]{64}$/i.test(creation.hash ?? '')) throw new Error('Unavailable: creation block missing');
      const observedAt = number(creation.timestamp);
      if (observedAt > now) throw new Error('Unavailable: invalid creation timestamp');
      observations.push({ ref: `arkiv:${match[1]}/${entity.key}`, creator: entity.creator, observedAt, finalized: true, record });
    }
    if (result.data.length < pageSize) break;
  }
  const finalized = await rpc('eth_getBlockByNumber', ['finalized', false]);
  if (!finalized || quantity(finalized.number) < block || !/^0x[0-9a-f]{64}$/i.test(finalized.hash ?? '')) throw new Error('Unavailable: snapshot not finalized; retry after finality');
  if (earliestExpiry !== undefined && earliestExpiry <= quantity(finalized.number)) throw new Error('Unavailable: entity expired while waiting for finality');
  const end = await rpc('eth_getBlockByNumber', [snapshot.number, false]);
  if (!end || end.hash !== snapshot.hash) throw new Error('Unavailable: snapshot changed during read');
  if (!observations.some(o => o.ref.toLowerCase() === jobRef.toLowerCase() && o.record.type === 'job')) throw new Error('Unavailable: job not present in finalized snapshot');
  return { observations, verifiedPayments: [] };
}

/** Check independently downloaded bytes; this function makes no network requests. */
export async function verifyArtifactBytes(bytes, expectedHash, maxBytes = 2_000_000) {
  if (!(bytes instanceof Uint8Array) || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || bytes.byteLength > maxBytes || !/^sha256:[0-9a-f]{64}$/.test(expectedHash ?? '')) throw new Error('Unavailable: invalid or oversized artifact');
  const { createHash } = await import('node:crypto');
  const actualHash = 'sha256:' + createHash('sha256').update(bytes).digest('hex');
  if (actualHash !== expectedHash) throw new Error('Artifact hash mismatch');
  return { verified: true, artifactHash: actualHash, byteLength: bytes.byteLength };
}
