import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  AgentInfo, AgentSkillsResponse, AssignmentCell, Change, ChangePreview, ChangeRequest, Draft, FileResponse, LibraryResponse, MachinesResponse,
  MatrixResponse, PolicyStatus, SkillDetailResponse, SkillRow,
} from '@secondbrain/contracts/skills';
import { buildCatalog, distinctPackages, publicCandidate, rootSpecs, type Candidate, type Catalog } from './catalog.js';
import { git, gitTop, history, lastRevision, toPosix } from './git.js';
import * as life from './lifecycle.js';
import { loadedEvidence, machineStates, readAcks } from './machines.js';
import { isText, splitFrontmatter } from './package.js';
import { dependentsOf, lifecycleOf, loadPolicyFile, policyWarnings, resolveAgent, selectedCandidate, supportFor, type LoadedPolicy } from './policy.js';
import { loadRoster, type Roster } from './roster.js';

/**
 * The one application service behind `/api/skills` and `secondbrain skills`: catalog, policy, roster,
 * lifecycle and machine state. Reads are from the filesystem (cached briefly) and Git; the database
 * holds only machine acknowledgements and is optional (a client machine without it still catalogs,
 * resolves and syncs).
 */

export interface SkillsSettings {
  policyFile: string; privateRoot: string; legacyRoot: string | null; externalRoots: { id: string; path: string; label?: string }[];
  draftsDir: string; changesDir: string; managedRoot?: string; staleAfterHours: number;
}

const here = dirname(fileURLToPath(import.meta.url));
/** The engine checkout's `skills/` (app/server/{src,dist}/addons/skills -> engine root). */
export const ENGINE_SKILLS = resolve(here, '..', '..', '..', '..', '..', 'skills');
export const DEFAULT_MANAGED_ROOT = '~/.local/share/secondbrain/skills';

export function expandPath(vaultRoot: string, p: string): string {
  const e = p === '~' ? homedir() : p.startsWith('~/') ? resolve(homedir(), p.slice(2)) : p;
  return isAbsolute(e) ? e : resolve(vaultRoot, e);
}

interface State { catalog: Catalog; policy: LoadedPolicy; roster: Roster; at: number }

const TTL_MS = 30_000;
const MAX_FILE_BYTES = 512 * 1024;

export class SkillsService {
  private state: State | null = null;
  private loading: Promise<State> | null = null;
  readonly policyPath: string;

  constructor(readonly vaultRoot: string, readonly settings: SkillsSettings, private readonly opts: { engineSkills?: string | null; git?: boolean; db?: boolean } = {}) {
    this.policyPath = expandPath(vaultRoot, settings.policyFile);
  }

  get managedRoot(): string { return expandPath(this.vaultRoot, this.settings.managedRoot ?? DEFAULT_MANAGED_ROOT); }

  private async load(): Promise<State> {
    const engine = this.opts.engineSkills === undefined ? (existsSync(ENGINE_SKILLS) ? ENGINE_SKILLS : null) : this.opts.engineSkills;
    const specs = rootSpecs(this.vaultRoot, engine, this.settings, (p) => expandPath(this.vaultRoot, p));
    const catalog = await buildCatalog(specs, { git: this.opts.git ?? true });
    const policy = loadPolicyFile(this.policyPath);
    const roster = loadRoster(this.vaultRoot);
    if (policy.valid && policy.exists) policy.warnings = policyWarnings(policy.policy, catalog, roster.agents.map((a) => a.name), roster.teams);
    return { catalog, policy, roster, at: Date.now() };
  }

  async current(refresh = false): Promise<State> {
    if (!refresh && this.state && Date.now() - this.state.at < TTL_MS) return this.state;
    if (!this.loading) this.loading = this.load().then((s) => { this.state = s; return s; }).finally(() => { this.loading = null; });
    return this.loading;
  }

  invalidate(): void { this.state = null; }

  private async policyStatus(p: LoadedPolicy): Promise<PolicyStatus> {
    let revision: string | null = null;
    let dirty: boolean | null = null;
    if (p.exists && (this.opts.git ?? true)) {
      const top = await gitTop(dirname(this.policyPath));
      if (top) {
        const rel = toPosix(relative(top, this.policyPath));
        revision = await lastRevision(top, rel);
        const st = await git(top, ['status', '--porcelain', '--', rel]);
        dirty = st === null ? null : st.trim() !== '';
      }
    }
    return { file: toPosix(this.settings.policyFile), exists: p.exists, valid: p.valid, errors: p.errors, warnings: p.warnings, digest: p.digest, revision, dirty };
  }

