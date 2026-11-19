import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { scratchMarketStore } from './test-support.js';
import { marketRouter, marketOperatorRouter, type MarketControls } from './routes.js';
import { signEngineRequest } from './envelope.js';
const wallet = '0x' + '1'.repeat(40), stranger = '0x' + '2'.repeat(40), secret = 'synthetic-test-secret-longer-than-32bytes';
describe.skipIf(!process.env.CYBA_TEST_DB_URL)('wallet/owner market HTTP boundaries', () => {
    let db: Awaited<ReturnType<typeof scratchMarketStore>>, app: express.Express, controls: MarketControls, id: string;
    beforeAll(async () => {
        db = await scratchMarketStore();
        const p = { id: 'fixture-provider', name: 'Fixture provider', serviceTitle: 'Fixture service', description: 'Fixture', priceAtomic: '1000', payoutWallet: stranger, ensName: 'fixture.eth', agentId: '1', identityBound: true };
        await db.store.configureProfile(p);
        controls = { store: db.store, envelopeSecret: secret, verifiedProfiles: async () => [p], actions: { ensureCard: async (j) => { await db.store.bindCard(j.id, 't_12345678'); }, approve: async (j) => { await db.store.approveJob(j.id); }, stage: vi.fn(), release: vi.fn(), pay: vi.fn(), cancel: vi.fn() } };
        app = express();
        app.use('/api/desk/market/operator', marketOperatorRouter(controls, (req, res, next) => { if (req.get('x-test-owner') !== 'yes') {
            res.status(401).end();
            return;
        } next(); }));
        app.use('/api/desk/market', marketRouter(controls));
    });
    afterAll(async () => { await db?.close(); });
    function signed(method: 'GET' | 'POST', path: string, data?: unknown, who = wallet) { const timestamp = Date.now(), text = data === undefined ? '' : JSON.stringify(data), full = '/api/desk/market' + path; const headers = { 'x-cyba-wallet': who, 'x-cyba-timestamp': String(timestamp), 'x-cyba-signature': signEngineRequest({ method, path: full, body: text, wallet: who, timestamp }, secret) }; return { full, headers, text }; }
    it('public listing is available; wallet writes require a valid envelope', async () => {
        expect((await request(app).get('/api/desk/market/agents')).body.agents).toHaveLength(1);
        expect((await request(app).post('/api/desk/market/jobs').send({})).status).toBe(401);
        const data = { providerId: 'fixture-provider', title: 'Fixture brief', brief: 'Public-safe input', requestKey: 'http-test-request' };
        const s = signed('POST', '/jobs', data);
        const r = await request(app).post(s.full).set(s.headers).set('Content-Type', 'application/json').send(s.text);
        expect(r.status).toBe(201);
        id = r.body.job.id;
        expect(r.body.job).not.toHaveProperty('brief');
        expect(r.body.job).not.toHaveProperty('artifactPath');
    });
    it('forged client wallet fields are rejected and cross-wallet reads reveal nothing', async () => {
        const s = signed('GET', '/jobs/' + id, undefined, stranger);
        expect((await request(app).get(s.full).set(s.headers)).status).toBe(404);
        const data = { providerId: 'fixture-provider', title: 'Fixture', brief: 'Public text', requestKey: 'forged-wallet-request', clientWallet: stranger };
        const f = signed('POST', '/jobs', data);
        expect((await request(app).post(f.full).set(f.headers).set('Content-Type', 'application/json').send(f.text)).status).toBe(400);
    });
    it('owner actions cannot be reached using a gateway envelope', async () => {
        const s = signed('POST', '/operator/jobs/' + id + '/approve', {});
        expect((await request(app).post(s.full).set(s.headers).send({})).status).toBe(401);
        const r = await request(app).post('/api/desk/market/operator/jobs/' + id + '/approve').set('x-test-owner', 'yes').send({});
        expect(r.status).toBe(200);
        expect(r.body.job.status).toBe('active');
    });
    it('payment terms are unavailable before owner Release and unknown routes are closed', async () => {
        const s = signed('GET', '/jobs/' + id + '/payment-terms');
        expect((await request(app).get(s.full).set(s.headers)).status).toBe(409);
        const unknown = signed('POST', '/jobs/' + id + '/publish', {});
        expect((await request(app).post(unknown.full).set(unknown.headers).send({})).status).toBe(404);
    });
    it('paid client projection includes finalized proof references and preview hash cannot be stale', async () => { let j = await db.store.stageArtifact(id, { path: '/private/fixture.mp4', sha256: 'a'.repeat(64), summary: 'Reviewed' }); await db.store.releaseJob(id, 'a'.repeat(64), 'Reviewed'); await db.store.reservePayment(id, '0x' + 'b'.repeat(64)); await db.store.checkpointSwarm(id, 'swarm://' + 'c'.repeat(64)); await db.store.completeDelivery(id, 'swarm://' + 'c'.repeat(64)); const event = await db.store.enqueuePublication(id, 'job-accepted', { kind: 'job-accepted', jobId: id }); await db.store.confirmPublication(event.id, 'arkiv:1/0x' + 'd'.repeat(64)); const s = signed('GET', '/jobs/' + id); const response = await request(app).get(s.full).set(s.headers); expect(response.body.job.evidenceRefs).toEqual(['arkiv:1/0x' + 'd'.repeat(64)]); controls.artifactBytes = async () => new Uint8Array([1]); const preview = await request(app).get('/api/desk/market/operator/jobs/' + id + '/artifact?hash=' + 'e'.repeat(64)).set('x-test-owner', 'yes'); expect(preview.status).toBe(409); });
    it('Release body requires exact reviewed summary as well as hash', async () => {
        const r = await request(app).post('/api/desk/market/operator/jobs/' + id + '/release').set('x-test-owner', 'yes').send({ artifactSha256: 'a'.repeat(64) });
        expect(r.status).toBe(400);
        expect(controls.actions.release).not.toHaveBeenCalled();
    });
});
