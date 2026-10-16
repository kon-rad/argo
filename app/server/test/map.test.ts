import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { query } from '../src/db.js';
import { buildMap } from '../src/map/build.js';
import { buildGraph, noteAnchor, projectFolders, type GraphInput } from '../src/map/graph.js';
import { anchorPositions, layout, RING } from '../src/map/layout.js';
import {
  baseBalanceUsd, collectAll, collectors, insertSample, livestreamHours30d, metricViews,
  parseCount, parseFxTwitter, parseInstagramMeta, parseYouTubeChannel, type HttpGet,
} from '../src/metrics/collect.js';
import { ALL_MODULES, truncateAll } from './helpers.js';
import { parseSettings, resetSettings } from '../src/settings.js';

// The metrics and goals file these tests run with (an owner's secondbrain.json).
const SETTINGS = {
  goalsFile: 'CURRENT/goals-master.md',
  metrics: [
    { key: 'followers.total', label: 'Followers (IG + YouTube)', unit: 'followers', goal: 'Y2', target: 100_000, headline: true,
      sum: ['ig.example.followers', 'yt.one.subscribers', 'yt.two.subscribers'] },
    { key: 'ig.example.followers', label: 'Instagram @example', unit: 'followers', goal: 'Y2', collect: { type: 'instagram', handle: 'example' } },
    { key: 'yt.one.subscribers', label: 'YouTube @one', unit: 'subscribers', goal: 'Y2', collect: { type: 'youtube', handle: 'one' } },
    { key: 'yt.two.subscribers', label: 'YouTube @two', unit: 'subscribers', goal: 'Y2', collect: { type: 'youtube', handle: 'two' } },
    { key: 'x.example.followers', label: 'X @example', unit: 'followers', division: 'media', collect: { type: 'x', handle: 'example' } },
    { key: 'live.hours_30d', label: 'Livestream hours (30 days)', unit: 'hours', division: 'media', derived: 'livestream-hours-30d' }, // gitleaks:allow (a metric key)
    { key: 'fund.safe_usd', label: 'Fund Safe', unit: 'usd', division: 'fund', money: true,
      collect: { type: 'base-balance', addressFile: 'fund/state.json' } },
    { key: 'mrr_usd', label: 'MRR', unit: 'usd', goal: 'Y1', target: 1_000_000, money: true, placeholder: true },
  ],
};
const settingsFile = join(mkdtempSync(join(tmpdir(), 'sb-settings-')), 'secondbrain.json');
writeFileSync(settingsFile, JSON.stringify(SETTINGS));
process.env.SECONDBRAIN_SETTINGS = settingsFile;
resetSettings();
const METRICS = parseSettings(SETTINGS).metrics;

const GOALS = `## This week (2026-10-12 – 2026-10-18)
| # | Goal | Measure | Due | Status |
|---|---|---|---|---|
| W1 | Wearable prototype | x | 2026-10-18 | open |
| W2 | Old thing | x | 2026-10-18 | done |
## This year (to 2027-01-01)
| # | Goal | Measure | Due | Status |
|---|---|---|---|---|
| Y1 | Argo at 1M MRR | MRR | 2027-01-01 | not reported |
| Y2 | 100,000 followers | Follower count | 2027-01-01 | not reported |
`;

