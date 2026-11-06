import test from 'node:test';
import assert from 'node:assert/strict';
import { publicRequest } from '../src/transport.mjs';

test('RPC/API failure remains visible as unavailable', async () => {
  const result = await publicRequest('https://public.example/', async () => { throw new Error('RPC offline'); }, '/public/read/ref');
  assert.deepEqual(result, { kind: 'unavailable', message: 'RPC offline' });
});
test('HTTP pending response stays pending', async () => {
  const result = await publicRequest('https://public.example/', async () => ({ ok: false, status: 409 }), '/public/jobs/ref');
  assert.equal(result.kind, 'pending');
});
