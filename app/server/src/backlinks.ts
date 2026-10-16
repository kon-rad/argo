import { execFileSync } from 'node:child_process';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { maskCode } from './connectors/vault/parse.js';
import { settings } from './settings.js';

/**
 * One-off (and re-runnable) link pass over the vault's markdown. Each note
 * gets a script-owned block at the end, between the two markers below, that
 * links it to its project's design doc and dev log, its folder's index note,
 * the previous and next note in a dated series, and the notes it already
 * mentions by path or full title. Text outside the markers is never changed;
 * a rerun replaces the block, and a note with nothing to link loses it.
 *
 * Rules only, no model: every link has a reason a reviewer can check.
 */

export const BLOCK_START = '<!-- related:start -->';
export const BLOCK_END = '<!-- related:end -->';
const BLOCK_RE = /\n*<!-- related:start -->[\s\S]*?<!-- related:end -->\n*/;

export interface Note {
  path: string;      // vault-relative, POSIX, with .md
  dir: string;       // '' at the root
  stem: string;      // file name without .md
  content: string;
}

export interface RelatedLink {
  target: string;    // vault-relative path of the target note
  reason: string;
}

/** Folders never descended into: tooling, other people's repos, generated trees. */
const SKIP_DIR_NAMES = new Set(['node_modules', '__pycache__', 'dist', 'build', 'venv']);
const SKIP_ROOT_PATHS = new Set(['app']);

/**
 * Notes the pass reads (as link targets and for mentions) but never writes:
 * archives, dev-log entries (old entries are never rewritten), generated
 * files, and agent instruction files.
 */
export function isWritable(path: string): boolean {
  if (path.startsWith('Archives/')) return false;
  const name = path.split('/').pop()!;
  if (/(^|\/)dev-log\//.test(path) && name !== 'README.md') return false;
  if (['AGENTS.md', 'AGENTS.local.md', 'CLAUDE.md', 'SKILL.md', 'MEMORY.md'].includes(name)) return false;
  if (path === settings().projects.reportFile) return false;
  return true;
}

/** Agent instruction and generated files: a link to them says nothing about a note. */
export function isNoiseTarget(path: string): boolean {
  const name = path.split('/').pop()!;
  return ['AGENTS.md', 'AGENTS.local.md', 'CLAUDE.md', 'SKILL.md', 'MEMORY.md'].includes(name)
    || path === settings().projects.reportFile;
}

/**
 * Paths git ignores (a robot's runtime memory, build output). They aren't the
 * vault's notes, and whatever writes them would overwrite the block anyway.
 * No git, or not a repo: nothing is filtered.
 */
export function gitIgnored(root: string, paths: string[]): Set<string> {
  if (paths.length === 0) return new Set();
  try {
    const out = execFileSync('git', ['-C', root, 'check-ignore', '--stdin'], {
      input: paths.join('\n'), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    });
    return new Set(out.split('\n').filter(Boolean));
  } catch (err) {
    // Exit 1 means "none ignored"; anything else (no git) also filters nothing.
    const stdout = (err as { stdout?: string }).stdout ?? '';
    return new Set(stdout.split('\n').filter(Boolean));
  }
}

/**
 * Markdown files under `root`. Skips dot-folders (.hermes, .agents, .git…)
 * and any folder holding its own `.git`: those are separate repos (the Argo
 * app, AI City, Areas/notes) and a vault pass has no business editing them.
 */
export async function collectNotes(root: string): Promise<Note[]> {
  const notes: Note[] = [];
  async function descend(abs: string, rel: string): Promise<void> {
    let entries;
    try { entries = await readdir(abs, { withFileTypes: true }); } catch { return; }
    if (rel && entries.some((e) => e.name === '.git')) return;
    for (const e of entries) {
      if (e.isSymbolicLink() || e.name.startsWith('.')) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (SKIP_DIR_NAMES.has(e.name) || SKIP_ROOT_PATHS.has(childRel)) continue;
        await descend(join(abs, e.name), childRel);
      } else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) {
        let content: string;
        try { content = await readFile(join(abs, e.name), 'utf8'); } catch { continue; }
        notes.push({ path: childRel, dir: rel, stem: e.name.slice(0, -3), content });
      }
    }
  }
  await descend(root, '');
  return notes;
}

export function stripBlock(content: string): string {
  return content.replace(BLOCK_RE, '\n').replace(/\n+$/, '\n');
}

