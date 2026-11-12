import test from 'node:test';
import assert from 'node:assert/strict';
import { readPublicEvidence } from '../src/arkiv-reader.mjs';
const creator = '0x' + '11'.repeat(20), key = '0x' + '22'.repeat(32), hash = '0x' + '33'.repeat(32);
const job = { version: 'desk/v1', type: 'job', domain: 'example', chainId: 'arkiv:1', jobId: 'job', nonce: 'unique', client: creator, skill: 'research', brief: 'Public brief', budgetAtomic: '1', asset: 'test', paymentChainId: 'arc:1', deadline: 2000 };
const encodeRecord = r => '0x' + Buffer.from(JSON.stringify(r), 'utf8').toString('hex');
const row = () => ({ key, creator, owner: creator, creationFlags: { readonly: true }, createdAt: '0x1', updatedAt: '0x1', expiresAt: '0x20', attributes: [{ name: 'record', type: 'bytes', value: encodeRecord(job) }] });
function config(overrides = {}) {
  let queryCalls = 0;
  const fetchImpl = async (_url, options) => {
    const { id, method, params } = JSON.parse(options.body); let result;
    if (method === 'eth_chainId') result = overrides.chain ?? '0x1';
    else if (method === 'arkiv_query') {
      queryCalls++;
      result = { blockNumber: overrides.drift && queryCalls > 1 ? '0x11' : '0x10', data: queryCalls > 1 ? [] : [overrides.row ?? row()] };
      if (overrides.captureQuery) overrides.captureQuery(params[0]);
    } else if (method === 'eth_getBlockByNumber') {
      const num = params[0] === 'finalized' ? overrides.finalized ?? '0x11' : params[0];
      result = { number: num, timestamp: num === '0x1' ? '0x64' : '0xc8', hash: overrides.reorg && params[0] === '0x10' && queryCalls > 0 && overrides.headerSeen++ ? '0x' + '44'.repeat(32) : hash };
    } else throw Error('Unexpected RPC method');
    return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }));
  };
  return { rpcUrl: 'https://rpc.example', jobRef: `arkiv:1/${key}`, domain: 'example', schema: 'desk', recordAttribute: 'record', fetchImpl, ...overrides.options };
}

