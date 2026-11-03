import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import matter from 'gray-matter';

/**
 * A shelf is an immediate subfolder of one of the garden roots (Projects/,
 * Areas/, Research/ by default). Its shelf note (README.md) carries a small
 * frontmatter header the gardener fills in and the owner overrides.
 */
export type ShelfKind = 'project' | 'area' | 'resource';
export type ShelfStatus = 'active' | 'dormant' | 'archived';

export interface ShelfMeta {
  shelf: string;
  status: ShelfStatus;
  project: string;
  kind: ShelfKind;
  last_reviewed: string;
  archive_after: string;
  pin: boolean;
}

export interface Shelf {
  dir: string;          // vault-relative folder, POSIX
  readme: string;       // vault-relative path of the shelf note
  exists: boolean;      // the shelf note was on disk
  meta: ShelfMeta;
  body: string;         // everything after the frontmatter
  foreign: Record<string, unknown>;   // frontmatter keys that are not ours, kept verbatim
}

export const SHELF_KEYS: (keyof ShelfMeta)[] = ['shelf', 'status', 'project', 'kind', 'last_reviewed', 'archive_after', 'pin'];
const STATUSES = new Set<ShelfStatus>(['active', 'dormant', 'archived']);
const KINDS = new Set<ShelfKind>(['project', 'area', 'resource']);

// Same skip rules as backlinks.collectNotes: a folder with its own .git is
// someone else's project and a vault pass has no business in it.
const SKIP_DIR_NAMES = new Set(['node_modules', '__pycache__', 'dist', 'build', 'venv']);

export function kindForRoot(root: string): ShelfKind {
  if (root === 'Projects') return 'project';
  if (root === 'Areas') return 'area';
  return 'resource';
}

export function defaultMeta(dir: string, kind: ShelfKind, today: string): ShelfMeta {
  return {
    shelf: dir,
    status: 'active',
    project: 'none',
    kind,
    last_reviewed: today,
    archive_after: kind === 'project' ? 'default' : 'never',
    pin: false,
  };
}

/** `dj-mixing-producing` → `Dj Mixing Producing`; used only for a shelf note the gardener creates. */
export function titleFor(dir: string): string {
  const name = dir.split('/').pop() ?? dir;
  return name.split(/[-_ ]+/).filter(Boolean).map((w) => w[0]!.toUpperCase() + w.slice(1)).join(' ');
}

function parseMeta(raw: Record<string, unknown>, dir: string, kind: ShelfKind, today: string): { meta: ShelfMeta; foreign: Record<string, unknown> } {
  const meta = defaultMeta(dir, kind, today);
  const foreign: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    switch (k) {
      case 'shelf': break;                                  // always rewritten from the real path
      case 'status': if (typeof v === 'string' && STATUSES.has(v as ShelfStatus)) meta.status = v as ShelfStatus; break;
      case 'project': if (typeof v === 'string' && v.trim()) meta.project = v.trim(); break;
      case 'kind': if (typeof v === 'string' && KINDS.has(v as ShelfKind)) meta.kind = v as ShelfKind; break;
      case 'last_reviewed': if (v instanceof Date) meta.last_reviewed = v.toISOString().slice(0, 10); else if (typeof v === 'string' && v) meta.last_reviewed = v; break;
      case 'archive_after': if (typeof v === 'string' && /^(\d+d|never|default)$/.test(v)) meta.archive_after = v; break;
      case 'pin': meta.pin = v === true; break;
      default: foreign[k] = v;
    }
  }
  return { meta, foreign };
}

async function isSkipped(abs: string, name: string): Promise<boolean> {
  if (name.startsWith('.') || SKIP_DIR_NAMES.has(name)) return true;
  try {
    const entries = await readdir(abs);
    return entries.includes('.git');
  } catch { return true; }
}

export async function discoverShelves(root: string, roots: string[], shelfFile: string, today: string): Promise<Shelf[]> {
  const shelves: Shelf[] = [];
  for (const r of roots) {
    let entries;
    try { entries = await readdir(join(root, r), { withFileTypes: true }); } catch { continue; }
    const kind = kindForRoot(r);
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!e.isDirectory() || e.isSymbolicLink()) continue;
      const abs = join(root, r, e.name);
      if (await isSkipped(abs, e.name)) continue;
      const dir = `${r}/${e.name}`;
      const readme = `${dir}/${shelfFile}`;
      let text: string | null = null;
      try { text = await readFile(join(root, readme), 'utf8'); } catch { /* no shelf note yet */ }
      if (text === null) {
        shelves.push({ dir, readme, exists: false, meta: defaultMeta(dir, kind, today), body: `# ${titleFor(dir)}\n`, foreign: {} });
        continue;
      }
      let parsed: { data: Record<string, unknown>; content: string };
      try { parsed = matter(text); } catch { parsed = { data: {}, content: text }; }
      const { meta, foreign } = parseMeta(parsed.data, dir, kind, today);
      shelves.push({ dir, readme, exists: true, meta, body: parsed.content.replace(/^\n+/, ''), foreign });
    }
  }
  return shelves;
}

function yamlValue(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (Array.isArray(v)) return `[${v.map((x) => yamlValue(x)).join(', ')}]`;
  if (typeof v === 'object') return JSON.stringify(v);
  const s = String(v);
  return /[:#\[\]{}"'|>&*!%@`,]|^\s|\s$/.test(s) || s === '' ? JSON.stringify(s) : s;
}

/**
 * Frontmatter is written by hand, one `key: value` per line, so foreign keys
 * keep their order and the shelf keys read the same in every note.
 */
export function serializeShelf(s: Shelf): string {
  const lines: string[] = ['---'];
  for (const [k, v] of Object.entries(s.foreign)) lines.push(`${k}: ${yamlValue(v)}`);
  for (const k of SHELF_KEYS) lines.push(`${k}: ${yamlValue(s.meta[k])}`);
  lines.push('---');
  const body = s.body.endsWith('\n') || s.body === '' ? s.body : `${s.body}\n`;
  return `${lines.join('\n')}\n${body}`;
}
