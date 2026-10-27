import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, relative, sep } from 'node:path';
import matter from 'gray-matter';
import { z } from 'zod';
import { query, withTransaction } from './db.js';
import { metrics } from './metrics/registry.js';
import { TrackerError } from './projects.js';
import { settings } from './settings.js';

/**
 * Ventures: the things the owner runs. A venture is a row (what it is, its
 * kind, parent, division, goals, links) plus a vault folder, `home_path`,
 * with a standard layout:
 *
 *   <home_path>/README.md   front page (required)
 *   <home_path>/brand/      brand.md (tokens + voice), logo/, fonts/, images/
 *   <home_path>/kpis.md     generated from the database, never hand-edited
 *   <home_path>/docs/       whatever the venture needs
 *
 * Nothing here names a venture. Kinds come from settings, brand tokens are
 * whatever keys brand.md's frontmatter holds, and nothing requires any.
 */

const Slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,47}$/);
const GoalCode = z.string().regex(/^[A-Z][0-9]{1,3}$/);
const Text = z.string().trim().min(1).max(2000);

/** A venture's folder lives under Areas/ (ongoing) or Projects/ (a startup in its first months). */
export const HOME_BUCKETS = ['Areas', 'Projects'] as const;

export function checkHomePath(p: string): string {
  const n = normalize(p).replace(/\/+$/, '');
  const parts = n.split(sep);
  if (isAbsolute(n) || parts.includes('..') || parts.length < 2 || !HOME_BUCKETS.includes(parts[0] as (typeof HOME_BUCKETS)[number])) {
    throw new TrackerError(`home_path must be a vault folder under ${HOME_BUCKETS.join('/ or ')}/ (got "${p}")`);
  }
  return n;
}

const Link = z.object({ label: Text.max(100), url: z.string().url().max(500) });

export const VenturePatch = z
  .object({
    name: Text.max(100),
    kind: z.string(),
    summary: Text.nullable(),
    parent: Slug.nullable(),
    division: Slug.nullable(),
    home_path: Text.max(300).nullable(),
    goals: z.array(GoalCode),
    links: z.array(Link),
    sort: z.number().int(),
  })
  .partial()
  .strict();
export type VenturePatch = z.infer<typeof VenturePatch>;

const VENTURE_COLS: Record<string, string> = {
  name: 'name', kind: 'kind', summary: 'summary', parent: 'parent_slug', division: 'division_slug',
  home_path: 'home_path', goals: 'goals', links: 'links', sort: 'sort',
};

export function ventureKinds(): readonly string[] {
  return settings().ventures.kinds;
}

/**
 * Creates (`create`) or updates a venture. Ventures nest one level: a parent
 * must itself have no parent, and a venture that has children can't take one.
 */