  private cellsFor(s: State): Map<string, Map<string, AssignmentCell>> {
    const out = new Map<string, Map<string, AssignmentCell>>();
    for (const a of s.roster.agents) out.set(a.name, resolveAgent(a, s.policy, s.catalog));
    return out;
  }

  private row(s: State, name: string, list: Candidate[], cells: Map<string, Map<string, AssignmentCell>>): SkillRow {
    const eff = list[0] ?? null;
    let assigned = 0, denied = 0, references = 0;
    for (const m of cells.values()) {
      const c = m.get(name);
      if (!c) continue;
      if (c.state === 'assigned') assigned++;
      if (c.state === 'denied') denied++;
      if (c.reference) references++;
    }
    const distinct = distinctPackages(list);
    return {
      name, effective: eff ? publicCandidate(eff) : null, candidates: list.map(publicCandidate),
      flags: { override: eff?.source === 'private' && !eff.linkOf && distinct > 1, duplicate: distinct > 1, invalid: !!eff && !eff.valid, dirty: list.some((c) => c.dirty === true) },
      lifecycle: lifecycleOf(s.policy.policy, name), assigned, denied, references,
    };
  }

  async library(refresh = false): Promise<LibraryResponse> {
    const s = await this.current(refresh);
    const cells = this.cellsFor(s);
    const skills = [...s.catalog.byName.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([n, l]) => this.row(s, n, l, cells));
    return { mode: s.policy.mode, policy: await this.policyStatus(s.policy), roots: s.catalog.roots, skills, generatedAt: s.catalog.generatedAt };
  }

  private async loaded(): Promise<Map<string, { at: Date; host: string }>> {
    if (this.opts.db === false) return new Map();
    const rows = await loadedEvidence().catch(() => []);
    return new Map(rows.map((r) => [`${r.agent}\0${r.skill}`, { at: new Date(r.at), host: r.host }]));
  }

  private agentInfo(s: State, name: string, cells: Map<string, AssignmentCell>): AgentInfo {
    const a = s.roster.agents.find((x) => x.name === name)!;
    const sup = supportFor(a.runtime);
    const list = [...cells.values()];
    return { name, team: a.team, runtime: a.runtime, support: sup.level, supportNote: sup.note, assigned: list.filter((c) => c.state === 'assigned').length, references: list.filter((c) => c.reference).length };
  }

  async matrix(): Promise<MatrixResponse> {
    const s = await this.current();
    const all = this.cellsFor(s);
    const loaded = await this.loaded();
    const cells: AssignmentCell[] = [];
    for (const [agent, m] of all) {
      for (const c of m.values()) {
        const ev = loaded.get(`${agent}\0${c.skill}`);
        if (ev) c.loaded = { source: 'session summaries', at: ev.at.toISOString(), digest: null, detail: `a Skill tool call by ${agent} on ${ev.host}; the revision was not recorded` };
        const isDefault = (c.state === 'not-assigned' || c.state === 'legacy') && !c.reference && !c.loaded && !c.deprecated && c.reasons.every((r) => r.level === 'legacy');
        if (!isDefault) cells.push(c);
      }
    }
    return {
      mode: s.policy.mode, agents: s.roster.agents.map((a) => this.agentInfo(s, a.name, all.get(a.name)!)), skills: [...s.catalog.byName.keys()].sort(),
      cells, loadedSource: this.opts.db === false ? null : 'session summaries (Skill tool calls, names only)', rosterError: s.roster.error,
    };
  }

  async agent(name: string): Promise<AgentSkillsResponse | null> {
    const s = await this.current();
    const a = s.roster.agents.find((x) => x.name === name);
    if (!a) return null;
    const cells = resolveAgent(a, s.policy, s.catalog);
    const loaded = await this.loaded();
    for (const c of cells.values()) {
      const ev = loaded.get(`${name}\0${c.skill}`);
      if (ev) c.loaded = { source: 'session summaries', at: ev.at.toISOString(), digest: null, detail: `a Skill tool call on ${ev.host}; the revision was not recorded` };
    }
    const sup = supportFor(a.runtime);
    const notes = [sup.note, 'Skill availability never grants tool, credential or publishing authority; those stay with the org config and the guard.'];
    if (s.policy.mode === 'legacy') notes.unshift('No managed policy: this agent\'s runtime discovers every skill in its folders, as before.');
    return { agent: this.agentInfo(s, name, cells), mode: s.policy.mode, cells: [...cells.values()].sort((x, y) => (x.skill < y.skill ? -1 : 1)), notes };
  }

