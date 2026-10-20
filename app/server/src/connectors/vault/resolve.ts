import { query } from '../../db.js';

const AMBIGUOUS = Symbol('ambiguous');

/**
 * The lookup tables for one snapshot of `vault_files`. Shared by the scanner's
 * second pass and `/api/file/resolve`, so a link the board shows and an edge in
 * the link graph can never disagree about where a name points.
 */
export function buildResolver(files: { id: number; path: string; name: string }[]): (target: string) => number | null {
  const byPath = new Map<string, number>();
  const byPathNoExt = new Map<string, number>();
  const byStem = new Map<string, number | typeof AMBIGUOUS>();

  for (const f of files) {
    byPath.set(f.path.toLowerCase(), f.id);

    const noExt = f.path.replace(/\.[^./]+$/, '').toLowerCase();
    if (!byPathNoExt.has(noExt)) byPathNoExt.set(noExt, f.id);

    const stem = f.name.replace(/\.[^./]+$/, '').toLowerCase();
    byStem.set(stem, byStem.has(stem) ? AMBIGUOUS : f.id);
  }

  return (target) => {
    const raw = target.trim().replace(/^\.\//, '').toLowerCase();
    const exact = byPath.get(raw) ?? byPath.get(`${raw}.md`) ?? byPathNoExt.get(raw);
    if (exact !== undefined) return exact;
    const stem = byStem.get(raw.split('/').pop() ?? raw);
    return typeof stem === 'number' ? stem : null;
  };
}

/**
 * Second pass: turn `target_raw` strings into `vault_files` ids, once every
 * path in the vault is known.
 *
 * Resolution order is exact path, then path with `.md` appended, then a unique
 * filename stem. An AMBIGUOUS stem resolves to nothing on purpose — a wrong
 * edge in the link graph is worse than a visible gap, because a gap shows up
 * dimmed in the UI and a wrong edge silently misroutes navigation forever.
 */
export async function resolveLinks(): Promise<{ resolved: number; unresolved: number }> {
  const { rows: files } = await query<{ id: number; path: string; name: string }>(
    `SELECT id, path, name FROM vault_files`,
  );
  const resolve = buildResolver(files);

  const { rows: links } = await query<{ id: number; target_raw: string; target_file_id: number | null }>(
    `SELECT id, target_raw, target_file_id FROM vault_links`,
  );

  const updates: { id: number; targetId: number | null }[] = [];
  let resolved = 0;
  let unresolved = 0;

  for (const link of links) {
    const targetId = resolve(link.target_raw);

    if (targetId !== null) resolved++;
    else unresolved++;

    if (targetId !== link.target_file_id) updates.push({ id: link.id, targetId });
  }

  if (updates.length > 0) {
    await query(
      `UPDATE vault_links SET target_file_id = u.tid
       FROM (SELECT * FROM unnest($1::int[], $2::int[]) AS t(lid, tid)) u
       WHERE vault_links.id = u.lid`,
      [updates.map((u) => u.id), updates.map((u) => u.targetId)],
    );
  }

  return { resolved, unresolved };
}