export async function upsertVenture(
  slug: string,
  raw: VenturePatch,
  by: string,
  opts: { create?: boolean } = {},
): Promise<{ created: boolean }> {
  Slug.parse(slug);
  const patch = VenturePatch.parse(raw);
  if (patch.kind !== undefined && !ventureKinds().includes(patch.kind)) {
    throw new TrackerError(`unknown kind "${patch.kind}" (allowed: ${ventureKinds().join(', ')})`);
  }
  if (patch.home_path) patch.home_path = checkHomePath(patch.home_path);
  return withTransaction(async (tx) => {
    const cur = await tx.query(`SELECT slug FROM ventures WHERE slug = $1 FOR UPDATE`, [slug]);
    if (!cur.rows[0]) {
      if (!opts.create) throw new TrackerError(`no venture "${slug}" (add it first)`, 404);
      if (!patch.name) throw new TrackerError('a new venture needs a name');
      await tx.query(`INSERT INTO ventures (slug, name, updated_by) VALUES ($1,$2,$3)`, [slug, patch.name, by]);
    }
    if (patch.parent) {
      if (patch.parent === slug) throw new TrackerError('a venture cannot be its own parent');
      const p = await tx.query<{ parent_slug: string | null }>(`SELECT parent_slug FROM ventures WHERE slug = $1`, [patch.parent]);
      if (!p.rows[0]) throw new TrackerError(`no venture "${patch.parent}" to use as parent`);
      if (p.rows[0].parent_slug) throw new TrackerError(`"${patch.parent}" is itself a child; ventures nest one level`);
      const kids = await tx.query(`SELECT 1 FROM ventures WHERE parent_slug = $1 LIMIT 1`, [slug]);
      if (kids.rowCount) throw new TrackerError(`"${slug}" has children, so it can't take a parent; ventures nest one level`);
    }
    if (patch.division) {
      const d = await tx.query(`SELECT 1 FROM divisions WHERE slug = $1`, [patch.division]);
      if (!d.rowCount) throw new TrackerError(`no division "${patch.division}"`);
    }
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, col] of Object.entries(VENTURE_COLS)) {
      if (!(k in patch)) continue;
      const v = (patch as Record<string, unknown>)[k];
      vals.push(k === 'links' ? JSON.stringify(v) : v);
      sets.push(`${col} = $${2 + vals.length}${k === 'links' ? '::jsonb' : ''}`);
    }
    await tx.query(
      `UPDATE ventures SET ${[...sets, 'updated_at = now()', 'updated_by = $2'].join(', ')} WHERE slug = $1`,
      [slug, by, ...vals],
    );
    return { created: !cur.rows[0] };
  });
}

/** Points a project at the venture it builds (null clears it). */
export async function setProjectVenture(project: string, venture: string | null): Promise<void> {
  if (venture) {
    const v = await query(`SELECT 1 FROM ventures WHERE slug = $1`, [venture]);
    if (!v.rowCount) throw new TrackerError(`no venture "${venture}"`);
  }
  const r = await query(`UPDATE projects SET venture_slug = $2, updated_at = now() WHERE slug = $1`, [project, venture]);
  if (!r.rowCount) throw new TrackerError(`no project "${project}"`, 404);
}

// ---------------------------------------------------------------- brand

export interface Brand {
  /** Every frontmatter key of brand.md, as written. The engine requires none. */
  tokens: Record<string, unknown>;
  /** brand.md's body: voice and usage notes. */
  body: string;
  file: string;
  /** Files under brand/logo, fonts and images, vault-relative. */
  assets: { logo: string[]; fonts: string[]; images: string[] };
}

function listFiles(root: string, dir: string): string[] {
  const abs = join(root, dir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs)
    .filter((f) => !f.startsWith('.') && statSync(join(abs, f)).isFile())
    .sort()
    .map((f) => join(dir, f));
}

/** Reads `<home>/brand/brand.md`; null when the venture has no brand file. Never throws on a malformed one. */
export function readBrand(vaultRoot: string, home: string | null): Brand | null {
  if (!home) return null;
  const file = join(checkHomePath(home), 'brand', 'brand.md');
  const abs = join(vaultRoot, file);
  if (!existsSync(abs)) return null;
  let tokens: Record<string, unknown> = {};
  let body = '';
  try {
    const m = matter(readFileSync(abs, 'utf8'));
    tokens = m.data;
    body = m.content.trim();
  } catch {
    body = readFileSync(abs, 'utf8');
  }
  const dir = dirname(file);
  return {
    tokens, body, file,
    assets: { logo: listFiles(vaultRoot, join(dir, 'logo')), fonts: listFiles(vaultRoot, join(dir, 'fonts')), images: listFiles(vaultRoot, join(dir, 'images')) },
  };
}

// ---------------------------------------------------------------- views

export interface VentureView {
  slug: string;
  name: string;
  kind: string;
  summary: string | null;
  parent: string | null;
  division: string | null;
  home_path: string | null;
  goals: string[];
  links: { label: string; url: string }[];
  sort: number;
  projects: { slug: string; title: string; stage: string; health: string | null }[];
  children: string[];
  has_readme: boolean;
  has_brand: boolean;
}

