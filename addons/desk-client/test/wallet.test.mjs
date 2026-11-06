import test from 'node:test';
import assert from 'node:assert/strict';
import { publishAuthorizedRecord, submitPreparedTransaction } from '../src/wallet.mjs';

const intent = { chainId: 'evm:1', payer: '0xowner' };
const prepared = { chainId: 'evm:1', transaction: { to: '0xtarget', value: '7' } };
test('wallet rejection returns a recoverable denied result', async () => {
  const result = await submitPreparedTransaction({ address: async () => { throw new Error('User rejected request'); }, submit: async () => { throw new Error('must not send'); } }, intent, prepared);
  assert.deepEqual(result, { kind: 'denied', message: 'User rejected request' });
});
test('wrong-chain transaction is rejected before wallet interaction', async () => {
  let called = false;
  const result = await submitPreparedTransaction({ address: async () => { called = true; return intent.payer; }, submit: async () => ({ hash: '0x1' }) }, intent, { ...prepared, chainId: 'evm:2' });
  assert.equal(called, false);
  assert.equal(result.kind, 'failed');
});
test('record author must match injected wallet before publishing', async () => {
  let published = false;
  const result = await publishAuthorizedRecord({ address: async () => '0xother', publishRecord: async () => { published = true; return {}; } }, { client: '0xowner' }, 'client', 'idempotency-key');
  assert.equal(result.kind, 'denied');
  assert.equal(published, false);
});
test('wallet publication rejection remains recoverable', async () => {
  const result = await publishAuthorizedRecord({ address: async () => '0xowner', publishRecord: async () => { throw new Error('User rejected'); } }, { client: '0xowner' }, 'client', 'idempotency-key');
  assert.deepEqual(result, { kind: 'denied', message: 'User rejected' });
});
