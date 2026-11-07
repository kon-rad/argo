import test from 'node:test';
import assert from 'node:assert/strict';
import { hexToString, encodeAbiParameters, encodeEventTopics, parseAbiParameters } from 'viem';
import { ENTITY_EVENTS_ABI } from '@arkiv-network/sdk';
import { LiveArkivDeskClient } from '../src/reader.mjs';
import { encodeRecordAttributes, ARKIV_ADDRESS } from '../src/codec.mjs';
const creator = '0x' + '11'.repeat(20), key = '0x' + '22'.repeat(32), hash = '0x' + '33'.repeat(32), tx = '0x' + '44'.repeat(32);
const record = { version: 'desk/v1', type: 'job', domain: 'example', chainId: 'arkiv:1', jobId: 'job', nonce: 'nonce', client: creator, skill: 'research', brief: 'Public brief', budgetAtomic: '1', asset: 'test', paymentChainId: 'arc:1', deadline: 2000 };
const attrs = () => encodeRecordAttributes(record, { domain: 'example', chainId: 1, signer: creator, idempotencyKey: 'unique-key' }).map(a => ({ name: hexToString(a.name, { size: 32 }), type: a.typeId === 7 ? 'bytes' : 'str', value: a.typeId === 7 ? a.value : hexToString(a.value) }));
const entity = () => ({ key, creator, owner: creator, creationFlags: { readonly: true }, createdAt: '0x1', updatedAt: '0x1', expiresAt: '0x20', attributes: attrs() });
function client(overrides = {}) {
 let count = 0;
 const fetchImpl = async (_url, opts) => {
  const { id, method, params } = JSON.parse(opts.body); let result;
  if (method === 'eth_chainId') result = overrides.chain ?? '0x1';
  else if (method === 'arkiv_query') result = { blockNumber: '0x10', data: overrides.missing ? [] : [overrides.entity ?? entity()] };
  else if (method === 'arkiv_getEntity') result = overrides.missing ? null : overrides.entity ?? entity();
  else if (method === 'eth_getBlockByNumber') {
   if (params[0] === 'latest') count++;
   const number = params[0] === 'latest' ? '0x10' : params[0] === 'finalized' ? overrides.finalized ?? '0x11' : params[0];
   result = { number, timestamp: number === '0x1' ? '0x64' : '0xc8', hash: overrides.drift && count > 1 ? '0x' + '55'.repeat(32) : hash };
  } else if (method === 'eth_getLogs') result = [{ address: ARKIV_ADDRESS, blockNumber: '0x1', blockHash: hash, transactionHash: tx, removed: false, topics: encodeEventTopics({ abi: ENTITY_EVENTS_ABI, eventName: 'EntityCreated', args: { entityKey: key, owner: creator } }), data: encodeAbiParameters(parseAbiParameters('uint64,uint8'), [32n, 1]) }];
  else if (method === 'eth_getTransactionReceipt') result = { status: overrides.reverted ? '0x0' : '0x1', blockHash: hash, transactionHash: tx };
  else if (method === 'eth_call') result = '0x' + '0'.repeat(64);
  else throw Error('Unexpected mock RPC: ' + method);
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }));
 };
 return new LiveArkivDeskClient({ rpcUrl: 'https://rpc.example', domain: 'example', chainId: 1, fetchImpl });
}

test('concrete page/get decode immutable public records and convert block expiry to projected Unix seconds', async () => {
 const page = await client().page({ limit: 100 }); assert.equal(page.finalized, true); assert.equal(page.blockNumber, 16n);
 assert.deepEqual(page.rows[0].record, record); assert.equal(page.rows[0].createdAt, 100); assert.equal(page.rows[0].expiresAt, 232);
 assert.equal((await client().get(key)).finalized, true);
});
test('creator mutation/transfer/domain/chain errors are unavailable', async () => {
 for (const patch of [{ owner: '0x' + '66'.repeat(20) }, { creator: '0x' + '66'.repeat(20) }, { creationFlags: { readonly: false } }, { updatedAt: '0x11' }, { expiresAt: '0x10' }]) await assert.rejects(client({ entity: { ...entity(), ...patch } }).get(key), /Unavailable/);
 await assert.rejects(client({ chain: '0x2' }).get(key), /chain mismatch/);
});
test('atBlock pagination drift, unfinalized snapshots and latest get drift stay visible', async () => {
 await assert.rejects(client().page({ limit: 100, atBlock: 15n }), /snapshot drift/);
 assert.equal((await client({ finalized: '0xf' }).page({ limit: 100 })).finalized, false);
 await assert.rejects(client({ drift: true }).get(key), /snapshot drift/);
 await assert.rejects(client({ finalized: '0xf' }).findByIdempotencyKey('unique-key'), /not finalized/);
});
test('missing records do not become confirmations and server create never signs', async () => {
 assert.equal(await client({ missing: true }).get(key), null); assert.equal(await client({ missing: true }).confirmation(key), null);
 await assert.rejects(client().create(record, 'unique-key'), /browser signature required/);
});
test('real event/receipt binding supplies creation tx hash; reverted receipt fails', async () => {
 const confirmation = await client().confirmation(key); assert.equal(confirmation.transactionHash, tx); assert.equal(confirmation.confirmed, true);
 await assert.rejects(client({ reverted: true }).confirmation(key), /receipt unconfirmed/);
});
test('idempotency lookup returns actual finalized matching record', async () => {
 assert.equal((await client().findByIdempotencyKey('unique-key')).key, key);
 assert.equal(await client().findByIdempotencyKey('other-key'), null);
});
test('prepare reads authoritative entity nonce and produces unsigned ABI without broadcasting', async () => {
 const prepared = await client({ missing: true }).prepare(record, 'unique-key', 32n);
 assert.equal(prepared.transaction.to, ARKIV_ADDRESS); assert.ok(prepared.transaction.data.startsWith('0x49650044')); assert.equal(prepared.entityNonce, '0');
 await assert.rejects(client().prepare(record, 'unique-key', 32n), /already published/);
});
test('transport failures and malformed or oversized responses stay sanitized', async () => {
 const c = client(); c.fetchImpl = async () => { throw Error('sensitive URL'); }; await assert.rejects(c.get(key), /^Error: Unavailable: Arkiv RPC request failed or exceeded bounds$/);
 const d = client(); d.maxResponseBytes = 10; await assert.rejects(d.get(key), /exceeded bounds/);
});