interface VentureRow {
  slug: string; name: string; kind: string; summary: string | null; parent_slug: string | null;
  division_slug: string | null; home_path: string | null; goals: string[]; links: { label: string; url: string }[]; sort: number;
}

export async function listVentures(vaultRoot: string): Promise<VentureView[]> {
  const [v, p] = await Promise.all([
    query<VentureRow>(`SELECT * FROM ventures ORDER BY sort, name`),
    query<{ slug: string; title: string; stage: string; health: string | null; venture_slug: string }>(
      `SELECT slug, title, stage, health, venture_slug FROM projects WHERE venture_slug IS NOT NULL ORDER BY priority NULLS LAST, slug`,
    ),
  ]);
  return v.rows.map((r) => ({
    slug: r.slug, name: r.name, kind: r.kind, summary: r.summary, parent: r.parent_slug, division: r.division_slug,
    home_path: r.home_path, goals: r.goals, links: r.links, sort: r.sort,
    projects: p.rows.filter((x) => x.venture_slug === r.slug).map(({ venture_slug: _v, ...rest }) => rest),
    children: v.rows.filter((c) => c.parent_slug === r.slug).map((c) => c.slug),
    has_readme: Boolean(r.home_path && existsSync(join(vaultRoot, r.home_path, 'README.md'))),
    has_brand: Boolean(r.home_path && existsSync(join(vaultRoot, r.home_path, 'brand', 'brand.md'))),
  }));
}

export async function getVenture(vaultRoot: string, slug: string): Promise<VentureView & { brand: Brand | null; kpis: Kpi[] }> {
  const v = (await listVentures(vaultRoot)).find((x) => x.slug === slug);
  if (!v) throw new TrackerError(`no venture "${slug}"`, 404);
  return { ...v, brand: readBrand(vaultRoot, v.home_path), kpis: await ventureKpis(slug) };
}

// ---------------------------------------------------------------- kpis

export interface Kpi {
  key: string; label: string; unit: string; money: boolean; target: number | null;
  value: number | null; sampled_at: string | null; placeholder: boolean;
}

/** The latest sample of every metric that settings tie to this venture. Derived and sum metrics are left to the map. */
export async function ventureKpis(slug: string): Promise<Kpi[]> {
  const defs = metrics().filter((m) => m.venture === slug);
  if (!defs.length) return [];
  const { rows } = await query<{ metric: string; value: string; sampled_at: Date }>(
    `SELECT DISTINCT ON (metric) metric, value, sampled_at FROM metric_samples WHERE metric = ANY($1) ORDER BY metric, sampled_at DESC`,
    [defs.map((d) => d.key)],
  );
  const by = new Map(rows.map((r) => [r.metric, r]));
  return defs.map((d) => {
    const s = by.get(d.key);
    return {
      key: d.key, label: d.label, unit: d.unit, money: d.money, target: d.target ?? null,
      value: s ? Number(s.value) : null, sampled_at: s ? s.sampled_at.toISOString() : null, placeholder: d.placeholder,
    };
  });
}

export function renderKpis(name: string, kpis: Kpi[], now = new Date()): string {
  const rows = kpis.map((k) => {
    const val = k.value === null ? 'no data' : `${k.value.toLocaleString('en-US')}${k.unit === 'usd' ? ' USD' : ` ${k.unit}`}`;
    const tgt = k.target ? `${k.target.toLocaleString('en-US')}${k.unit === 'usd' ? ' USD' : ''}` : '-';
    return `| ${k.label} | ${val} | ${tgt} | ${k.sampled_at ? k.sampled_at.slice(0, 10) : '-'} |`;
  });
  return [
    `# ${name}: KPIs`,
    '',
    `Generated ${now.toISOString().slice(0, 10)} from the database. Do not edit by hand; \`cli-projects venture-kpis\` rewrites it.`,
    '',
    kpis.length
      ? ['| Metric | Latest | Target | Sampled |', '|---|---|---|---|', ...rows].join('\n')
      : 'No metrics are tied to this venture yet. Add `"venture": "<slug>"` to a metric in `secondbrain.json`.',
    '',
  ].join('\n');
}

