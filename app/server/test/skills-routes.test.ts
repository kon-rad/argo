import { reviewedPlanViews as planViews } from './helpers/skills-reviewed.js';
import { join } from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LibraryResponseSchema, MachinesResponseSchema, MatrixResponseSchema, SkillDetailResponseSchema, type AckRequest } from '@secondbrain/contracts/skills';
import { skillsRouter } from '../src/addons/skills/routes.js';
import { SkillsService } from '../src/addons/skills/service.js';
import { syncViews } from '../src/addons/skills/reconcile.js';
import { machineStates, readAcks } from '../src/addons/skills/machines.js';
import { createApp } from '../src/app.js';
import { query } from '../src/db.js';
import { addDevice, findDevice } from '../src/ingest/devices.js';
import { errorHandler } from '../src/routes/http.js';
import { MANAGED_POLICY, SETTINGS, skillMd, skillsFixture, write } from './helpers/skills.js';

const HOSTS = ['skills-host-a', 'skills-host-b', 'skills-host-c'];

beforeEach(async () => {
  for (const h of HOSTS) await query(`INSERT INTO usage_hosts (slug, display, kind) VALUES ($1, $1, 'server') ON CONFLICT DO NOTHING`, [h]);
});
afterEach(async () => {
  await query(`DELETE FROM skill_view_acks WHERE host = ANY($1)`, [HOSTS]);
  await query(`DELETE FROM skill_ack_log WHERE host = ANY($1)`, [HOSTS]);
  await query(`DELETE FROM ingest_devices WHERE host = ANY($1)`, [HOSTS]);
  await query(`DELETE FROM usage_hosts WHERE slug = ANY($1)`, [HOSTS]);
});

function api(vault: string, engine: string) {
  const app = express();
  app.use(express.json());
  app.use('/api/skills', skillsRouter(new SkillsService(vault, SETTINGS, { engineSkills: engine })));
  app.use(errorHandler);
  return app;
}