function input(): GraphInput {
  return {
    notes: [
      { id: 1, path: 'Projects/demo/demo-design.md', title: 'Demo design', mtime: '2026-10-14' },
      { id: 2, path: 'Projects/demo/notes/idea.md', title: 'Idea', mtime: '2026-10-14' },
      { id: 3, path: 'Areas/hardware/wearable/wiring.md', title: 'Wiring', mtime: '2026-10-14' },
      { id: 4, path: 'Areas/robotics/arm.md', title: 'Arm', mtime: '2026-10-14' },
      { id: 5, path: 'CURRENT/todo-master.md', title: 'Todo', mtime: '2026-10-14' },
      { id: 6, path: 'Research/ai/llm.md', title: 'LLM', mtime: '2026-10-14' },
    ],
    links: [{ from: 2, to: 1 }, { from: 6, to: 2 }],
    divisions: [{ slug: 'hardware', name: 'Hardware' }, { slug: 'second-brain', name: 'Second Brain' }],
    projects: [
      { slug: 'demo', title: 'Demo', division_slug: 'second-brain', stage: 'building', goals: ['W1'], paths: [], design_path: 'Projects/demo/demo-design.md', devlog_path: null },
      { slug: 'capture', title: 'Capture', division_slug: 'hardware', stage: 'building', goals: [], paths: [], design_path: 'Areas/hardware/wearable/capture-design.md', devlog_path: null },
      { slug: 'software', title: 'Software', division_slug: 'hardware', stage: 'testing', goals: [], paths: [], design_path: 'Areas/hardware/wearable/software-design.md', devlog_path: null },
    ],
    features: [{ id: 7, project_slug: 'demo', title: 'Feature', stage: 'live' }],
    goals: [
      { code: 'W1', horizon: 'This week', goal: 'Wearable', due: null, status: 'open' },
      { code: 'W2', horizon: 'This week', goal: 'Old', due: null, status: 'done' },
      { code: 'Y2', horizon: 'This year', goal: 'Followers', due: null, status: 'not reported' },
    ],
    divisionFolders: { hardware: ['Areas/robotics'] },
    missionFolders: ['CURRENT'],
    metrics: METRICS,
  };
}

describe('brain map graph', () => {
  it('anchors notes to the project, the division on a tie, a division folder, the mission, or nothing', () => {
    const inp = input();
    const owners = inp.projects.flatMap((project) => projectFolders(project).map((folder) => ({ folder, project })));
    expect(noteAnchor('Projects/demo/notes/idea.md', inp, owners)).toBe('project:demo');
    expect(noteAnchor('Areas/hardware/wearable/wiring.md', inp, owners)).toBe('division:hardware');
    expect(noteAnchor('Areas/robotics/arm.md', inp, owners)).toBe('division:hardware');
    expect(noteAnchor('CURRENT/todo-master.md', inp, owners)).toBe('mission');
    expect(noteAnchor('Research/ai/llm.md', inp, owners)).toBeNull();
  });

  it('builds the hierarchy, drops finished short-term goals, and adds metrics', () => {
    const g = buildGraph(input());
    const ids = new Set(g.nodes.map((n) => n.id));
    expect(ids.has('goal:W1')).toBe(true);
    expect(ids.has('goal:W2')).toBe(false);
    expect(ids.has('metric:followers.total')).toBe(true);
    expect(g.nodes.find((n) => n.id === 'metric:followers.total')!.parent).toBe('goal:Y2');
    // Y1 is not on this goals list, so MRR falls back to the mission.
    expect(g.nodes.find((n) => n.id === 'metric:mrr_usd')!.parent).toBe('mission');
    expect(g.edges).toContainEqual({ source: 'note:2', target: 'note:1', kind: 'link' });
    expect(g.edges).toContainEqual({ source: 'project:demo', target: 'goal:W1', kind: 'goal' });
    expect(g.edges).toContainEqual({ source: 'feature:7', target: 'project:demo', kind: 'belongs' });
  });
});

describe('brain map layout', () => {
  it('is deterministic for the same graph and seed', () => {
    const g = buildGraph(input());
    const a = layout(g, { ticks: 60 });
    const b = layout(g, { ticks: 60 });
    expect([...a]).toEqual([...b]);
  });

  it('puts the mission at the origin and each project inside its division sector', () => {
    const g = buildGraph(input());
    const pos = layout(g, { ticks: 60 });
    expect(pos.get('mission')).toEqual([0, 0, 0]);
    const angle = (v: number[]) => Math.atan2(v[2]!, v[0]!);
    const sector = Math.PI; // two divisions
    for (const p of g.nodes.filter((n) => n.kind === 'project')) {
      const d = pos.get(p.parent!)!;
      let diff = Math.abs(angle(pos.get(p.id)!) - angle(d));
      if (diff > Math.PI) diff = 2 * Math.PI - diff;
      expect(diff).toBeLessThanOrEqual(sector * 0.4 + 1e-9);
      expect(Math.hypot(pos.get(p.id)![0], pos.get(p.id)![2])).toBeGreaterThanOrEqual(RING.project - 0.05); // stored to 0.01
    }
  });

  it('keeps anchors fixed and unanchored notes out in the shell', () => {
    const g = buildGraph(input());
    const anchors = anchorPositions(g);
    const pos = layout(g, { ticks: 120 });
    for (const [id, p] of anchors) expect(pos.get(id)).toEqual(p.map((v) => Math.round(v * 100) / 100));
    const llm = pos.get('note:6')!;
    expect(Math.hypot(...llm)).toBeGreaterThan(RING.project);
  });
});

