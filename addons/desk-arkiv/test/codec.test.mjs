import test from 'node:test';
import assert from 'node:assert/strict';
import { createWalletClient } from '@arkiv-network/sdk';
import { bytes as sdkBytes } from '@arkiv-network/sdk/schema';
import { defineChain, custom, decodeAbiParameters, decodeFunctionData, encodeFunctionData, hexToString, toHex } from 'viem';
import { ExpirationTime } from '@arkiv-network/sdk';
import { canonicalJson } from '@secondbrain/desk-contracts/desk';
import { prepareRecordTransaction, decodeRecordAttributes, encodeRecordAttributes, DeskSchema, SCHEMA_TAG, EXECUTE_ABI, CREATE_PARAMS, recordHash, idempotencyHash } from '../src/codec.mjs';
const signer = '0x' + '11'.repeat(20), hash = 'sha256:' + '22'.repeat(32), ref = 'arkiv:1/0x' + '33'.repeat(32);
const base = { version: 'desk/v1', domain: 'example', chainId: 'arkiv:1' };
const job = { ...base, type: 'job', jobId: 'job', nonce: 'unique', client: signer, skill: 'research', brief: 'Public brief', budgetAtomic: '1', asset: 'test', paymentChainId: 'arc:1', deadline: 2000 };
const context = { domain: 'example', chainId: 1, signer, idempotencyKey: 'unique-idempotency', currentBlock: 10n, expiresAtBlock: 100n, entityNonce: 0n };
const rpcAttributes = r => encodeRecordAttributes(r, context).map(a => ({ name: hexToString(a.name, { size: 32 }), type: (a.typeId & 127) === 7 ? 'bytes' : 'str', value: (a.typeId & 127) === 7 ? a.value : hexToString(a.value) }));

test('all desk record types roundtrip through canonical JSON bytes with indexed bindings', () => {
 const records = [job,
  { ...base, type: 'provider', providerId: 'p', profileRef: 'profile', owner: signer, skill: 'research', skillVersion: '1', identityRefs: [], paymentAddress: signer },
  { ...base, type: 'offer', jobRef: ref, providerId: 'p', provider: signer, skillVersion: '1', amountAtomic: '1', paymentChainId: 'arc:1', asset: 'test', recipient: signer, transferInterface: 'test', expiresAt: 2000 },
  { ...base, type: 'acceptance', jobRef: ref, offerRef: ref, client: signer, offerDigest: hash, nonce: 'unique', expiresAt: 2000 },
  { ...base, type: 'claim', acceptanceRef: ref, provider: signer, executionId: 'execution' },
  { ...base, type: 'delivery', claimRef: ref, provider: signer, artifactHash: hash, mediaType: 'text/markdown', publicRef: 'swarm://' + '44'.repeat(32) },
  { ...base, type: 'payment', jobRef: ref, acceptanceRef: ref, paymentChainId: 'arc:1', txHash: '0x' + '55'.repeat(32), transferIndex: '0', payer: signer, recipient: signer, asset: 'test', amountAtomic: '1', transferInterface: 'test' },
 ];
 for (const r of records) {
  const attrs = rpcAttributes(r); assert.deepEqual(decodeRecordAttributes(attrs).record, r);
  assert.equal(attrs.find(a => a.name === 'record').type, 'bytes');
 }
});
test('unsigned ABI uses SDK execute selector and immutable create; retry and predicted key deterministic', () => {
 const a = prepareRecordTransaction(job, context), b = prepareRecordTransaction(job, context);
 assert.deepEqual(a, b); assert.equal(a.transaction.value, '0x0'); assert.ok(a.transaction.data.startsWith('0x49650044'));
 const decoded = decodeFunctionData({ abi: EXECUTE_ABI, data: a.transaction.data });
 assert.equal(decoded.args[0][0].operation, 1);
 const [op] = decodeAbiParameters(CREATE_PARAMS, decoded.args[0][0].operationData);
 assert.equal(op.creationFlags, 1); assert.equal(op.expiresAt, 100n); assert.equal(op.minLifetime, 0n);
 assert.notEqual(a.entityKey, prepareRecordTransaction(job, { ...context, entityNonce: 1n }).entityKey);
});
test('actual SDK1.0.1 public createEntity produces identical ABI calldata without any real send', async () => {
 const chain = defineChain({ id: 1, name: 'Synthetic', nativeCurrency: { name: 'Test', symbol: 'TEST', decimals: 18 }, rpcUrls: { default: { http: ['https://rpc.example'] } } });
 let captured;
 const wallet = createWalletClient({ chain, account: signer, transport: custom({ request: async ({ method, params }) => {
  if (method === 'eth_blockNumber') return '0xa';
  if (method === 'eth_chainId') return '0x1';
  if (method === 'eth_sendTransaction') { captured = params[0].data; throw Error('Captured only; no broadcast'); }
  throw Error('Unexpected mocked RPC: ' + method);
 } }, { retryCount: 0 }) });
 const expected = prepareRecordTransaction(job, context);
 const [op] = decodeAbiParameters(CREATE_PARAMS, decodeFunctionData({ abi: EXECUTE_ABI, data: expected.transaction.data }).args[0][0].operationData);
 await assert.rejects(wallet.createEntity(DeskSchema, { domain: 'example', recordType: job.type, record: sdkBytes(toHex(canonicalJson(job))), idem: idempotencyHash(context.idempotencyKey), recordDigest: recordHash(job) }, { expiration: ExpirationTime.atBlock(100n), flags: { readonly: true }, salt: op.salt }, { gas: 1n }), error => !!error);
 assert.equal(captured, expected.transaction.data);
});
test('wrong signer, chain/domain, expiry, nonce and unreviewed extra fields fail before ABI output', () => {
 for (const patch of [{ signer: '0x' + '66'.repeat(20) }, { chainId: 2 }, { domain: 'wrong' }, { expiresAtBlock: 10n }, { expiresAtBlock: 10000000n }, { entityNonce: -1n }, { idempotencyKey: 'x' }]) assert.throws(() => prepareRecordTransaction(job, { ...context, ...patch }));
 assert.throws(() => prepareRecordTransaction({ ...job, secret: 'not allowed' }, context));
});
test('digest/type/domain/schema/JSON bytes and duplicate attribute tampering fail', () => {
 for (const name of ['recordDigest', 'recordType', 'domain', 'arkiv.schema']) {
  const attrs = rpcAttributes(job); attrs.find(a => a.name === name).value = 'wrong'; assert.throws(() => decodeRecordAttributes(attrs));
 }
 const attrs = rpcAttributes(job); attrs.find(a => a.name === 'record').value = '0xffff'; assert.throws(() => decodeRecordAttributes(attrs));
 const duplicate = rpcAttributes(job); duplicate[0] = duplicate[1]; assert.throws(() => decodeRecordAttributes(duplicate));
});
