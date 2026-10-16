import type { MetricDef } from '../metrics/registry.js';
import type { Goal } from '../projects.js';

/**
 * The brain map's graph, before layout: rows in, nodes and edges out. Pure, so
 * the shape is tested without a database.
 *
 * Mission -> goals and divisions -> projects -> features, notes hanging off
 * the nearest project or division by folder, metrics next to the goal (or
 * division) they move.
 */

export type NodeKind = 'mission' | 'goal' | 'division' | 'project' | 'feature' | 'note' | 'metric';
export type EdgeKind = 'link' | 'belongs' | 'goal';

export interface MapNode {
  id: string;
  kind: NodeKind;
  label: string;
  ref: string | null;
  parent: string | null;
  colorKey: string | null;
  size: number;
  meta: Record<string, unknown>;
}

export interface MapEdge {
  source: string;
  target: string;
  kind: EdgeKind;
}

export interface NoteRow { id: number; path: string; title: string | null; mtime: string }
export interface LinkRow { from: number; to: number }
export interface DivisionRow { slug: string; name: string }
export interface ProjectRow {
  slug: string; title: string; division_slug: string | null; stage: string;
  goals: string[]; paths: string[]; design_path: string | null; devlog_path: string | null;
}
export interface FeatureRow { id: number; project_slug: string; title: string; stage: string }

export interface GraphInput {
  notes: NoteRow[];
  links: LinkRow[];
  divisions: DivisionRow[];
  projects: ProjectRow[];
  features: FeatureRow[];
  goals: Goal[];
  /** Extra folder -> division hints for notes outside any project folder. */
  divisionFolders: Record<string, string[]>;
  missionFolders: string[];
  /** The metrics to hang off their goal or division (secondbrain.json). */
  metrics: readonly MetricDef[];
  /** The note the mission node opens, if any. */
  missionFile?: string | null;
}

export interface Graph { nodes: MapNode[]; edges: MapEdge[] }

const dirOf = (p: string): string => p.split('/').slice(0, -1).join('/');
const under = (path: string, folder: string): boolean => path === folder || path.startsWith(`${folder}/`);

/** Goals on the map: the year, the quarter, and whatever this week and month still has open. */
export function mapGoals(goals: Goal[]): Goal[] {
  return goals.filter((g) => {
    if (g.code.startsWith('T')) return false;
    if (g.code.startsWith('Y') || g.code.startsWith('Q')) return true;
    return !/^(done|cancelled)/i.test(g.status);
  });
}

/**
 * The folders a project owns: its `paths` (folders, or a file's folder) and
 * the folder of its design doc. A dev log living in another project's folder
 * (claude-code-droplet's points into argo-exo) is not ownership, so it's left out.
 */
export function projectFolders(p: ProjectRow): string[] {
  const out = new Set<string>();
  for (const raw of p.paths) out.add(raw.endsWith('.md') ? dirOf(raw) : raw.replace(/\/+$/, ''));
  if (p.design_path) out.add(dirOf(p.design_path));
  // A folder at bucket depth (`Projects`, `Areas`) would swallow everything.
  return [...out].filter((f) => f.split('/').length >= 2);
}

/**
 * The anchor a note hangs off: the project whose folder is the longest match,
 * or the division when two projects tie on the same folder (argo-exo holds
 * both exo-capture and exo-software), then the division folder hints, then
 * the mission folders. Null: the note floats in the outer cloud.
 */
export function noteAnchor(path: string, input: GraphInput, owners: { folder: string; project: ProjectRow }[]): string | null {
  let best: { folder: string; projects: ProjectRow[] } | null = null;
  for (const o of owners) {
    if (!under(path, o.folder)) continue;
    if (!best || o.folder.length > best.folder.length) best = { folder: o.folder, projects: [o.project] };
    else if (o.folder.length === best.folder.length) best.projects.push(o.project);
  }
  if (best) {
    if (best.projects.length === 1) return `project:${best.projects[0]!.slug}`;
    const div = best.projects[0]!.division_slug;
    if (div && best.projects.every((p) => p.division_slug === div)) return `division:${div}`;
    return `project:${best.projects[0]!.slug}`;
  }
  let bestDiv: { folder: string; slug: string } | null = null;
  for (const [slug, folders] of Object.entries(input.divisionFolders)) {
    for (const f of folders) if (under(path, f) && (!bestDiv || f.length > bestDiv.folder.length)) bestDiv = { folder: f, slug };
  }
  if (bestDiv && input.divisions.some((d) => d.slug === bestDiv!.slug)) return `division:${bestDiv.slug}`;
  if (input.missionFolders.some((f) => under(path, f))) return 'mission';
  return null;
}

