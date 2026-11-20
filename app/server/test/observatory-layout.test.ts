import { beforeEach, expect, it, vi } from 'vitest';
const db = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../src/db.js', () => db);
vi.mock('../src/metrics/collect.js', () => ({ metricViews: vi.fn() }));
import { mapRouter } from '../src/routes/map.js';
beforeEach(() => { db.query.mockReset(); });
function graph(query: object, headers = {}, path = '/graph') {
  return new Promise<any>((resolve, reject) => {
    const res: any = { setHeader: vi.fn(), status: vi.fn(() => res), json: (body: unknown) => resolve({ body, res }), end: () => resolve({ res }) };
    const layer = mapRouter().stack.find((l: any) => l.route?.path === path) as any;
    layer.route.stack[0].handle({ query, headers, params: { id: 'note:1' } }, res, reject);
  });
}
it('uses requested layout for all graph reads and keeps default newest-layout behavior', async () => {
  db.query.mockImplementation(async (sql: string, args: unknown[]) => sql.includes('map_layouts') ? { rows: [{ version: args[0] ?? 8, built_at: '2026-11-01T00:00:00Z' }] } : { rows: [] });
  const pinned = await graph({ version: '7' });
  expect(pinned.body.version).toBe(7);
  expect(db.query.mock.calls.map(([, args]) => args)).toEqual([[7], [7], [7]]);
  expect(db.query.mock.calls[0]![0]).toContain('version = $1');
  expect(pinned.res.setHeader).toHaveBeenCalledWith('ETag', '"map-7"');
  db.query.mockClear();
  expect((await graph({})).body.version).toBe(8);
  expect(db.query.mock.calls[0]![1]).toEqual([null]);
});
it('rejects malformed versions before database reads and never substitutes missing layout', async () => {
  for (const version of ['bad', '0', '-1', '1.5', '2147483648']) await expect(graph({ version })).rejects.toHaveProperty('status', 400);
  expect(db.query).not.toHaveBeenCalled();
  db.query.mockResolvedValue({ rows: [] });
  const missing = await graph({ version: '7' });
  expect(missing.res.status).toHaveBeenCalledWith(404);
  expect(missing.body.error).toMatch(/requested layout unavailable/);
  expect(db.query).toHaveBeenCalledTimes(1);
});

it('pins detail and neighbours and labels the separately fetched preview as current', async () => {
  db.query.mockImplementation(async (sql: string, args: unknown[]) => {
    if (sql.includes('map_layouts')) return { rows: [{ version: args?.[0] ?? 8 }] };
    if (sql.includes('FROM map_nodes')) return { rows: [{ id: 'note:1', kind: 'note', ref: 'Projects/demo.md', label: args[0] === 7 ? 'Pinned' : 'Newer' }] };
    if (sql.includes('FROM map_edges')) return { rows: [{ id: args[0] === 7 ? 'old-neighbour' : 'new-neighbour' }] };
    return { rows: [{ body: 'Current body' }] };
  });
  const pinned = await graph({ version: '7' }, {}, '/node/:id');
  expect(pinned.body.version).toBe(7);
  expect(pinned.body.node.label).toBe('Pinned');
  expect(pinned.body.neighbours).toEqual([{ id: 'old-neighbour' }]);
  expect(pinned.body.previewContext).toBe('current-vault-content');
  expect(db.query.mock.calls.slice(0, 3).map(([, args]) => args)).toEqual([[7], [7, 'note:1'], [7, 'note:1']]);
  expect((await graph({}, {}, '/node/:id')).body.node.label).toBe('Newer');
});
it('never substitutes missing detail layouts and validates versions before reads', async () => {
  for (const version of ['bad', '0', '-1', '1.5', '2147483648']) await expect(graph({ version }, {}, '/node/:id')).rejects.toHaveProperty('status', 400);
  expect(db.query).not.toHaveBeenCalled();
  db.query.mockResolvedValue({ rows: [] });
  const missing = await graph({ version: '7' }, {}, '/node/:id');
  expect(missing.res.status).toHaveBeenCalledWith(404);
  expect(missing.body.error).toMatch(/requested layout unavailable/);
  expect(db.query).toHaveBeenCalledTimes(1);
});
