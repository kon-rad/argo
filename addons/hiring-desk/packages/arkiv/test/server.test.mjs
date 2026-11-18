import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson } from '@secondbrain/desk-contracts/desk';
import { ServerArkivDeskClient } from '../src/server.mjs';

const privateKey = `0x${'11'.repeat(32)}`;
function setup(createEntity = async () => undefined) {
  const writes = [];
  const audit = [];
  const client = new ServerArkivDeskClient({
    rpcUrl: 'https://rpc.example', domain: 'example', chainId: 1, privateKey,
    lifetimeBlocks: 100, timeoutMs: 1000, audit: event => audit.push(event),
    walletFactory: () => ({ createEntity: async (...args) => { writes.push(args); return createEntity(...args); } }),
  });
  const job = { version: 'desk/v1', domain: 'example', chainId: 'arkiv:1', type: 'job', jobId: 'job', nonce: 'nonce', client: client.signerAddress(), skill: 'research', brief: 'Public brief', budgetAtomic: '1', asset: 'test', paymentChainId: 'arc:1', deadline: 2000 };
  client.block = async () => ({ number: '0xa' });
  return { client, job, writes, audit };
}

test('server signer writes SDK-native canonical bytes and reconciles the finalized entity', async () => {
  const { client, job, writes, audit } = setup();
  const confirmation = { key: `0x${'22'.repeat(32)}`, transactionHash: `0x${'33'.repeat(32)}`, confirmed: true, record: job };
  let reads = 0;
  client.findByIdempotencyKey = async () => ++reads === 1 ? null : confirmation;
  assert.deepEqual(await client.create(job, 'job-request:one'), confirmation);
  assert.equal(writes.length, 1);
  const values = writes[0][1];
  assert.equal(Buffer.from(values.record.value.slice(2), 'hex').toString(), canonicalJson(job));
  assert.equal(values.recordType, 'job');
  assert.deepEqual(audit.map(value => value.event), ['arkiv-write-attempt', 'arkiv-write-confirmed']);
  assert.equal(JSON.stringify(audit).includes(privateKey), false);
});

test('server signer rejects different creators and sanitizes uncertain SDK writes', async () => {
  const { client, job, audit } = setup(async () => { throw new Error(`provider failed ${privateKey}`); });
  client.findByIdempotencyKey = async () => null;
  await assert.rejects(client.create({ ...job, client: `0x${'44'.repeat(20)}` }, 'job-request:one'), /not the record authority/);
  await assert.rejects(client.create(job, 'job-request:one'), /^Error: Arkiv write outcome is uncertain/);
  assert.equal(JSON.stringify(audit).includes(privateKey), false);
});

test('uncertain write retry reconciles the same key before attempting another SDK send', async () => {
  const { client, job, writes } = setup(async () => { throw new Error('timeout'); });
  const confirmation = { key: `0x${'77'.repeat(32)}`, transactionHash: `0x${'88'.repeat(32)}`, confirmed: true, record: job };
  let included = false;
  client.findByIdempotencyKey = async () => included ? confirmation : null;
  await assert.rejects(client.create(job, 'job-request:retry'), /outcome is uncertain/);
  included = true;
  assert.deepEqual(await client.create(job, 'job-request:retry'), confirmation);
  assert.equal(writes.length, 1);
});

test('same-key replay returns the existing entity without another write', async () => {
  const { client, job, writes } = setup();
  const confirmation = { key: `0x${'55'.repeat(32)}`, transactionHash: `0x${'66'.repeat(32)}`, confirmed: true, record: job };
  client.findByIdempotencyKey = async () => confirmation;
  assert.deepEqual(await client.create(job, 'job-request:one'), confirmation);
  assert.equal(writes.length, 0);
  await assert.rejects(client.create({ ...job, brief: 'Changed brief' }, 'job-request:one'), /different canonical record bytes/);
});