  private candidate(s: State, name: string, id?: string): Candidate | null {
    const list = s.catalog.byName.get(name) ?? [];
    if (id) return list.find((c) => c.id === id) ?? null;
    return selectedCandidate(s.policy.policy, s.catalog, name).candidate ?? list[0] ?? null;
  }

  async detail(name: string, id?: string): Promise<SkillDetailResponse | null> {
    const s = await this.current();
    const list = s.catalog.byName.get(name);
    if (!list) return null;
    const sel = this.candidate(s, name, id);
    if (id && !sel) return null;
    let instructions = '';
    if (sel) { try { instructions = splitFrontmatter(readFileSync(sel.packageFiles.find((f) => f.path === 'SKILL.md')?.abs ?? `${sel.dir}/SKILL.md`, 'utf8').slice(0, 200_000)).body; } catch { instructions = ''; } }
    const files = sel ? sel.packageFiles.map((f) => {
      let kind: 'text' | 'binary' = 'binary';
      try { kind = isText(readFileSync(f.abs).subarray(0, 8192)) ? 'text' : 'binary'; } catch { /* binary */ }
      return { path: f.path, size: f.size, exec: f.exec, sha256: f.sha256, kind };
    }) : [];
    const hist = sel?.gitTop && sel.gitRel ? await history(sel.gitTop, sel.gitRel) : [];
    const cells = this.cellsFor(s);
    const loaded = await this.loaded();
    const agents = [...cells.entries()].map(([agent, m]) => {
      const c = m.get(name) ?? { agent, skill: name, state: s.policy.mode === 'legacy' ? 'legacy' as const : 'not-assigned' as const, reasons: [], reference: false, deprecated: false, loaded: null };
      const ev = loaded.get(`${agent}\0${name}`);
      if (ev) c.loaded = { source: 'session summaries', at: ev.at.toISOString(), digest: null, detail: `a Skill tool call on ${ev.host}; the revision was not recorded` };
      return c;
    });
    const hosts: SkillDetailResponse['hosts'] = [];
    if (this.opts.db !== false) {
      const data = await readAcks().catch(() => null);
      const desired = s.policy.mode === 'managed' ? selectedCandidate(s.policy.policy, s.catalog, name).candidate?.digest ?? null : null;
      for (const a of data?.acks ?? []) {
        const o = a.skills.find((x) => x.name === name);
        const assigned = cells.get(a.agent)?.get(name)?.state === 'assigned';
        if (!o && !assigned) continue;
        const state = s.policy.mode !== 'managed' ? 'unknown' as const : o && assigned ? (o.digest === desired ? 'match' as const : 'drift' as const) : o ? 'extra' as const : 'missing' as const;
        hosts.push({ host: a.host, agent: a.agent, runtime: a.runtime, observed: o?.digest ?? null, state, receivedAt: new Date(a.received_at).toISOString() });
      }
    }
    const ctx = await this.lifecycleContext();
    const drafts = life.listDrafts(ctx).filter((d) => d.name === name || (d.base && list.some((c) => c.id === d.base!.id)));
    const changes = life.listChanges(ctx).filter((c) => c.skill === name);
    return {
      name, row: this.row(s, name, list, cells), selected: sel ? publicCandidate(sel) : null, instructions, files, history: hist, agents,
      dependents: dependentsOf(s.catalog, name), hosts, drafts, changes, mode: s.policy.mode,
    };
  }

  async file(name: string, id: string | undefined, path: string): Promise<FileResponse | null> {
    const s = await this.current();
    const c = this.candidate(s, name, id);
    // Only paths the bounded, link-checked scan listed are served; anything else is a 404.
    const f = c?.packageFiles.find((x) => x.path === path);
    if (!c || !f) return null;
    const buf = readFileSync(f.abs);
    if (createHash('sha256').update(buf).digest('hex') !== f.sha256) this.invalidate(); // changed on disk since the scan; serve what is there now
    const text = isText(buf);
    return { id: c.id, path, size: buf.length, kind: text ? 'text' : 'binary', content: text ? buf.subarray(0, MAX_FILE_BYTES).toString('utf8') : null, truncated: text && buf.length > MAX_FILE_BYTES };
  }

