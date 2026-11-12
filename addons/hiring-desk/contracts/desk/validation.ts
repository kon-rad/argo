import { CONTRACT_VERSION, type DeskRecord, type Hash, type ReleaseBinding } from './types.js';

type Rule = 'text' | 'amount' | 'time' | 'hash' | 'texts' | 'ref' | 'publicRef';
const common = { version: 'text', domain: 'text', chainId: 'text', type: 'text' } as const;
const schemas: Record<string, Record<string, Rule>> = {
  provider: { ...common, providerId: 'text', profileRef: 'text', owner: 'text', skill: 'text', skillVersion: 'text', identityRefs: 'texts', paymentAddress: 'text' },
  job: { ...common, jobId: 'text', nonce: 'text', client: 'text', skill: 'text', brief: 'text', budgetAtomic: 'amount', asset: 'text', paymentChainId: 'text', deadline: 'time' },
  offer: { ...common, jobRef: 'ref', providerId: 'text', provider: 'text', skillVersion: 'text', amountAtomic: 'amount', paymentChainId: 'text', asset: 'text', recipient: 'text', transferInterface: 'text', expiresAt: 'time' },
  acceptance: { ...common, jobRef: 'ref', offerRef: 'ref', client: 'text', offerDigest: 'hash', nonce: 'text', expiresAt: 'time' },
  claim: { ...common, acceptanceRef: 'ref', provider: 'text', executionId: 'text' },
  delivery: { ...common, claimRef: 'ref', provider: 'text', artifactHash: 'hash', mediaType: 'text', publicRef: 'publicRef' },
  payment: { ...common, jobRef: 'ref', acceptanceRef: 'ref', paymentChainId: 'text', txHash: 'text', transferIndex: 'amount', payer: 'text', recipient: 'text', asset: 'text', amountAtomic: 'amount', transferInterface: 'text' },
};
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 4096 && v.trim() === v && !/[\u0000-\u001f]/.test(v);
export const isEntityRef = (v: unknown): v is string => text(v) && /^[A-Za-z0-9._-]+:[A-Za-z0-9._-]+\/.+$/.test(v);
export const isHash = (v: unknown): v is Hash => typeof v === 'string' && /^sha256:[0-9a-f]{64}$/.test(v);
export function parseRecord(input: unknown): DeskRecord {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid record');
  const obj = input as Record<string, unknown>;
  const schema = typeof obj.type === 'string' ? schemas[obj.type] : undefined;
  if (!schema || Object.keys(obj).length !== Object.keys(schema).length || obj.version !== CONTRACT_VERSION) throw new Error('Unknown schema or fields');
  for (const [key, rule] of Object.entries(schema)) {
    const v = obj[key];
    const valid = rule === 'text' ? text(v) : rule === 'amount' ? typeof v === 'string' && /^(0|[1-9][0-9]*)$/.test(v) && v.length <= 78 : rule === 'time' ? typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 : rule === 'hash' ? isHash(v) : rule === 'ref' ? isEntityRef(v) : rule === 'publicRef' ? typeof v === 'string' && /^swarm:\/\/[0-9a-f]{64}$/.test(v) : Array.isArray(v) && v.length <= 64 && v.every(text);
    if (!valid) throw new Error(`Invalid ${key}`);
  }
  if ((obj.type === 'job' && obj.budgetAtomic === '0') || ((obj.type === 'offer' || obj.type === 'payment') && obj.amountAtomic === '0')) throw new Error('Amount must be positive');
  return obj as unknown as DeskRecord;
}
/** Canonical JSON: sorted object keys, exact UTF-8 strings, safe integers only; no implicit omission. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (typeof value === 'object' && value && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    const object = value as Record<string, unknown>;
    return '{' + Object.keys(object).sort().map(key => JSON.stringify(key) + ':' + canonicalJson(object[key])).join(',') + '}';
  }
  throw new Error('Not canonical JSON');
}
/** Domains prevent a digest from being interpreted as a different authorization. */
export async function digest(purpose: 'offer-terms' | 'acceptance' | 'approval' | 'release' | 'worker-spec' | 'payment-evidence', value: unknown): Promise<Hash> {
  const bytes = new TextEncoder().encode(canonicalJson({ domain: 'desk/v1', purpose, value }));
  const hash = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
  return 'sha256:' + Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('');
}
export async function artifactDigest(bytes: Uint8Array): Promise<Hash> {
  const copy = Uint8Array.from(bytes);
  const hash = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', copy.buffer));
  return 'sha256:' + Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('');
}
export function sameRelease(a: ReleaseBinding, b: ReleaseBinding): boolean { return a.artifactHash === b.artifactHash && a.mediaType === b.mediaType && a.publicDestination === b.publicDestination; }