describe('metric parsers', () => {
  it('reads counts the way the platforms print them', () => {
    expect(parseCount('36')).toBe(36);
    expect(parseCount('1,204')).toBe(1204);
    expect(parseCount('1.2K')).toBe(1200);
    expect(parseCount('3.4M')).toBe(3_400_000);
    expect(() => parseCount('lots')).toThrow();
  });

  it('parses each source and refuses a page it does not understand', () => {
    expect(parseFxTwitter('{"code":200,"user":{"followers":38}}')).toBe(38);
    expect(() => parseFxTwitter('{"code":404}')).toThrow(/no followers/);
    expect(parseYouTubeChannel('..."metadataParts":[{"text":{"content":"36 subscribers"}}]..."36 subscribers"')).toBe(36);
    expect(() => parseYouTubeChannel('<html>consent</html>')).toThrow();
    expect(parseInstagramMeta('<meta property="og:description" content="39 Followers, 33 Following, 9 Posts - x"')).toBe(39);
    expect(() => parseInstagramMeta('<html>login</html>')).toThrow(/login wall/);
  });

  it('prices the Safe from ETH and USDC balances', async () => {
    const rpc = async (method: string) => (method === 'eth_getBalance' ? '0xde0b6b3a7640000' /* 1 ETH */ : '0x' + (25_500_000).toString(16) /* 25.5 USDC */);
    const get: HttpGet = async () => ({ status: 200, body: '{"data":{"amount":"2500.00"}}' });
    expect(await baseBalanceUsd('0x' + '1'.repeat(40), rpc, get)).toEqual({ usd: 2525.5, eth: 1, usdc: 25.5, ethUsd: 2500 });
  });
});

describe('metrics in the database', () => {
  beforeEach(async () => { await truncateAll(); });

  it('a failed source writes nothing; the rest are written', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sb-metrics-'));
    const get: HttpGet = async (url) => {
      if (url.includes('fxtwitter')) return { status: 200, body: '{"user":{"followers":38}}' };
      if (url.includes('youtube')) return { status: 200, body: '"36 subscribers"' };
      return { status: 401, body: 'nope' };
    };
    const res = await collectAll(collectors(root, get, async () => '0x0'));
    expect(res.find((r) => r.metric === 'x.example.followers')!.value).toBe(38);
    expect(res.find((r) => r.metric === 'ig.example.followers')!.error).toMatch(/HTTP 401/);
    expect(res.find((r) => r.metric === 'fund.safe_usd')!.error).toMatch(/no address configured/);
    const { rows } = await query<{ n: number }>(`SELECT count(*)::int AS n FROM metric_samples`);
    expect(rows[0]!.n).toBe(3); // X + two YouTube channels
  });

  it('a sum shows only when every part has a reading; placeholders stay null', async () => {
    await insertSample({ metric: 'yt.one.subscribers', source: 't', value: 36 });
    await insertSample({ metric: 'yt.two.subscribers', source: 't', value: 4 });
    let views = await metricViews();
    expect(views.find((m) => m.key === 'followers.total')!.value).toBeNull();
    await insertSample({ metric: 'ig.example.followers', source: 't', value: 39 });
    views = await metricViews();
    expect(views.find((m) => m.key === 'followers.total')!.value).toBe(79);
    expect(views.find((m) => m.key === 'mrr_usd')!.value).toBeNull();
    await expect(insertSample({ metric: 'followers.total', source: 't', value: 1 })).rejects.toThrow(/computed/);
  });

  it('counts overlapping streams once', async () => {
    const now = new Date('2026-10-15T12:00:00Z');
    await query(`INSERT INTO livestream_sessions (platform, started_at, last_seen_at, ended_at) VALUES
      ('youtube', '2026-10-14T10:00:00Z', '2026-10-14T12:00:00Z', '2026-10-14T12:00:00Z'),
      ('twitch',  '2026-10-14T11:00:00Z', '2026-10-14T13:00:00Z', '2026-10-14T13:00:00Z'),
      ('kick',    '2026-08-01T10:00:00Z', '2026-08-01T12:00:00Z', '2026-08-01T12:00:00Z')`);
    expect(await livestreamHours30d(now)).toBe(3);
  });
});

