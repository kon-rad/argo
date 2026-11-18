import { defineSchema, str, bytes } from '@arkiv-network/sdk/schema';
import { MAX_LIFETIME, predictEntityKey } from '@arkiv-network/sdk/entity';
import { encodeAbiParameters, encodeFunctionData, parseAbi, parseAbiParameters, toHex, keccak256, isAddress, hexToBytes } from 'viem';
import { canonicalJson, parseRecord } from '@secondbrain/desk-contracts/desk';

// SDK 1.0.1 consts.ts/entity/operations.ts and official raw transaction reference.
export const ARKIV_ADDRESS = '0x4400000000000000000000000000000000000044';
export const SCHEMA_TAG = 'argo.hiring-desk.v1';
export const RECORD_ATTRIBUTE = 'record';
export const SDK_VERSION = '1.0.1';
export const EXECUTE_ABI = parseAbi(['function execute((uint8 operation, bytes operationData)[] ops) external returns (bytes32[] keys)']);
export const CREATE_PARAMS = parseAbiParameters('(uint128 salt,uint64 expiresAt,uint64 minLifetime,uint8 creationFlags,(bytes32 name,uint8 typeId,bytes value)[] attributes)');
/** @type {import('@arkiv-network/sdk/schema').Schema} */
export const DeskSchema = defineSchema(SCHEMA_TAG, { domain: str().indexed(), recordType: str().indexed(), record: bytes(), idem: str().indexed(), recordDigest: str().indexed() });
const utf8 = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true });
export const recordHash = record => keccak256(toHex(canonicalJson(parseRecord(record))));
export function idempotencyHash(key) {
  if (typeof key !== 'string' || key.length < 8 || key.length > 200 || key.trim() !== key || /[\x00-\x1f]/.test(key)) throw new Error('Invalid idempotency key');
  return keccak256(toHex(key));
}
export function recordAuthor(record) {
  const r = parseRecord(record);
  return r.type === 'provider' ? r.owner : r.type === 'job' || r.type === 'acceptance' ? r.client : r.type === 'payment' ? r.payer : r.provider;
}
function uint(value, bits, label) {
  if (typeof value !== 'bigint' || value < 0n || value >= 2n ** BigInt(bits)) throw new Error(`Invalid ${label}`);
  return value;
}
export function validateContext(record, { domain, chainId, signer }) {
  parseRecord(record); str(domain);
  if (!Number.isSafeInteger(chainId) || chainId < 1 || record.chainId !== `arkiv:${chainId}` || record.domain !== domain) throw new Error('Record domain or chain mismatch');
  if (!isAddress(signer) || !isAddress(recordAuthor(record)) || signer.toLowerCase() !== recordAuthor(record).toLowerCase()) throw new Error('Record signer mismatch');
}
export function encodeRecordAttributes(record, { domain, chainId, signer, idempotencyKey }) {
  validateContext(record, { domain, chainId, signer });
  const json = canonicalJson(record), recordBytes = utf8.encode(json);
  if (recordBytes.length > 128 * 1024) throw new Error('Record exceeds Arkiv byte limit');
  const values = {
    'arkiv.schema': str(SCHEMA_TAG), domain: str(domain), recordType: str(record.type),
    record: bytes(recordBytes), idem: str(idempotencyHash(idempotencyKey)), recordDigest: str(recordHash(record)),
  };
  return Object.entries(values).map(([name, v]) => ({ name: toHex(name, { size: 32 }), typeId: v.type === 'bytes' ? 7 : 0x88, value: v.type === 'bytes' ? v.value : toHex(v.value) })).sort((a, b) => a.name.localeCompare(b.name));
}
/** SDK-native schema values for the server writer; canonical bytes match the ABI codec above. */
export function sdkRecordValues(record, { domain, chainId, signer, idempotencyKey }) {
  validateContext(record, { domain, chainId, signer });
  const json = canonicalJson(record), recordBytes = utf8.encode(json);
  if (recordBytes.length > 128 * 1024) throw new Error('Record exceeds Arkiv byte limit');
  return {
    domain, recordType: record.type, record: bytes(toHex(recordBytes)),
    idem: idempotencyHash(idempotencyKey), recordDigest: recordHash(record),
  };
}
/** Pure unsigned create. Caller must obtain authoritative record/context/nonce before review. */
export function prepareRecordTransaction(record, context) {
  const { domain, chainId, signer, idempotencyKey, currentBlock, expiresAtBlock, entityNonce } = context;
  const attributes = encodeRecordAttributes(record, context);
  uint(currentBlock, 64, 'current block'); uint(expiresAtBlock, 64, 'expiry'); uint(entityNonce, 64, 'entity nonce');
  if (expiresAtBlock <= currentBlock || expiresAtBlock - currentBlock > MAX_LIFETIME) throw new Error('Invalid expiry lifetime');
  // Deterministic salt permits exact retry; entity nonce is always independently loaded.
  const salt = BigInt('0x' + idempotencyHash(idempotencyKey).slice(2, 34));
  const operationData = encodeAbiParameters(CREATE_PARAMS, [{ salt, expiresAt: expiresAtBlock, minLifetime: 0n, creationFlags: 1, attributes }]);
  const data = encodeFunctionData({ abi: EXECUTE_ABI, functionName: 'execute', args: [[{ operation: 1, operationData }]] });
  const entityKey = predictEntityKey({ owner: signer, nonce: entityNonce, salt, chainId });
  return { chainId: `0x${chainId.toString(16)}`, transaction: { from: signer, to: ARKIV_ADDRESS, data, value: '0x0' },
    entityKey, entityRef: `arkiv:${chainId}/${entityKey}`, recordDigest: recordHash(record), idempotencyHash: idempotencyHash(idempotencyKey),
    expiresAtBlock: expiresAtBlock.toString(), entityNonce: entityNonce.toString(), schema: SCHEMA_TAG, recordAttribute: RECORD_ATTRIBUTE };
}
/** Raw RPC typed attributes -> exact canonical desk/v1 record, with no payload guesses. */
export function decodeRecordAttributes(attributes) {
  if (!Array.isArray(attributes) || attributes.length !== 6) throw new Error('Unexpected record attributes');
  const map = new Map();
  for (const a of attributes) { if (!a || map.has(a.name)) throw new Error('Duplicate record attribute'); map.set(a.name, a); }
  const field = (name, type) => { const a = map.get(name); if (!a || a.type !== type) throw new Error(`Invalid ${name} attribute`); return a.value; };
  if (field('arkiv.schema', 'str') !== SCHEMA_TAG) throw new Error('Wrong Arkiv schema');
  const hex = field('record', 'bytes');
  if (typeof hex !== 'string' || !/^0x(?:[0-9a-f]{2})*$/i.test(hex) || hex.length > 2 + 128 * 1024 * 2) throw new Error('Invalid record bytes');
  let record, raw;
  try { raw = decoder.decode(hexToBytes(hex)); record = parseRecord(JSON.parse(raw)); } catch { throw new Error('Invalid desk JSON bytes'); }
  if (canonicalJson(record) !== raw || field('domain', 'str') !== record.domain || field('recordType', 'str') !== record.type || field('recordDigest', 'str') !== recordHash(record) || !/^0x[0-9a-f]{64}$/.test(field('idem', 'str'))) throw new Error('Record attribute binding mismatch');
  return { record, idempotencyHash: field('idem', 'str'), recordDigest: field('recordDigest', 'str') };
}
