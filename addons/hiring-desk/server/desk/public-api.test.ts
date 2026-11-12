import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { fixtures, type PaymentIntent, type Provider } from '@secondbrain/desk-contracts/desk';
import { publicDeskRouter, type DeskPublicControls } from './routes.js';
import { MemoryDeskPersistence, type AssignmentRecord } from './persistence/store.js';
const payer = '0x' + '1'.repeat(40), recipient = '0x' + '2'.repeat(40), token = '0x3600000000000000000000000000000000000000';
const txHash = '0x' + 'a'.repeat(64), interfaceId = 'arc:testnet:erc20-usdc:transfer:v1';
const ref = fixtures.jobRef, path = `/api/desk/public/jobs/${encodeURIComponent(ref)}`;
async function setup() {
  const db = new MemoryDeskPersistence();
  const row: AssignmentRecord = { id: ref, revision: 0, execution: 'released', publicState: { stage: 'delivered', jobRef: ref, conflict: false, rejected: [], job: { ...fixtures.job, client: payer, paymentChainId: '5042002' }, offer: { ...fixtures.offer, provider: recipient, recipient, paymentChainId: '5042002', transferInterface: interfaceId, amountAtomic: '25500000' }, acceptance: fixtures.acceptance, acceptanceRef: 'arkiv:test/acceptance-1', delivery: fixtures.delivery } };
  await db.seed(row);
  const provider: Provider = { version: 'desk/v1', type: 'provider', domain: 'example-desk', chainId: 'arkiv:test', providerId: 'provider-1', profileRef: 'profile', owner: recipient, skill: 'research', skillVersion: fixtures.offer.skillVersion, identityRefs: [], paymentAddress: recipient };
  const settlement = { mode: 'fixture' as const, prepare: vi.fn(async (_intent: PaymentIntent) => ({ kind: 'ok' as const, value: { chainId: '5042002', transaction: { from: payer, to: token, value: '0x0', data: '0xa9059cbb' } } })), verify: vi.fn(), reconcile: vi.fn() };
  const reconcilePayment = vi.fn(async () => ({ kind: 'pending' as const, message: 'Waiting for evidence' }));
  const controls: DeskPublicControls = { store: { mode: 'fixture', listJobs: vi.fn(), get: vi.fn(), publish: vi.fn().mockResolvedValue({ kind: 'ok', value: { status: 'pending' } }), confirmation: vi.fn() }, identity: { mode: 'fixture', profile: vi.fn(), resolve: vi.fn().mockResolvedValue({ kind: 'ok', value: { provider, verified: true, evidence: [] } }) }, settlement, persistence: db, orchestrator: { refresh: vi.fn(async () => ({ kind: 'ok' as const, value: (await db.get(ref))! })), reconcilePayment }, paymentReader: { chainId: async () => '5042002', transaction: vi.fn(async () => ({ from: payer, to: token, value: '0x0', input: '0xa9059cbb' })), receipt: vi.fn() }, publicOrigin: 'https://client.example.test', payment: { chainId: '5042002', interfaceId, tokenAddress: token } };
  const app = express(); app.locals.deskPublic = controls; app.use('/api/desk/public', publicDeskRouter(app));
  return { app, controls, db, row, settlement, reconcilePayment };
}
describe('public Hiring Desk payment boundary', () => {
  it('serves an exact-origin preflight and clear unavailable response before runtime setup', async () => {
    vi.stubEnv('DESK_PUBLIC_ORIGIN', 'https://client.example.test');
    const app = express(); app.use('/api/desk/public', publicDeskRouter(app));
    const preflight = await request(app).options('/api/desk/public/discover').set('Origin', 'https://client.example.test').set('Access-Control-Request-Method', 'GET');
    expect(preflight.status).toBe(204);
    expect(preflight.headers['access-control-allow-origin']).toBe('https://client.example.test');
    expect((await request(app).get('/api/desk/public/discover').set('Origin', 'https://client.example.test')).status).toBe(503);
    expect((await request(app).options('/api/desk/public/discover').set('Origin', 'https://evil.example.test')).status).toBe(403);
    vi.unstubAllEnvs();
  });
  it('loads accepted terms and verified identity wallet without leaking private aggregate fields', async () => {
    const { app, db, row, settlement } = await setup();
    await db.seed({ ...row, result: { artifactRef: 'private-artifact', artifactHash: fixtures.delivery.artifactHash, mediaType: 'text/markdown', boundedTrace: 'private trace' } });
    const response = await request(app).get(`${path}/payment`);
    expect(response.status).toBe(200); expect(response.body.state).toBe('payable');
    expect(response.body.terms).toMatchObject({ recipientAddress: recipient, amountBaseUnits: '25500000', amountDisplay: '25.5', jobKey: ref, interfaceId });
    expect(JSON.stringify(response.body)).not.toContain('private');
    expect(settlement.prepare).toHaveBeenCalledWith(expect.objectContaining({ recipient, payer, amountAtomic: '25500000' }));
  });
  it('rejects browser-supplied payment terms and malformed hashes before any verification', async () => {
    const { app, reconcilePayment } = await setup();
    expect((await request(app).post(`${path}/payments/verify`).send({ txHash, amount: '1' })).status).toBe(400);
    expect((await request(app).post(`${path}/payments/verify`).send({ txHash: '0x1234' })).status).toBe(400);
    expect(reconcilePayment).not.toHaveBeenCalled();
  });
  it('keeps an unbound hash pending and restores it for a fresh router instance', async () => {
    const { app, controls, db, reconcilePayment } = await setup();
    const response = await request(app).post(`${path}/payments/verify`).send({ txHash });
    expect(response.body.state).toBe('pending');
    expect((await db.get(ref))?.paymentReceiptId).toBeUndefined();
    const fresh = express(); fresh.locals.deskPublic = controls; fresh.use('/api/desk/public', publicDeskRouter(fresh));
    const resumed = await request(fresh).get(`${path}/payment`);
    expect(resumed.body).toMatchObject({ state: 'pending', txHash });
    expect(reconcilePayment).toHaveBeenCalledTimes(2);
  });
  it('permits same-job retries but does not overwrite a pending hash', async () => {
    const { app, db } = await setup();
    for (let i = 0; i < 2; i++) expect((await request(app).post(`${path}/payments/reconcile`).send({ txHash })).body.state).toBe('pending');
    const revision = (await db.get(ref))?.revision;
    expect((await request(app).post(`${path}/payments/verify`).send({ txHash: '0x' + 'b'.repeat(64) })).status).toBe(409);
    expect((await db.get(ref))?.paymentSubmission?.txHash).toBe(txHash);
    expect((await db.get(ref))?.revision).toBe(revision);
  });
  it('refuses payment before a released delivery and when identity wallet mismatches', async () => {
    const { app, row, db, controls } = await setup();
    await db.seed({ ...row, execution: 'review' });
    expect((await request(app).get(`${path}/payment`)).body.state).toBe('not_payable');
    await db.seed(row);
    vi.mocked(controls.identity!.resolve).mockResolvedValue({ kind: 'denied', message: 'private operator context' });
    const failed = await request(app).get(`${path}/payment`);
    expect(failed.status).toBe(503); expect(JSON.stringify(failed.body)).not.toContain('private');
  });
  it('keeps verification failures durable without changing them to pending on GET', async () => {
    const { app, reconcilePayment, db } = await setup();
    reconcilePayment.mockResolvedValue({ kind: 'failed', message: 'private worker path' } as never);
    expect((await request(app).post(`${path}/payments/verify`).send({ txHash })).body.state).toBe('failed');
    const revision = (await db.get(ref))?.revision;
    expect((await request(app).get(`${path}/payment`)).body.state).toBe('failed');
    expect((await db.get(ref))?.revision).toBe(revision);
  });
  it('enforces exact origin and supplies credential-free preflight', async () => {
    const { app } = await setup();
    expect((await request(app).get(`${path}/payment`).set('Origin', 'https://attacker.example.test')).status).toBe(403);
    const response = await request(app).options(`${path}/payments/verify`).set('Origin', 'https://client.example.test');
    expect(response.status).toBe(204); expect(response.headers['access-control-allow-origin']).toBe('https://client.example.test'); expect(response.headers['access-control-allow-credentials']).toBeUndefined();
  });
  it('does not route public callers to operator actions or private APIs', async () => {
    const { app } = await setup();
    for (const suffix of ['/inbox', '/jobs/job/approve', '/file', '/raw', '/chat', '/org', '/board']) expect((await request(app).get('/api/desk/public' + suffix)).status).toBe(404);
  });
  it('requires bounded desk/v1 publications and idempotency keys', async () => {
    const { app, controls } = await setup();
    expect((await request(app).post('/api/desk/public/jobs').send({ record: fixtures.job, idempotencyKey: 'job-1' })).status).toBe(200);
    expect(controls.store.publish).toHaveBeenCalledWith(fixtures.job, 'job-1');
    expect((await request(app).post('/api/desk/public/jobs').send({ record: { ...fixtures.job, privatePrompt: 'hidden' }, idempotencyKey: 'job-1' })).status).toBe(400);
    expect((await request(app).post('/api/desk/public/jobs').send({ record: fixtures.job })).status).toBe(400);
    expect((await request(app).post('/api/desk/public/jobs').send({ record: fixtures.job, idempotencyKey: 'x'.repeat(201) })).status).toBe(400);
    expect((await request(app).post('/api/desk/public/jobs').send({ record: { ...fixtures.job, brief: 'x'.repeat(17000) }, idempotencyKey: 'job-1' })).status).toBe(413);
  });
  it('limits public write requests', async () => {
    const { app } = await setup();
    let status = 0;
    for (let i = 0; i < 31; i++) status = (await request(app).post('/api/desk/public/payments/prepare').send({ jobRef: ref })).status;
    expect(status).toBe(429);
  });
});

