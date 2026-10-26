import { query } from '../db.js';

interface Row {
  id: number; harness: string | null; host: string; project: string | null; card_project: string | null; started_at: Date | null; request: string; done: string;
  learned: string; open_items: string; outcome: string; metrics: { input_tokens?: number; cache_write_tokens?: number; cache_read_tokens?: number; output_tokens?: number };
}

const k = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
/** The tracker project when the session ran a card; else the folder the session ran in (a Claude Code cwd is stored as `-Users-me-Documents-vault`). */
export function groupOf(r: { card_project: string | null; project: string | null }): string {
  if (r.card_project) return r.card_project;
  const p = r.project?.trim();
  if (!p) return 'no project';
  const last = p.replace(/\/+$/, '').split(/[\/]/).pop() ?? p;
  return `folder ${p.startsWith('-') ? last.split('-').pop() : last}`;
}
const one = (s: string, n: number) => { const f = s.replace(/\s+/g, ' ').trim(); return f.length > n ? `${f.slice(0, n - 1)}…` : f; };

/**
 * What the stand-up reads: the last `hours` of summaries as markdown, grouped by project, with the
 * open items and the unreviewed candidate facts pulled out. Bounded by `maxChars` so the pack stays small.
 */
export async function buildDigest(hours = 24, maxChars = 6000): Promise<string> {
  const { rows } = await query<Row>(
    // card_project: the tracker project of the card a bot run worked on, when the session ran one.
    `SELECT s.id, s.harness, s.host, s.project, s.started_at, s.request, s.done, s.learned, s.open_items, s.outcome, s.metrics,
            (SELECT tl.project_slug FROM usage_runs r JOIN task_links tl ON tl.task_id = r.task_id
              WHERE r.host = s.host AND r.session_id = a.external_id AND tl.project_slug IS NOT NULL LIMIT 1) AS card_project
       FROM agent_summaries s JOIN archive_sessions a ON a.id = s.session_id
      WHERE s.status = 'ok' AND coalesce(s.ended_at, s.started_at, s.updated_at) >= now() - make_interval(hours => $1)
      ORDER BY coalesce(s.ended_at, s.started_at) DESC LIMIT 300`, [hours]);
  const skipped = (await query<{ n: string }>(
    `SELECT count(*) AS n FROM agent_summaries WHERE status = 'skipped' AND coalesce(ended_at, started_at, updated_at) >= now() - make_interval(hours => $1)`, [hours])).rows[0]!.n;
  if (!rows.length) return `## Agent activity, last ${hours}h\n\nNo summarized sessions (${skipped} too short to summarize).\n`;

  const by: Record<string, number> = {};
  for (const r of rows) by[r.outcome] = (by[r.outcome] ?? 0) + 1;
  // New tokens are input plus output; cache reads and writes are re-reads of the same context and dwarf them, so they are shown apart.
  const tok = (r: Row) => (r.metrics.input_tokens ?? 0) + (r.metrics.output_tokens ?? 0);
  const cache = (r: Row) => (r.metrics.cache_write_tokens ?? 0) + (r.metrics.cache_read_tokens ?? 0);
  const head = `## Agent activity, last ${hours}h\n\n${rows.length} sessions: ${Object.entries(by).map(([o, n]) => `${n} ${o}`).join(', ')}; ${skipped} too short to summarize; ${k(rows.reduce((n, r) => n + tok(r), 0))} input+output tokens (${k(rows.reduce((n, r) => n + cache(r), 0))} more from cache).\n`;

  const groups = new Map<string, Row[]>();
  for (const r of rows) { const g = groupOf(r); groups.set(g, [...(groups.get(g) ?? []), r]); }
  const body: string[] = [];
  for (const [project, list] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
    body.push(`\n### ${project} (${list.length})`);
    for (const r of list) body.push(`- [${r.outcome}] ${one(r.request, 140)} - ${one(r.done, 220)} (${r.harness ?? 'agent'}/${r.host}, ${k(tok(r))} tokens)`);
  }
  const open = rows.filter((r) => r.open_items.trim() && r.outcome !== 'finished').slice(0, 12);
  const openLines = open.length ? ['\n### Open items', ...open.map((r) => `- ${one(r.open_items, 200)} (${one(r.request, 60)})`)] : [];
  const facts = (await query<{ subject: string; claim: string }>(
    `SELECT f.subject, f.claim FROM agent_summary_facts f JOIN agent_summaries s ON s.id = f.summary_id
      WHERE f.status = 'proposed' AND s.status = 'ok' AND coalesce(s.ended_at, s.started_at, s.updated_at) >= now() - make_interval(hours => $1)
      ORDER BY f.id DESC LIMIT 8`, [hours])).rows;
  const factLines = facts.length ? ['\n### Learned, not yet reviewed', ...facts.map((f) => `- ${f.subject}: ${one(f.claim, 220)}`)] : [];

  let out = [head, ...body, ...openLines, ...factLines].join('\n');
  if (out.length > maxChars) out = `${out.slice(0, maxChars - 40).trimEnd()}\n\n[... cut at ${maxChars} characters]\n`;
  return `${out}\n`;
}
