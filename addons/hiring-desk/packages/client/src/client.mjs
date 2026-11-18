import { parseRecord, reducePublicState } from '@secondbrain/desk-contracts/desk';
import { mutationEnvelope } from './wire.mjs';
import { publicRequest } from './transport.mjs';
import { publishAuthorizedRecord } from './wallet.mjs';
export { publishAuthorizedRecord, submitPreparedPayment, submitPreparedTransaction } from './wallet.mjs';
export { publicPath } from './wire.mjs';
export function publicMutation(record, idempotencyKey) { return mutationEnvelope(parseRecord(record), idempotencyKey); }
export async function postWithWallet(wallet, job, idempotencyKey) {
  const record = parseRecord(job);
  if (record.type !== 'job') return { kind: 'invalid-input', message: 'Expected a job record' };
  return publishAuthorizedRecord(wallet, record, 'client', idempotencyKey);
}
export async function acceptWithWallet(wallet, acceptance, idempotencyKey) {
  const record = parseRecord(acceptance);
  if (record.type !== 'acceptance') return { kind: 'invalid-input', message: 'Expected an acceptance record' };
  return publishAuthorizedRecord(wallet, record, 'client', idempotencyKey);
}

/** HTTP implementation of the frozen desk/v1 client contract. No operator endpoints exist here. */
export class PublicHttpDeskClient {
  mode = 'live';
  constructor(baseUrl, fetcher = fetch) {
    const url = new URL(baseUrl);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('A public HTTP(S) endpoint is required');
    this.baseUrl = url.href.endsWith('/') ? url.href : `${url.href}/`;
    this.fetcher = fetcher;
  }
  async request(path, init) {
    return publicRequest(this.baseUrl, this.fetcher, path, init);
  }
  discover() { return this.request('/public/discover'); }
  post(job, idempotencyKey) { return this.request('/public/jobs', { method: 'POST', body: publicMutation(job, idempotencyKey) }); }
  offers(jobRef) { return this.request(`/public/jobs/${encodeURIComponent(jobRef)}/offers`); }
  accept(acceptance, idempotencyKey) { return this.request('/public/acceptances', { method: 'POST', body: publicMutation(acceptance, idempotencyKey) }); }
  inspect(jobRef) { return this.request(`/public/jobs/${encodeURIComponent(jobRef)}`); }
  preparePayment(intent) { return this.request('/public/payments/prepare', { method: 'POST', body: JSON.stringify(intent) }); }
  independentRead(jobRef) { return this.request(`/public/read/${encodeURIComponent(jobRef)}`); }
  reduce(jobRef, observations, now = Math.floor(Date.now() / 1000)) { return reducePublicState(observations, jobRef, now); }
}