describe('map API', () => {
  beforeEach(async () => { await truncateAll(); });

  async function seed(): Promise<string> {
    const root = mkdtempSync(join(tmpdir(), 'sb-map-'));
    mkdirSync(join(root, 'CURRENT'));
    writeFileSync(join(root, 'CURRENT', 'goals-master.md'), GOALS);
    await query(`INSERT INTO divisions (slug, name, sort) VALUES ('second-brain', 'Second Brain', 1)`);
    await query(`INSERT INTO projects (slug, title, stage, division_slug, design_path) VALUES ('demo', 'Demo', 'building', 'second-brain', 'Projects/demo/demo-design.md')`);
    for (const [path, title] of [['Projects/demo/demo-design.md', 'Demo design'], ['Projects/demo/idea.md', 'Idea'], ['Archives/old.md', 'Old']]) {
      await query(
        `INSERT INTO vault_files (path,parent_path,name,title,ext,is_markdown,size_bytes,mtime,content_hash,body)
         VALUES ($1, '', $1, $2, '.md', true, 1, now(), 'h', $3)`, [path, title, `# ${title}\nbody`]);
    }
    await query(`INSERT INTO vault_links (from_file_id, target_raw, target_file_id) VALUES (2, 'demo-design', 1)`);
    return root;
  }

  it('builds a layout and serves it with an ETag; archives are left out', async () => {
    const root = await seed();
    const r = await buildMap(root);
    expect(r.version).toBe(1);
    const app = createApp({ modules: ALL_MODULES, vaultRoot: root });
    const res = await request(app).get('/api/map/graph').expect(200);
    expect(res.headers['etag']).toBe('"map-1"');
    const ids = res.body.nodes.map((n: { id: string }) => n.id);
    expect(ids).toContain('mission');
    expect(ids).toContain('project:demo');
    expect(ids).toContain('note:2');
    expect(ids).not.toContain('note:3');
    expect(res.body.edges).toContainEqual({ source: 'note:2', target: 'note:1', kind: 'link' });
    await request(app).get('/api/map/graph').set('If-None-Match', '"map-1"').expect(304);

    const node = await request(app).get('/api/map/node/note:2').expect(200);
    expect(node.body.preview).toContain('body');
    expect(node.body.neighbours.map((n: { id: string }) => n.id)).toEqual(expect.arrayContaining(['note:1', 'project:demo']));
  });

  it('404s before the first build', async () => {
    await request(createApp({ modules: ALL_MODULES, vaultRoot: mkdtempSync(join(tmpdir(), 'sb-map-')) })).get('/api/map/graph').expect(404);
  });

  it('never sends money to the kiosk', async () => {
    await insertSample({ metric: 'fund.safe_usd', source: 't', value: 123.45 });
    const app = createApp({ modules: ALL_MODULES, vaultRoot: mkdtempSync(join(tmpdir(), 'sb-map-')) });
    const full = await request(app).get('/api/map/metrics').expect(200);
    expect(full.body.metrics.find((m: { key: string }) => m.key === 'fund.safe_usd').value).toBe(123.45);
    const kiosk = await request(app).get('/api/map/metrics?kiosk=1').expect(200);
    const fund = kiosk.body.metrics.find((m: { key: string }) => m.key === 'fund.safe_usd');
    expect(fund.value).toBeNull();
    expect(JSON.stringify(kiosk.body)).not.toContain('123.45');
  });
});