describe('untrusted pending-hash protection', () => {
  it('does not persist an invented or mismatched transaction and allows a valid hash afterward', async () => {
    const { app, controls, db, reconcilePayment } = await setup();
    vi.mocked(controls.paymentReader!.transaction).mockResolvedValueOnce(null);
    expect((await request(app).post(`${path}/payments/verify`).send({ txHash })).body.state).toBe('pending');
    expect((await db.get(ref))?.paymentSubmission).toBeUndefined();
    vi.mocked(controls.paymentReader!.transaction).mockResolvedValueOnce({ from: recipient, to: token, value: '0x0', input: '0xa9059cbb' });
    expect((await request(app).post(`${path}/payments/verify`).send({ txHash })).status).toBe(422);
    expect((await db.get(ref))?.paymentSubmission).toBeUndefined(); expect(reconcilePayment).not.toHaveBeenCalled();
    expect((await request(app).post(`${path}/payments/verify`).send({ txHash })).body.state).toBe('pending');
    expect((await db.get(ref))?.paymentSubmission?.txHash).toBe(txHash);
  });
  it('enforces raw byte budget including whitespace and rejects malformed JSON', async () => {
    const { app } = await setup();
    expect((await request(app).post('/api/desk/public/payments/prepare').set('Content-Type', 'application/json').send(' '.repeat(17000) + '{}')).status).toBe(413);
    expect((await request(app).post('/api/desk/public/payments/prepare').set('Content-Type', 'application/json').send('{')).status).toBe(400);
  });
});