const WIKILINK_RE = /!?\[\[([^\]\n|#^]+)/g;
const MD_PATH_RE = /(?:^|[\s`'"(\[])((?:[\w .@-]+\/)*[\w .@-]+\.md)\b/g;
const DATED_RE = /^\d{4}[.-]\d{2}[.-]\d{2}/;
const H1_RE = /^#\s+(.+?)\s*$/m;

export class VaultIndex {
  readonly byPath = new Map<string, Note>();
  private readonly byPathLower = new Map<string, Note>();
  private readonly stemCount = new Map<string, number>();
  private readonly byStem = new Map<string, Note>();
  private readonly byDir = new Map<string, Note[]>();
  /** Titles distinctive enough to count as a mention when they appear in prose. */
  readonly titles: { re: RegExp; note: Note }[] = [];

  constructor(notes: Note[]) {
    const titleCount = new Map<string, number>();
    const titleOf = new Map<Note, string>();
    for (const n of notes) {
      this.byPath.set(n.path, n);
      this.byPathLower.set(n.path.toLowerCase(), n);
      const s = n.stem.toLowerCase();
      this.stemCount.set(s, (this.stemCount.get(s) ?? 0) + 1);
      this.byStem.set(s, n);
      const list = this.byDir.get(n.dir) ?? [];
      list.push(n);
      this.byDir.set(n.dir, list);
      const t = H1_RE.exec(maskCode(n.content))?.[1]?.trim();
      if (t) {
        titleOf.set(n, t);
        titleCount.set(t.toLowerCase(), (titleCount.get(t.toLowerCase()) ?? 0) + 1);
      }
    }
    for (const [n, t] of titleOf) {
      // Three words and 15 characters: "Notes" or "Plan" would match everywhere.
      if (titleCount.get(t.toLowerCase()) !== 1) continue;
      if (t.length < 15 || t.split(/\s+/).length < 3) continue;
      const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      this.titles.push({ re: new RegExp(`(^|[^\\w])${escaped}($|[^\\w])`, 'i'), note: n });
    }
  }

  /** The shortest wikilink target that resolves to exactly this note. */
  linkText(path: string): string {
    const n = this.byPath.get(path)!;
    return this.stemCount.get(n.stem.toLowerCase()) === 1 ? n.stem : path.slice(0, -3);
  }

  /** Same order as the scanner's resolver: path, path + .md, unique stem. */
  resolve(raw: string, fromDir = ''): Note | undefined {
    const r = raw.trim().replace(/^\.\//, '');
    const candidates = [r, `${r}.md`];
    if (fromDir) candidates.push(`${fromDir}/${r}`, `${fromDir}/${r}.md`);
    for (const c of candidates) {
      const hit = this.byPathLower.get(c.toLowerCase());
      if (hit) return hit;
    }
    const stem = r.split('/').pop()!.replace(/\.md$/i, '').toLowerCase();
    return this.stemCount.get(stem) === 1 ? this.byStem.get(stem) : undefined;
  }

  inDir(dir: string): Note[] {
    return this.byDir.get(dir) ?? [];
  }
}

function ancestors(dir: string): string[] {
  const parts = dir ? dir.split('/') : [];
  const out: string[] = [];
  for (let i = parts.length; i >= 1; i--) out.push(parts.slice(0, i).join('/'));
  return out;
}

/** Wikilink targets already in the note's own text (outside the block). */
export function existingTargets(note: Note, body: string, idx: VaultIndex): Set<string> {
  const out = new Set<string>();
  for (const m of maskCode(body).matchAll(WIKILINK_RE)) {
    const hit = idx.resolve(m[1]!, note.dir);
    if (hit) out.add(hit.path);
  }
  return out;
}

const MAX_MENTIONS = 5;

export function computeRelated(note: Note, idx: VaultIndex): RelatedLink[] {
  const body = stripBlock(note.content);
  const already = existingTargets(note, body, idx);
  const out: RelatedLink[] = [];
  const seen = new Set<string>([note.path, ...already]);
  const add = (target: string | undefined, reason: string): boolean => {
    if (!target || seen.has(target) || isNoiseTarget(target)) return false;
    seen.add(target);
    out.push({ target, reason });
    return true;
  };

  // 1. Project: the nearest folder above (or at) the note that has a *-design.md.
  //    Stops below the PARA bucket so `Areas/` itself never counts.
  const chain = ancestors(note.dir).filter((d) => d.includes('/') || !['Areas', 'Projects', 'Research', 'Archives'].includes(d));
  for (const d of chain) {
    const design = idx.inDir(d).find((n) => n.stem.endsWith('-design'));
    if (!design) continue;
    add(design.path, 'design doc');
    add(idx.byPath.get(`${d}/dev-log/README.md`)?.path, 'dev log');
    break;
  }

  // 2. Folder index: the nearest README.md or <folder>.md, own folder first.
  for (const d of chain) {
    const folder = d.split('/').pop()!;
    const index = idx.byPath.get(`${d}/README.md`) ?? idx.byPath.get(`${d}/${folder}.md`);
    // A folder's own index links up to its parent's, so folders chain together.
    if (index && index.path !== note.path) { add(index.path, 'folder index'); break; }
  }

  // 3. Dated series (stand-ups, weekly notes): previous and next by name.
  if (DATED_RE.test(note.stem)) {
    const series = idx.inDir(note.dir).filter((n) => DATED_RE.test(n.stem)).sort((a, b) => a.stem.localeCompare(b.stem));
    const i = series.findIndex((n) => n.path === note.path);
    add(series[i - 1]?.path, 'previous');
    add(series[i + 1]?.path, 'next');
  }

  // 4. Mentions: a .md path written in the text, then a distinctive full title.
  let mentions = 0;
  const unfenced = maskFencesOnly(body);
  for (const m of unfenced.matchAll(MD_PATH_RE)) {
    if (mentions >= MAX_MENTIONS) break;
    const hit = idx.resolve(m[1]!, note.dir);
    if (hit && add(hit.path, 'mentioned')) mentions++;
  }
  const prose = maskCode(body);
  for (const { re, note: target } of idx.titles) {
    if (mentions >= MAX_MENTIONS) break;
    if (re.test(prose) && add(target.path, 'mentioned')) mentions++;
  }

  return out;
}

/** Blank fenced blocks but keep inline code: `Projects/x/x-design.md` is a real reference. */
function maskFencesOnly(src: string): string {
  let inFence: string | null = null;
  return src.split('\n').map((line) => {
    const m = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (m) {
      if (inFence === null) inFence = m[1]!;
      else if (m[1]![0] === inFence[0] && m[1]!.length >= inFence.length) inFence = null;
      return '';
    }
    return inFence === null ? line : '';
  }).join('\n');
}

export function renderBlock(links: RelatedLink[], idx: VaultIndex): string {
  const lines = links.map((l) => `- [[${idx.linkText(l.target)}]] - ${l.reason}`);
  return `${BLOCK_START}\n## Related\n${lines.join('\n')}\n${BLOCK_END}\n`;
}

/** New file content, or the same string when nothing changes. */
export function applyBlock(content: string, links: RelatedLink[], idx: VaultIndex): string {
  const base = stripBlock(content);
  if (links.length === 0) return BLOCK_RE.test(content) ? base : content;
  const next = `${base.replace(/\n*$/, '')}\n\n${renderBlock(links, idx)}`;
  return next === content ? content : next;
}

export interface BacklinkSummary {
  notes: number;
  writable: number;
  changed: number;
  linksAdded: number;
  orphansBefore: number;
  orphansAfter: number;
  changedPaths: string[];
}

/** Notes with no resolved wikilink in or out, before and after the pass. */
function countOrphans(notes: Note[], idx: VaultIndex, extra: Map<string, RelatedLink[]>): number {
  const touched = new Set<string>();
  for (const n of notes) {
    const targets = new Set(existingTargets(n, stripBlock(n.content), idx));
    for (const l of extra.get(n.path) ?? []) targets.add(l.target);
    targets.delete(n.path);
    if (targets.size > 0) touched.add(n.path);
    for (const t of targets) touched.add(t);
  }
  return notes.length - touched.size;
}

export async function runBacklinks(
  root: string,
  opts: { write: boolean; prefix?: string; skip?: Set<string> },
): Promise<BacklinkSummary> {
  const all = await collectNotes(root);
  const ignored = gitIgnored(root, all.map((n) => n.path));
  const notes = all.filter((n) => !ignored.has(n.path));
  const idx = new VaultIndex(notes);
  const related = new Map<string, RelatedLink[]>();
  const changedPaths: string[] = [];
  let writable = 0;
  let linksAdded = 0;

  for (const n of notes) {
    if (!isWritable(n.path) || opts.skip?.has(n.path) || (opts.prefix && !n.path.startsWith(opts.prefix))) continue;
    writable++;
    const links = computeRelated(n, idx);
    related.set(n.path, links);
    const next = applyBlock(n.content, links, idx);
    if (next === n.content) continue;
    changedPaths.push(n.path);
    linksAdded += links.length;
    if (opts.write) await writeFile(join(root, n.path), next, 'utf8');
  }

  return {
    notes: notes.length,
    writable,
    changed: changedPaths.length,
    linksAdded,
    orphansBefore: countOrphans(notes, idx, new Map()),
    orphansAfter: countOrphans(notes, idx, related),
    changedPaths,
  };
}
