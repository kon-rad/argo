import test from 'node:test';
import assert from 'node:assert/strict';
import { mutationEnvelope, publicPath } from '../src/wire.mjs';

test('browser and CLI send identical desk record envelope bytes', () => {
  const record = { version: 'desk/v1', type: 'job', jobId: 'job-1', brief: 'hello' };
  assert.equal(mutationEnvelope(record, 'idem-123'), JSON.stringify({ record, idempotencyKey: 'idem-123' }));
});
test('mutation requires an idempotency key', () => assert.throws(() => mutationEnvelope({}, 'x'), /idempotency/));
test('client rejects paths outside the public API', () => {
  assert.equal(publicPath('/public/discover'), '/public/discover');
  for (const path of ['/operator/jobs', '//operator/jobs', '/api/private', '/public/../operator/jobs', '/public/%2e%2e/operator/jobs']) assert.throws(() => publicPath(path));
});
