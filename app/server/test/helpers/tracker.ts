import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { query, withTransaction } from '../../src/db.js';

/**
 * Fixtures for the tests that read the change history by time (the context pack, the
 * weekly review). The triggers stamp every event with the database clock, so a test that
 * needs an event on a given day makes the change and then moves its rows to that day.
 */

/** Runs `fn`, then dates every history row it wrote at `time`. The log is append-only, so the guard is lifted for this one transaction. */
export async function at<T>(time: string, fn: () => Promise<T>): Promise<T> {
  const before = (await query<{ id: string }>(`SELECT coalesce(max(id), 0) AS id FROM tracker_events`)).rows[0]!.id;
  const result = await fn();
  await withTransaction(async (tx) => {
    await tx.query(`ALTER TABLE tracker_events DISABLE TRIGGER tracker_events_append_only`);
    await tx.query(`UPDATE tracker_events SET at = $2 WHERE id > $1`, [before, time]);
    await tx.query(`ALTER TABLE tracker_events ENABLE TRIGGER tracker_events_append_only`);
  });
  return result;
}

/** A file in the vault, written to disk. */
export function note(root: string, rel: string, text: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}

/** A row of the vault index, as the scanner would have left it for a file last changed at `mtime`. */
export async function indexed(path: string, mtime: string): Promise<void> {
  const name = path.split('/').pop()!;
  await query(
    `INSERT INTO vault_files (path, parent_path, name, title, ext, is_markdown, size_bytes, mtime, content_hash, body)
     VALUES ($1, $2, $3, $3, $4, $5, 1, $6, md5($1), '')`,
    [path, dirname(path), name, name.includes('.') ? name.split('.').pop() : '', /\.md$/.test(name), mtime],
  );
}

/** A finished card. `area` and `project` may both be null: a card needs neither. */
export async function finishedCard(id: string, title: string, completedAt: string, area: string | null = null, project: string | null = null): Promise<void> {
  await query(`INSERT INTO org_agents (name, runtime, role, org_version) VALUES ('builder', 'claude-code', 'Engineer', 'v') ON CONFLICT DO NOTHING`);
  await query(`INSERT INTO boards (slug, name) VALUES ('exo', 'Exo') ON CONFLICT DO NOTHING`);
  await query(
    `INSERT INTO cards (id, board_slug, title, status, assignee, created_by, area_slug, project_slug, completed_at)
     VALUES ($1, 'exo', $2, 'done', 'builder', 'builder', $3, $4, $5)`,
    [id, title, area, project, completedAt],
  );
}
