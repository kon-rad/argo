import request from 'supertest';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { main } from '../src/cli-org.js';
import { importOrg } from '../src/org.js';
import { query, setDatabaseUrl } from '../src/db.js';
import { saveProfile } from '../src/org-runtime/index.js';
import { truncateAll, ALL_MODULES } from './helpers.js';
const profile = {name:'Example',default:{runtime:'codex',model:'example-next',provider:null},models:{}};
const app = () => createApp({modules:ALL_MODULES});
async function cli(args: string[]) { let output=''; await main(['runtime',...args,'--json'],s => {output=s;}); return JSON.parse(output); }
beforeEach(async () => {
  vi.stubEnv('ORG_AGENT','owner');
  await truncateAll();
  await importOrg({version:'v1',company:'Example',ceo:'owner',agents:{owner:{runtime:'human',role:'Owner'},writer:{runtime:'codex',lane:true,model:'example-base',role:'Writer'}},teams:{},channels:{}});
  await saveProfile('example',profile,'owner');
});
afterEach(() => vi.unstubAllEnvs());
it('shares status, profile, preview, apply, history and revert behavior with the CLI', async () => {
  const http = app();
  expect((await request(http).get('/api/org/runtime').expect(200)).body).toEqual(await cli(['show']));
  expect((await request(http).get('/api/org/runtime/profiles').expect(200)).body).toEqual(await cli(['profiles']));
  const a = (await request(http).post('/api/org/runtime/preview').send({profileId:'example',scope:[{kind:'org-agent',id:'writer'}]}).expect(200)).body;
  const b = await cli(['preview','example','--scope','org-agent:writer']);
  expect(a.changes).toEqual(b.changes); expect(a.uncovered).toEqual(b.uncovered);
  await request(http).post('/api/org/runtime/apply').send({token:a.token}).expect(200);
  expect((await request(http).get('/api/org/runtime/history').expect(200)).body).toEqual(await cli(['history']));
  await expect(cli(['apply',b.token])).rejects.toThrow(/stale/);
  const r = await cli(['revert','1']); expect(r.version).toBe(2);
  await request(http).post('/api/org/runtime/revert').send({version:2}).expect(200);
  const c = await cli(['preview','example','--scope','org-agent:writer']);
  expect((await cli(['apply',c.token])).version).toBe(4);
});
it('does not accept a caller identity in HTTP payloads and denies bot CLI writes', async () => {
  await request(app()).post('/api/org/runtime/preview').send({profileId:'example',by:'owner'}).expect(400);
  vi.stubEnv('ORG_AGENT','writer');
  await expect(cli(['preview','example'])).rejects.toThrow(/owner/);
  await query(`UPDATE org_agents SET runtime='session' WHERE name='owner'`);
  await request(app()).post('/api/org/runtime/preview').send({profileId:'example'}).expect(403);
});
it('requires the authenticated owner session on server deployments', async () => {
  const http = createApp({modules:ALL_MODULES,deployment:'server',auth:{passwordHash:'fake-hash',totpSecret:'JBSWY3DPEHPK3PXP',secureCookie:false,publicOrigin:'http://127.0.0.1'}});
  await request(http).post('/api/org/runtime/preview').set('Origin','http://127.0.0.1').send({profileId:'example'}).expect(401);
});

it('denies every runtime CLI verb for a second human even on a privileged connection', async () => {
  await query(`INSERT INTO org_agents(name,runtime,role,org_version) VALUES ('other-human','human','Guest','v1')`);
  vi.stubEnv('ORG_AGENT','other-human');
  for (const args of [['show'],['profiles'],['history'],['save','x','missing.json'],['register','cron-job:x','missing.json'],['preview','example'],['apply','unused'],['revert','1']]) {
    await expect(cli(args)).rejects.toThrow(/owner/);
  }
});
it('denies bot CLI reads over SB_ORG_DB_URL and allows owner reads over the privileged connection', async () => {
  const ownerUrl = `postgres://${process.env.PGHOST ?? 'localhost'}:${process.env.PGPORT ?? '5432'}/${process.env.SB_TEST_DB}`;
  vi.stubEnv('ORG_AGENT','writer');
  vi.stubEnv('SB_ORG_DB_URL',`postgres://sb_org@${process.env.PGHOST ?? 'localhost'}:${process.env.PGPORT ?? '5432'}/${process.env.SB_TEST_DB}`);
  try {
    for (const verb of ['show','profiles','history']) await expect(cli([verb])).rejects.toThrow(/owner/);
  } finally {
    vi.unstubAllEnvs();
    setDatabaseUrl(ownerUrl);
  }
  vi.stubEnv('ORG_AGENT','owner');
  for (const verb of ['show','profiles','history']) await expect(cli([verb])).resolves.toBeDefined();
});