export function buildGraph(input: GraphInput): Graph {
  const nodes: MapNode[] = [];
  const edges: MapEdge[] = [];
  const ids = new Set<string>();
  const push = (n: MapNode) => { nodes.push(n); ids.add(n.id); };
  const edge = (source: string, target: string, kind: EdgeKind) => {
    if (ids.has(source) && ids.has(target) && source !== target) edges.push({ source, target, kind });
  };

  push({ id: 'mission', kind: 'mission', label: 'Mission', ref: input.missionFile ?? null, parent: null, colorKey: 'mission', size: 12, meta: {} });

  for (const g of mapGoals(input.goals)) {
    push({ id: `goal:${g.code}`, kind: 'goal', label: `${g.code} ${g.goal}`, ref: g.code, parent: 'mission', colorKey: g.code[0]!, size: g.code.startsWith('Y') ? 6 : 4,
      meta: { horizon: g.horizon, status: g.status, due: g.due } });
    edge(`goal:${g.code}`, 'mission', 'belongs');
  }

  for (const d of input.divisions) {
    push({ id: `division:${d.slug}`, kind: 'division', label: d.name, ref: d.slug, parent: 'mission', colorKey: d.slug, size: 8, meta: {} });
    edge(`division:${d.slug}`, 'mission', 'belongs');
  }

  const featureCount = new Map<string, number>();
  for (const f of input.features) featureCount.set(f.project_slug, (featureCount.get(f.project_slug) ?? 0) + 1);

  for (const p of input.projects) {
    const parent = p.division_slug && ids.has(`division:${p.division_slug}`) ? `division:${p.division_slug}` : 'mission';
    push({ id: `project:${p.slug}`, kind: 'project', label: p.title, ref: p.slug, parent, colorKey: p.division_slug, size: 3 + Math.min(4, (featureCount.get(p.slug) ?? 0) / 2),
      meta: { stage: p.stage, goals: p.goals, design: p.design_path, devlog: p.devlog_path } });
    edge(`project:${p.slug}`, parent, 'belongs');
    for (const code of p.goals) edge(`project:${p.slug}`, `goal:${code}`, 'goal');
  }

  const divisionOf = new Map(input.projects.map((p) => [p.slug, p.division_slug]));
  for (const f of input.features) {
    if (!ids.has(`project:${f.project_slug}`)) continue;
    push({ id: `feature:${f.id}`, kind: 'feature', label: f.title, ref: String(f.id), parent: `project:${f.project_slug}`, colorKey: f.stage, size: 1.5,
      meta: { stage: f.stage, project: f.project_slug } });
    edge(`feature:${f.id}`, `project:${f.project_slug}`, 'belongs');
  }

  const owners = input.projects.flatMap((project) => projectFolders(project).map((folder) => ({ folder, project })));
  const degree = new Map<number, number>();
  for (const l of input.links) {
    degree.set(l.from, (degree.get(l.from) ?? 0) + 1);
    degree.set(l.to, (degree.get(l.to) ?? 0) + 1);
  }
  for (const n of input.notes) {
    const anchor = noteAnchor(n.path, input, owners);
    const colorKey = anchor?.startsWith('project:')
      ? divisionOf.get(anchor.slice(8)) ?? null
      : anchor?.startsWith('division:') ? anchor.slice(9) : anchor === 'mission' ? 'mission' : null;
    push({ id: `note:${n.id}`, kind: 'note', label: n.title ?? n.path.split('/').pop()!.replace(/\.md$/, ''), ref: n.path, parent: anchor, colorKey,
      size: 1 + Math.min(4, Math.sqrt(degree.get(n.id) ?? 0)), meta: { mtime: n.mtime, folder: n.path.split('/')[0] } });
    if (anchor) edge(`note:${n.id}`, anchor, 'belongs');
  }
  for (const l of input.links) edge(`note:${l.from}`, `note:${l.to}`, 'link');

  for (const m of input.metrics) {
    const parent = [m.goal ? `goal:${m.goal}` : null, m.division ? `division:${m.division}` : null, 'mission'].find((x) => x && ids.has(x))!;
    push({ id: `metric:${m.key}`, kind: 'metric', label: m.label, ref: m.key, parent, colorKey: 'metric', size: 3,
      meta: { unit: m.unit, money: m.money, target: m.target ?? null, placeholder: m.placeholder } });
    edge(`metric:${m.key}`, parent, 'belongs');
  }

  return { nodes, edges };
}
