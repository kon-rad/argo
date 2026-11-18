/**
 * Fixture vaults for checking the Skills pages in a browser (docs/skills.md, "Fixture startup").
 *
 *   npx tsx server/test/helpers/skills-demo.ts <dir> [--db]
 *
 * Writes three fake vaults under <dir>: `full/vault` (managed policy, an override, duplicates, invalid
 * packages, a draft and a proposed change), `empty` (no skills, no roster) and `broken/vault` (an
 * unparseable policy). With --db (DATABASE_URL set, migrations applied) it also deploys `full` into
 * <dir>/managed and records acknowledgements for three fake hosts: one current, one drifted and one
 * registered but never seen. All data is fake; nothing outside <dir> or the given database is touched.
 */
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { MANAGED_POLICY, SETTINGS, skillMd, skillsFixture, write } from './skills.js';

const dir = resolve(process.argv.slice(2).find(a => !a.startsWith('--')) ?? 'skills-demo');
const withDb = process.argv.includes('--db');
mkdirSync(dirname(dir), { recursive: true });
try { mkdirSync(dir); } catch (err) {
  if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Fixture target already exists; choose a new directory. Nothing was removed.');
  throw err;
}
mkdirSync(join(dir, 'full'), { recursive: true });
mkdirSync(join(dir, 'broken'), { recursive: true });

const { SkillsService } = await import('../../src/addons/skills/service.js');
const { planViews, syncViews } = await import('../../src/addons/skills/reconcile.js');

// The fixture's own engine folder is listed as an external root, so the app (which also reads the real
// engine skills) resolves the fixture's link-skills link the same way the tests do.
const settingsFor = (engine: string) => JSON.stringify({ addons: ['skills'], skills: { externalRoots: [{ id: 'demo-engine', path: engine, label: 'demo engine' }] } }, null, 2);

const full = skillsFixture({ base: join(dir, 'full') });
write(join(full.vault, 'secondbrain.json'), settingsFor(full.engine));
write(join(full.vault, '.agents', 'skills-policy.yaml'), `${MANAGED_POLICY}lifecycle:\n  video: { status: deprecated, replacement: clip, note: use clip }\n`);
const service = new SkillsService(full.vault, { ...SETTINGS, externalRoots: [{ id: 'demo-engine', path: full.engine }] }, { db: false });
await service.createDraft('report', 'report');
await service.writeDraftFile('report', 'SKILL.md', skillMd('report', 'Private report skill, revised in a draft.'), undefined, (await service.readDraftFile('report', 'SKILL.md')).version);
await service.propose({ kind: 'deprecate', skill: 'clip', note: 'demo proposal' });

const empty = join(dir, 'empty');
mkdirSync(join(empty, '.agents', 'skills'), { recursive: true });
write(join(empty, 'secondbrain.json'), JSON.stringify({ addons: ['skills'] }));

const broken = skillsFixture({ base: join(dir, 'broken'), git: false });
write(join(broken.vault, 'secondbrain.json'), settingsFor(broken.engine));
write(join(broken.vault, '.agents', 'skills-policy.yaml'), 'version: 1\nmode: managed\norg: { grant: [Not A Name] }\n');

if (withDb) {
  const { query, pool } = await import('../../src/db.js');
  const { config } = await import('../../src/config.js');
  if (!/^[a-z_][a-z0-9_]*_test$/.test(new URL(config.databaseUrl).pathname.slice(1))) throw new Error('The demo --db option requires a scratch database ending in _test.');
  try {
  const st = await service.current(true);
  const report = syncViews(join(dir, 'managed'), planViews(st.catalog, st.policy, st.roster, { agents: ['alpha', 'beta'] }), { env: { PATH: '' } });
  if (report.views.some(v => v.status !== 'current')) throw new Error('Demo views did not reconcile completely');
  await query(`DELETE FROM skill_view_acks WHERE host = ANY($1)`, [['demo-current','demo-drift','demo-never']]);
  await query(`DELETE FROM skill_ack_log WHERE host = ANY($1)`, [['demo-current','demo-drift','demo-never']]);
  for (const h of ['demo-current', 'demo-drift', 'demo-never']) {
    await query(`INSERT INTO usage_hosts (slug, display, kind) VALUES ($1, $1, 'server') ON CONFLICT DO NOTHING`, [h]);
  }
  // Written directly (the HTTP door needs a device token); same rows POST /api/skills/ack writes.
  const ack = async (host: string, views: typeof report.views) => {
    for (const v of views) {
      await query(`INSERT INTO skill_view_acks (host, agent, runtime, status, error, view_digest, policy_digest, generated_at, skills, missing, dirty)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (host, agent, runtime) DO UPDATE SET status=EXCLUDED.status, skills=EXCLUDED.skills, received_at=now()`,
        [host, v.agent, v.runtime, v.status, v.error, v.viewDigest, report.policyDigest, v.generatedAt, JSON.stringify(v.skills), JSON.stringify(v.missing), JSON.stringify(v.dirty)]);
    }
    await query(`INSERT INTO skill_ack_log (host, views, failed, dirty, policy_digest) VALUES ($1,$2,0,0,$3)`, [host, views.length, report.policyDigest]);
  };
  await ack('demo-current', report.views);
  await ack('demo-drift', report.views.map((v) => ({ ...v, skills: v.skills.map((s) => ({ ...s, digest: `sha256:${'0'.repeat(64)}` })) })));
  const live = new SkillsService(full.vault, { ...SETTINGS, externalRoots: [{ id: 'demo-engine', path: full.engine }] });
  const states = Object.fromEntries((await live.machines()).hosts.map(h => [h.host, h.status]));
  for (const [host, expected] of Object.entries({ 'demo-current': 'current', 'demo-drift': 'drift', 'demo-never': 'never' })) {
    if (states[host] !== expected) throw new Error(`Demo host ${host}: expected ${expected}, got ${states[host]}`);
  }
  console.log('demo hosts: demo-current=current, demo-drift=drift, demo-never=never');
  } finally { await pool.end(); }
}

console.log(`fixture vaults:\n  full:   ${full.vault}\n  empty:  ${empty}\n  broken: ${broken.vault}`);
console.log(`start the app on one, e.g.:\n  VAULT_ROOT=${full.vault} MODULES=skills npm run dev`);