describe('skills routes and module gating', () => {
  it('mounts nothing and shows no nav link when the module is off; mounts both doors when on', async () => {
    const off = createApp({ modules: new Set(['org']) });
    expect((await request(off).get('/api/skills')).status).toBe(404);
    expect((await request(off).post('/api/skills/ack').send({})).status).toBe(404);
    expect(JSON.stringify((await request(off).get('/api/meta')).body)).not.toContain('/skills');
    const f = skillsFixture({ git: false });
    const on = createApp({ modules: new Set(['org', 'skills']), vaultRoot: f.vault });
    const meta = (await request(on).get('/api/meta')).body;
    expect(JSON.stringify(meta)).toContain('"/skills"');
    const lib = await request(on).get('/api/skills');
    expect(lib.status).toBe(200);
    expect(LibraryResponseSchema.parse(lib.body).mode).toBe('legacy');
    expect((await request(on).post('/api/skills/ack').send({})).status).toBe(401);
  });

  it('serves typed library, detail, matrix, agent and file views; 404s unknown names and unsafe paths', async () => {
    const f = skillsFixture();
    write(join(f.vault, '.agents', 'skills-policy.yaml'), MANAGED_POLICY);
    const app = api(f.vault, f.engine);
    const lib = LibraryResponseSchema.parse((await request(app).get('/api/skills')).body);
    expect(lib.mode).toBe('managed');
    expect(JSON.stringify(lib)).not.toContain(f.vault); // no absolute machine paths in responses
    const d = SkillDetailResponseSchema.parse((await request(app).get('/api/skills/skill/report?id=engine:report')).body);
    expect(d.selected!.id).toBe('engine:report');
    expect(d.agents.find((a) => a.agent === 'alpha')!.state).toBe('assigned');
    MatrixResponseSchema.parse((await request(app).get('/api/skills/matrix')).body);
    expect((await request(app).get('/api/skills/agents/alpha')).body.agent.support).toBe('catalog-filtered');
    expect((await request(app).get('/api/skills/agents/nobody')).status).toBe(404);
    expect((await request(app).get('/api/skills/skill/nope')).status).toBe(404);
    expect((await request(app).get('/api/skills/skill/report/file').query({ path: '../../outside/secret.txt' })).status).toBe(404);
    expect((await request(app).get('/api/skills/skill/Bad%20Name')).status).toBe(400);
  });

  it('runs the draft and change workflow through HTTP without activating anything', async () => {
    const f = skillsFixture();
    const app = api(f.vault, f.engine);
    expect((await request(app).post('/api/skills/drafts').send({ name: 'newskill', description: 'A new skill.' })).status).toBe(201);
    expect((await request(app).put('/api/skills/drafts/newskill/file').send({ path: '../x', content: 'x' })).status).toBe(400);
    expect((await request(app).put('/api/skills/drafts/newskill/file').send({ path: 'scripts/run.sh', content: '#!/bin/sh\n', exec: true, expectedVersion: null })).status).toBe(200);
    const loaded = await request(app).get('/api/skills/drafts/newskill/file').query({ path: 'SKILL.md' });
    expect(loaded.status).toBe(200);
    expect((await request(app).put('/api/skills/drafts/newskill/file').send({ path: 'SKILL.md', content: skillMd('newskill', 'Summarizes a source document.', '', '# Instructions\n\nRead the document and summarize its claims with citations.\n'), expectedVersion: loaded.body.version })).status).toBe(200);
    const preview = await request(app).post('/api/skills/changes/preview').send({ kind: 'create', skill: 'newskill', draft: 'newskill' });
    expect(preview.status).toBe(200);
    expect(preview.body.preview.blocked).toEqual([]);
    expect((await request(app).get('/api/skills/changes')).body.changes).toEqual([]);
    const made = await request(app).post('/api/skills/changes').send({ kind: 'create', skill: 'newskill', draft: 'newskill' });
    expect(made.status).toBe(201);
    expect(made.body.change.status).toBe('proposed');
    const library = await request(app).get('/api/skills?refresh=1');
    expect(library.status, JSON.stringify(library.body)).toBe(200);
    const lib = LibraryResponseSchema.parse(library.body);
    expect(lib.skills.some((s) => s.name === 'newskill')).toBe(false);
    const refused = await request(app).post('/api/skills/changes').send({ kind: 'remove', skill: 'report' });
    expect(refused.status).toBe(409);
  });
});

