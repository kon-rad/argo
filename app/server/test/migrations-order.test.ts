import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * node-pg-migrate orders migrations by their numeric prefix and refuses to run one whose prefix is not above the
 * last applied one. Two files with the same prefix pass the test suite (globalSetup runs with --no-check-order) and
 * then fail the deploy once the first of the pair is applied (2026-11-02: 1756000016600_org-agent-avatar next to
 * 1756000016600_session-channel rolled the deploy back). Keep every prefix unique.
 */
/** Pairs that shipped before this check existed and are applied everywhere; nothing new may join this list. */
const HISTORICAL = new Set(['1756000012800_ring-sync-log.sql and 1756000012800_task-links-graph.sql']);

describe('migrations', () => {
  it('have unique numeric prefixes', () => {
    const dir = join(import.meta.dirname, '..', '..', 'db', 'migrations');
    const names = readdirSync(dir).filter((f) => f.endsWith('.sql'));
    const seen = new Map<string, string>();
    const dupes: string[] = [];
    for (const n of names.sort()) {
      const prefix = n.split('_')[0]!;
      expect(prefix).toMatch(/^\d+$/);
      const other = seen.get(prefix);
      if (other) dupes.push(`${other} and ${n}`);
      seen.set(prefix, n);
    }
    expect(dupes.filter((d) => !HISTORICAL.has(d)), 'migrations sharing a numeric prefix').toEqual([]);
  });
});