  async machines(): Promise<MachinesResponse> {
    const s = await this.current();
    const notes = [
      'A host appears here only from its own acknowledgement (`secondbrain skills sync --ack`). A Git push or merge is not a sync.',
      'Hosts that never acknowledged are unknown, and an offline host keeps its last deployment: revocation reaches it only when it syncs again.',
    ];
    if (s.policy.mode === 'legacy') notes.unshift('The policy is in legacy mode, so nothing is desired: observed digests are shown without a target.');
    if (this.opts.db === false) return { staleAfterHours: this.settings.staleAfterHours, hosts: [], mode: s.policy.mode, notes: [...notes, 'No database on this machine.'] };
    const data = await readAcks();
    const desiredCache = new Map<string, Map<string, string> | null>();
    const desired = (agent: string) => {
      if (s.policy.mode !== 'managed' || !s.policy.valid) return null;
      if (!desiredCache.has(agent)) {
        const a = s.roster.agents.find((x) => x.name === agent);
        const m = new Map<string, string>();
        if (a) for (const c of resolveAgent(a, s.policy, s.catalog).values()) if (c.state === 'assigned') { const d = selectedCandidate(s.policy.policy, s.catalog, c.skill).candidate?.digest; if (d) m.set(c.skill, d); }
        desiredCache.set(agent, a ? m : null);
      }
      return desiredCache.get(agent)!;
    };
    return { staleAfterHours: this.settings.staleAfterHours, hosts: machineStates(data, desired, this.settings.staleAfterHours), mode: s.policy.mode, notes };
  }

  // ---- lifecycle ----

  async lifecycleContext(refresh = false): Promise<life.LifecycleContext> {
    const s = await this.current(refresh);
    let observed: life.LifecycleContext['observed'] = [];
    if (this.opts.db !== false) {
      const data = await readAcks().catch(() => null);
      observed = (data?.acks ?? []).map((a) => ({ host: a.host, agent: a.agent, runtime: a.runtime, skills: a.skills.map((x) => x.name) }));
    }
    return {
      vaultRoot: this.vaultRoot, policyFile: this.policyPath, policyRel: toPosix(relative(this.vaultRoot, this.policyPath)),
      draftsDir: expandPath(this.vaultRoot, this.settings.draftsDir), changesDir: expandPath(this.vaultRoot, this.settings.changesDir),
      privateRoot: expandPath(this.vaultRoot, this.settings.privateRoot), catalog: s.catalog, policy: s.policy, roster: s.roster, observed,
    };
  }

  async drafts(): Promise<Draft[]> { return life.listDrafts(await this.lifecycleContext()); }
  async draft(name: string): Promise<Draft> { return life.getDraft(await this.lifecycleContext(), name); }
  async createDraft(name: string, from?: string, description?: string): Promise<Draft> { return life.createDraft(await this.lifecycleContext(true), name, from, description); }
  async writeDraftFile(name: string, path: string, content: string, exec?: boolean): Promise<Draft> { return life.writeDraftFile(await this.lifecycleContext(), name, path, content, exec); }
  async readDraftFile(name: string, path: string) { return life.readDraftFile(await this.lifecycleContext(), name, path); }
  async deleteDraftFile(name: string, path: string): Promise<Draft> { return life.deleteDraftFile(await this.lifecycleContext(), name, path); }
  async deleteDraft(name: string): Promise<void> { life.deleteDraft(await this.lifecycleContext(), name); }
  async preview(req: ChangeRequest): Promise<ChangePreview> { return (await life.previewChange(await this.lifecycleContext(true), req)).preview; }
  async propose(req: ChangeRequest): Promise<Change> { return life.proposeChange(await this.lifecycleContext(true), req); }
  async changes(): Promise<Change[]> { return life.listChanges(await this.lifecycleContext()); }
  async apply(id: string) { const r = await life.applyChange(await this.lifecycleContext(true), id); this.invalidate(); return r; }
}