/** Writes `<home>/kpis.md` for every venture that has a home, only when the numbers changed (the date line is ignored). */
export async function writeKpiFiles(vaultRoot: string, now = new Date()): Promise<string[]> {
  const wrote: string[] = [];
  const { rows } = await query<{ slug: string; name: string; home_path: string | null }>(`SELECT slug, name, home_path FROM ventures WHERE home_path IS NOT NULL`);
  for (const v of rows) {
    const dir = join(vaultRoot, checkHomePath(v.home_path!));
    if (!existsSync(dir)) continue;
    const text = renderKpis(v.name, await ventureKpis(v.slug), now);
    const file = join(dir, 'kpis.md');
    const strip = (t: string) => t.replace(/^Generated \d{4}-\d{2}-\d{2}/m, '');
    if (existsSync(file) && strip(readFileSync(file, 'utf8')) === strip(text)) continue;
    writeFileSync(file, text);
    wrote.push(relative(vaultRoot, file));
  }
  return wrote;
}

// ---------------------------------------------------------------- scaffold

export function readmeTemplate(v: { slug: string; name: string; kind: string; summary: string | null; parent: string | null }): string {
  return [
    `# ${v.name}`,
    v.summary ? `### ${v.summary}` : '### One line on what this is',
    '',
    `**Venture:** ${v.slug} · **Kind:** ${v.kind}${v.parent ? ` · **Part of:** [[${v.parent}]]` : ''}`,
    '',
    '---',
    '',
    '## What it is',
    '',
    '## Goals',
    '',
    '## Links',
    '',
    '## Where things are',
    '',
    '- `brand/`: brand.md (tokens and voice), logo/, fonts/, images/',
    '- `kpis.md`: generated, do not edit',
    '- `docs/`: design, research, strategy',
    '',
  ].join('\n');
}

export const BRAND_TEMPLATE = (name: string, slug: string) => `---
venture: ${slug}
# Plain keys; the engine reads whatever is here and requires none. Examples:
# palette: { ink: "#0b0b12", accent: "#7c5cff" }
# fonts: { heading: "Space Grotesk", body: "Inter" }
# voice: direct, specific
---

# ${name}: brand

Voice, usage rules and do/don't notes go here.
`;

/**
 * Creates the venture's folder from the template: README.md and an empty
 * brand/ with a brand.md. Existing files are never overwritten.
 */
export async function scaffoldVenture(vaultRoot: string, slug: string): Promise<{ created: string[]; skipped: string[] }> {
  const { rows } = await query<VentureRow>(`SELECT * FROM ventures WHERE slug = $1`, [slug]);
  const v = rows[0];
  if (!v) throw new TrackerError(`no venture "${slug}"`, 404);
  if (!v.home_path) throw new TrackerError(`venture "${slug}" has no home_path; set one first`);
  const home = checkHomePath(v.home_path);
  const files: [string, string][] = [
    [join(home, 'README.md'), readmeTemplate({ slug, name: v.name, kind: v.kind, summary: v.summary, parent: v.parent_slug })],
    [join(home, 'brand', 'brand.md'), BRAND_TEMPLATE(v.name, slug)],
  ];
  const created: string[] = [];
  const skipped: string[] = [];
  for (const [rel, text] of files) {
    const abs = join(vaultRoot, rel);
    if (existsSync(abs)) { skipped.push(rel); continue; }
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text);
    created.push(rel);
  }
  return { created, skipped };
}
