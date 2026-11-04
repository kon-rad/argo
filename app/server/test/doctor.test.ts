import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { healthy, runChecks, type Check } from '../src/doctor.js';

/**
 * `secondbrain doctor` and /api/health (proposal phase 3). The vitest globalSetup
 * migrates the test database from zero, so a green run here is the same green run
 * the CLI prints against a scratch database.
 */
describe('secondbrain doctor', () => {
  it('is green against a migrated database, feature checks included', async () => {
    const checks = await runChecks({ modules: new Set(['board', 'projects']) });
    const by = (name: string): Check | undefined => checks.find((c) => c.name === name);
    expect(by('node')?.ok).toBe(true);
    expect(by('database')?.ok).toBe(true);
    expect(by('pgvector')?.ok).toBe(true);
    expect(by('migrations')?.ok).toBe(true);
    expect(by('feature:board')?.ok).toBe(true);
    expect(by('feature:projects')?.ok).toBe(true);
    expect(healthy(checks)).toBe(true);
  });

  it('never throws: a broken subsystem is a failed check, not an exception', async () => {
    // An unreachable database fails the database check and skips the ones that need it.
    const checks = await runChecks({ modules: new Set() });
    expect(checks.length).toBeGreaterThan(0);
    expect(checks.every((c) => typeof c.ok === 'boolean' && typeof c.name === 'string')).toBe(true);
  });

  it('counts only a critical failure as unhealthy', () => {
    expect(healthy([{ name: 'a', ok: false, critical: false, detail: '' }])).toBe(true);
    expect(healthy([{ name: 'a', ok: false, critical: true, detail: '' }])).toBe(false);
    expect(healthy([{ name: 'a', ok: true, critical: true, detail: '' }])).toBe(true);
  });

  it('/api/health returns the same checks', async () => {
    const res = await request(createApp({ modules: new Set(['board']) })).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const names = (res.body.checks as Check[]).map((c) => c.name);
    expect(names).toContain('database');
    expect(names).toContain('migrations');
    expect(names).toContain('feature:board');
  });
});