test('reads public finalized desk records and never manufactures payment verification', async () => {
  const evidence = await readPublicEvidence(config());
  assert.equal(evidence.observations.length, 1);
  assert.equal(evidence.observations[0].observedAt, 100);
  assert.equal(evidence.observations[0].finalized, true);
  assert.deepEqual(evidence.verifiedPayments, []);
});
test('snapshot can finalize after query rather than requiring latest equal finalized initially', async () => {
  assert.equal((await readPublicEvidence(config({ finalized: '0x12' }))).observations.length, 1);
});
test('keyset pagination has stable snapshot and bounded completion', async () => {
  const queries = [];
  await readPublicEvidence(config({ captureQuery: q => queries.push(q), options: { pageSize: 1 } }));
  assert.equal(queries.length, 2); assert.match(queries[1], /\$key > key\(0x/);
  await assert.rejects(readPublicEvidence(config({ drift: true, options: { pageSize: 1 } })), /snapshot drift/);
  await assert.rejects(readPublicEvidence(config({ options: { pageSize: 1, maxPages: 1 } })), /pagination limit/);
});
test('wrong chain and unsupported or pending finality fail visibly', async () => {
  await assert.rejects(readPublicEvidence(config({ chain: '0x2' })), /chain differs/);
  await assert.rejects(readPublicEvidence(config({ finalized: '0xf' })), /not finalized/);
});
test('entity expiry during finality advancement fails', async () => {
  await assert.rejects(readPublicEvidence(config({ finalized: '0x20' })), /expired while waiting/);
});
test('immutable creator, record domain and record chain are checked', async () => {
  for (const patch of [{ client: '0x' + '55'.repeat(20) }, { domain: 'wrong' }, { chainId: 'arkiv:2' }]) {
    const r = row(); r.attributes[0].value = encodeRecord({ ...job, ...patch });
    await assert.rejects(readPublicEvidence(config({ row: r })), /authority|domain or chain/);
  }
});
test('expired, future-updated and malformed entity block data fail', async () => {
  for (const patch of [{ expiresAt: '0x10' }, { updatedAt: '0x11' }, { createdAt: '0x2', updatedAt: '0x1' }, { creator: 'not-an-address' }]) {
    await assert.rejects(readPublicEvidence(config({ row: { ...row(), ...patch } })), /expired or unfinalized|immutable content/);
  }
});
test('missing, malformed, duplicated and oversized JSON attribute fail', async () => {
  for (const attrs of [[], [{ name: 'record', type: 'str', value: '{' }], [...row().attributes, ...row().attributes], [{ name: 'record', type: 'str', value: 'x'.repeat(65537) }]]) {
    await assert.rejects(readPublicEvidence(config({ row: { ...row(), attributes: attrs } })), /record attribute|malformed or oversized desk/);
  }
});
test('missing job and snapshot hash change fail', async () => {
  await assert.rejects(readPublicEvidence({ ...config(), jobRef: `arkiv:1/0x${'66'.repeat(32)}` }), /job not present/);
  await assert.rejects(readPublicEvidence(config({ reorg: true, headerSeen: 0 })), /snapshot changed/);
});
test('transport failures are sanitized and response bytes bounded', async () => {
  await assert.rejects(readPublicEvidence({ ...config(), fetchImpl: async () => { throw Error('secret URL'); } }), /^Error: Unavailable: public RPC request failed$/);
  await assert.rejects(readPublicEvidence({ ...config(), fetchImpl: async () => new Response('x'.repeat(1000)), maxResponseBytes: 100 }), /exceeds limit/);
  await assert.rejects(readPublicEvidence({ ...config(), fetchImpl: async () => new Response('{}', { status: 503 }) }), /HTTP error/);
});
test('configuration cannot silently choose encoding or accept unsafe RPC URLs', async () => {
  await assert.rejects(readPublicEvidence({ ...config(), recordAttribute: '' }), /configure/);
  await assert.rejects(readPublicEvidence({ ...config(), rpcUrl: 'http://rpc.example' }), /HTTPS/);
  const credentialUrl = new URL('https://rpc.example'); credentialUrl.username = 'user'; credentialUrl.password = 'pass';
  await assert.rejects(readPublicEvidence({ ...config(), rpcUrl: credentialUrl.href }), /credentials/);
});

test('independently downloaded artifact bytes require exact SHA-256 and bounded size', async () => {
  const { verifyArtifactBytes } = await import('../src/arkiv-reader.mjs');
  const bytes = new TextEncoder().encode('hello');
  const digest = 'sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';
  assert.equal((await verifyArtifactBytes(bytes, digest)).verified, true);
  await assert.rejects(verifyArtifactBytes(bytes, 'sha256:' + '0'.repeat(64)), /mismatch/);
  await assert.rejects(verifyArtifactBytes(bytes, digest, 4), /oversized/);
});

test('schema query uses Arkiv single-quote escaping', async () => {
  const queries = [];
  await readPublicEvidence({ ...config({ captureQuery: q => queries.push(q) }), schema: "team's-desk" });
  assert.match(queries[0], /str\('team''s-desk'\)/);
});

test('mutable or transferred records cannot claim exact creator-authored bytes', async () => {
  for (const patch of [
    { creationFlags: { readonly: false } },
    { creationFlags: undefined },
    { owner: '0x' + '77'.repeat(20) },
    { creationFlags: { readonly: false }, owner: '0x' + '77'.repeat(20), updatedAt: '0x2' },
  ]) await assert.rejects(readPublicEvidence(config({ row: { ...row(), ...patch } })), /immutable content/);
});
test('response stream errors cannot reveal an RPC URL or credential', async () => {
  const fetchImpl = async () => new Response(new ReadableStream({ start(c) { c.error(new Error('sensitive RPC path')); } }));
  await assert.rejects(readPublicEvidence({ ...config(), fetchImpl }), /^Error: Unavailable: RPC response stream failed$/);
});

test('actual SDK-compatible record uses bytes, since str is limited to 128 UTF-8 bytes', async () => {
  const r = row(); r.attributes[0].value = '0xffff';
  await assert.rejects(readPublicEvidence(config({ row: r })), /malformed or oversized/);
  const longString = row(); longString.attributes[0] = { name: 'record', type: 'str', value: JSON.stringify(job) };
  await assert.rejects(readPublicEvidence({ ...config({ row: longString }), recordEncoding: 'str' }), /malformed or oversized/);
  const withDefaults = config(); delete withDefaults.schema; delete withDefaults.recordAttribute;
  assert.equal((await readPublicEvidence(withDefaults)).observations.length, 1);
});