describe('skills acknowledgement protocol and machines', () => {
  it('authenticates by device token, decides the host from it, bounds the body and records the views', async () => {
    const f = skillsFixture();
    write(join(f.vault, '.agents', 'skills-policy.yaml'), MANAGED_POLICY);
    const service = new SkillsService(f.vault, SETTINGS, { engineSkills: f.engine });
    const st = await service.current();
    const report = syncViews(join(f.base, 'managed'), planViews(st.catalog, st.policy, st.roster, { agents: ['alpha', 'beta'] }), { env: { PATH: '' } });
    const app = createApp({ modules: new Set(['org', 'skills']), vaultRoot: f.vault });
    const { token } = await addDevice('skills-host-a');
    const body: AckRequest = { v: 1, engine: 'test', policyDigest: report.policyDigest, views: report.views };
    expect((await request(app).post('/api/skills/ack').send(body)).status).toBe(401);
    expect((await request(app).post('/api/skills/ack').set('authorization', 'Bearer sbd_wrong').send(body)).status).toBe(401);
    const ok = await request(app).post('/api/skills/ack').set('authorization', `Bearer ${token}`).send({ ...body, host: 'someone-else' });
    expect(ok.status).toBe(422); // strict: the body cannot name a host
    const good = await request(app).post('/api/skills/ack').set('authorization', `Bearer ${token}`).send(body);
    expect(good.status).toBe(200);
    expect(good.body).toMatchObject({ host: 'skills-host-a', accepted: 2 });
    const big = { ...body, views: [{ ...body.views[0]!, error: 'x'.repeat(300 * 1024) }] };
    expect(await findDevice(token)).not.toBeNull();
    const oversized = await request(app).post('/api/skills/ack').set('authorization', `Bearer ${token}`).send(big);
    expect(oversized.status, oversized.text.slice(0, 1000)).toBe(413);
    const dup = { ...body, views: [body.views[0]!, body.views[0]!] };
    expect((await request(app).post('/api/skills/ack').set('authorization', `Bearer ${token}`).send(dup)).status).toBe(422);
    const secretish = { ...body, views: [{ ...body.views[0]!, missing: [{ skill: 'clip', bins: [], env: ['TOKEN=abc'] }] }] };
    expect((await request(app).post('/api/skills/ack').set('authorization', `Bearer ${token}`).send(secretish)).status).toBe(422);

    // The fixture's engine root (createApp's service reads the repo's real engine skills instead).
    const m = MachinesResponseSchema.parse((await request(api(f.vault, f.engine)).get('/api/skills/machines')).body);
    const a = m.hosts.find((h) => h.host === 'skills-host-a')!;
    expect(a.status).toBe('not-ready');
    expect(a.views.find((v) => v.agent === 'alpha')!.skills.every((s) => s.state === 'match')).toBe(true);
    expect(a.views.find((v) => v.agent === 'alpha')!.missing[0]!.env).toEqual(['FIXTURE_CLIP_KEY']);
    expect(m.hosts.find((h) => h.host === 'skills-host-b')!.status).toBe('never'); // registered, never acknowledged: unknown
  });

  it('shows drift after a policy change, stale after the threshold, and dirty/failed as reported', async () => {
    const f = skillsFixture();
    write(join(f.vault, '.agents', 'skills-policy.yaml'), MANAGED_POLICY);
    const service = new SkillsService(f.vault, SETTINGS, { engineSkills: f.engine });
    const st = await service.current();
    const report = syncViews(join(f.base, 'managed'), planViews(st.catalog, st.policy, st.roster, { agents: ['alpha'] }), { env: { PATH: '' } });
    const { recordAck } = await import('../src/addons/skills/machines.js');
    const devA = await addDevice('skills-host-a');
    const devC = await addDevice('skills-host-c');
    void devA; void devC;
    const ids = (await query<{ id: number; host: string }>(`SELECT id, host FROM ingest_devices WHERE host = ANY($1)`, [HOSTS])).rows;
    const idOf = (h: string) => Number(ids.find((r) => r.host === h)!.id);
    await recordAck({ id: idOf('skills-host-a'), host: 'skills-host-a' }, { v: 1, engine: null, policyDigest: report.policyDigest, views: report.views });
    await recordAck({ id: idOf('skills-host-c'), host: 'skills-host-c' }, { v: 1, engine: null, policyDigest: report.policyDigest, views: [{ ...report.views[0]!, status: 'dirty', dirty: ['clip'], error: 'modified' }] });
    // The policy now revokes clip from alpha: the acknowledged view drifts until that host syncs again.
    write(join(f.vault, '.agents', 'skills-policy.yaml'), MANAGED_POLICY.replace('grant: [clip, video]', 'grant: [video]'));
    service.invalidate();
    const m = await service.machines();
    const a = m.hosts.find((h) => h.host === 'skills-host-a')!;
    expect(a.status).toBe('drift');
    expect(a.views[0]!.skills.find((s) => s.name === 'clip')!.state).toBe('extra');
    expect(m.hosts.find((h) => h.host === 'skills-host-c')!.status).toBe('dirty');
    const later = machineStates(await readAcks(), () => null, 24, new Date(Date.now() + 25 * 3600_000));
    expect(later.find((h) => h.host === 'skills-host-a')!.status).toBe('stale');
    expect(later.find((h) => h.host === 'skills-host-a')!.views[0]!.skills.every((s) => s.state === 'unknown')).toBe(true);
  });
});