describe('confirmed response boundary', () => {
  it('requires reducer-paid state and a receipt identity bound to the submitted hash', async () => {
    const { app, db, row, reconcilePayment } = await setup();
    reconcilePayment.mockImplementation(async () => {
      const record = (await db.get(ref))!;
      await db.seed({ ...record, paymentReceiptId: `arc:5042002:${txHash}:2` });
      return { kind: 'ok', value: { id: ref, revision: record.revision, execution: 'released', publicState: { ...row.publicState, stage: 'paid' } } } as never;
    });
    const response = await request(app).post(`${path}/payments/verify`).send({ txHash });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ state: 'confirmed', receipt: { txHash, sender: payer, recipient, tokenAddress: token, amountBaseUnits: '25500000', receiptId: `arc:5042002:${txHash}:2` } });
    expect(response.body.receipt.blockNumber).toBeUndefined();
  });
  it('never projects a paid reducer result with an unrelated allocated receipt', async () => {
    const { app, db, row, reconcilePayment } = await setup();
    reconcilePayment.mockImplementation(async () => {
      const record = (await db.get(ref))!;
      await db.seed({ ...record, paymentReceiptId: 'arc:5042002:0x' + 'b'.repeat(64) + ':2' });
      return { kind: 'ok', value: { id: ref, revision: record.revision, execution: 'released', publicState: { ...row.publicState, stage: 'paid' } } } as never;
    });
    const response = await request(app).post(`${path}/payments/verify`).send({ txHash });
    expect(response.status).toBe(503); expect(response.body.state).toBe('unavailable');
  });
});
