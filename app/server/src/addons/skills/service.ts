import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
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
import { query } from '../../db.js';
import { loadedEvidence, machineStates, readAcks } from './machines.js';
import { isText, LIMITS, packageFileAllowed, splitFrontmatter } from './package.js';
import { dependentsOf, lifecycleOf, loadPolicyFile, policyWarnings, resolveAgent, selectedCandidate, supportFor, unresolvedAssignments, type LoadedPolicy } from './policy.js';
import { loadRoster, type Roster } from './roster.js';
import { acceptedPolicyReview, cleanTrackedRoster, markPolicyReviewed, matchesApproval, policySnapshot, PolicyReviewError, type PolicyApprovalProvider, type PolicyProvenance } from './policy-review.js';

/**
 * The one application service behind `/api/skills` and `secondbrain skills`: catalog, policy, roster,
 * lifecycle and machine state. Reads are from the filesystem (cached briefly) and Git; the database
 * holds only machine acknowledgements and is optional (a client machine without it still catalogs,
 * resolves and syncs).
 */

export interface SkillsSettings {
  /** Operator-owned trust anchor; flags, environment and bundles cannot supply it. */
  authorityOrigin?: string | null;
  policyFile: string; privateRoot: string; legacyRoot: string | null; externalRoots: { id: string; path: string; label?: string }[];
  draftsDir: string; changesDir: string; managedRoot?: string; staleAfterHours: number;
}

const here = dirname(fileURLToPath(import.meta.url));
/** The engine checkout's `skills/` (app/server/{src,dist}/addons/skills -> engine root). */
export const ENGINE_SKILLS = resolve(here, '..', '..', '..', '..', '..', 'skills');
/** Source checkouts carry skills beside app/. App-only deployments use this vault's pinned engine. */
export function defaultEngineSkills(vaultRoot: string, checkoutCandidate = ENGINE_SKILLS): string | null {
  const regularDirectory = (path: string): boolean => {
    try { const st = lstatSync(path); return st.isDirectory() && !st.isSymbolicLink(); } catch { return false; }
  };
  if (regularDirectory(checkoutCandidate)) return checkoutCandidate;
  const root = resolve(vaultRoot), pinned = resolve(root, '.secondbrain'), skills = resolve(pinned, 'skills');
  return [root, pinned, skills].every(regularDirectory) ? skills : null;
}
export const DEFAULT_MANAGED_ROOT = '~/.local/share/secondbrain/skills';

export function expandPath(vaultRoot: string, p: string): string {
  const e = p === '~' ? homedir() : p.startsWith('~/') ? resolve(homedir(), p.slice(2)) : p;
  return isAbsolute(e) ? e : resolve(vaultRoot, e);
}

interface State { catalog: Catalog; policy: LoadedPolicy; roster: Roster; at: number }
type AckData = Awaited<ReturnType<typeof readAcks>>;

const TTL_MS = 30_000;
const MAX_FILE_BYTES = 512 * 1024;

/** Only accepted, merged jobs with verdicts bound to the exact repository and reviewed head qualify. */
async function acceptedReviewReceipts(repo: string): Promise<life.ReviewReceipt[]> {
  const result = await query<life.ReviewReceipt>(`SELECT snapshot->>'repo' AS repo, snapshot->>'base' AS base, verdict->>'head' AS head, merged, snapshot->>'branch' AS branch
    FROM review_jobs WHERE lower(snapshot->>'repo')=$1 AND verdict->>'repo'=snapshot->>'repo'
      AND verdict->>'decision'='accept' AND verdict->>'head'=snapshot->>'head' AND verdict->>'base'=snapshot->>'base'
      AND verdict->>'reviewer'=reviewer AND reviewer<>builder AND merged IS NOT NULL
      AND state IN ('merged','deploying','deployed','done')`, [repo]);
  return result.rows;
}

export class SkillsService {
  private state: State | null = null;
  private loading: Promise<State> | null = null;
  readonly policyPath: string;

  constructor(readonly vaultRoot: string, readonly settings: SkillsSettings, private readonly opts: { engineSkills?: string | null; git?: boolean; db?: boolean; observations?: typeof readAcks; reviewReceipts?: life.ReviewReceiptProvider; policyApprovals?: PolicyApprovalProvider } = {}) {
    this.policyPath = expandPath(vaultRoot, settings.policyFile);
  }

  get managedRoot(): string { return expandPath(this.vaultRoot, this.settings.managedRoot ?? DEFAULT_MANAGED_ROOT); }

  private async load(): Promise<State> {
    const engine = this.opts.engineSkills === undefined ? defaultEngineSkills(this.vaultRoot) : this.opts.engineSkills;
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

  private approvalProvider(): PolicyApprovalProvider {
    if (this.opts.policyApprovals) return this.opts.policyApprovals;
    if (this.opts.db === false) throw new PolicyReviewError('Policy approval records require the operational database.', 503);
    return {
      read: async (repo, path, revision, digest) => (await query<PolicyProvenance>(`SELECT repo, path, revision, digest, source, approved_by AS "approvedBy" FROM skill_policy_approvals WHERE repo=$1 AND path=$2 ORDER BY approved_at DESC, id DESC LIMIT 1`, [repo, path])).rows,
      write: async receipt => { await query(`INSERT INTO skill_policy_approvals (repo,path,revision,digest,source,approved_by) VALUES ($1,$2,$3,$4,$5,$6)`, [receipt.repo, receipt.path, receipt.revision, receipt.digest, receipt.source, receipt.approvedBy]); },
    };
  }

  private async authorizePolicy(policy: LoadedPolicy): Promise<PolicyProvenance> {
    if (this.opts.git === false) throw new PolicyReviewError('Git provenance is disabled; managed policy approval is unavailable.');
    const snapshot = await policySnapshot(this.vaultRoot, this.policyPath, policy);
    let latest: PolicyProvenance | null;
    try {
      const approvals = await this.approvalProvider().read(snapshot.repo, snapshot.path, snapshot.revision, snapshot.digest);
      if (approvals.length > 1) throw new Error('Approval provider must return only the latest receipt per policy path.');
      latest = approvals[0] ?? null;
    } catch (err) { throw new PolicyReviewError(`Policy approval evidence is unavailable: ${(err as Error).message}`, 503); }
    let receipt = latest && matchesApproval(snapshot, latest) ? latest : null;
    const reviews = this.opts.reviewReceipts ?? (this.opts.db === false ? async () => [] : acceptedReviewReceipts);
    if (!receipt) {
      // A reviewed successor may supersede an owner receipt. An older review cannot resurrect it
      // after a branch rewind; the owner must approve that new snapshot explicitly.
      const successor = !latest || latest.repo === snapshot.repo && latest.path === snapshot.path && /^[0-9a-f]{40,64}$/.test(latest.revision) &&
        (await git(snapshot.top, ['merge-base', '--is-ancestor', latest.revision, snapshot.revision])) !== null;
      if (successor) {
        try { receipt = await acceptedPolicyReview(snapshot, await reviews(snapshot.repo)); }
        catch (err) { throw new PolicyReviewError(`Accepted policy review evidence is unavailable: ${(err as Error).message}`, 503); }
      }
    }
    if (!receipt) throw new PolicyReviewError('This committed skills policy has no current accepted review or explicit owner approval for its exact repository, path, revision and digest; older approvals cannot authorize a superseded policy.');
    markPolicyReviewed(policy, receipt);
    return receipt;
  }

  /** Fresh state authorized for managed planning. Ordinary inspection never grants authorization. */
  async reviewedPolicy(): Promise<State> {
    const state = await this.current(true);
    if (state.roster.error) throw new PolicyReviewError(`Roster authorization sources are invalid: ${state.roster.error}`);
    const rosterDigest = await cleanTrackedRoster(this.vaultRoot);
    if (!state.roster.sourceDigest || state.roster.sourceDigest !== rosterDigest) throw new PolicyReviewError('Roster authorization sources changed while loading; rescan and retry without local edits.');
    await this.authorizePolicy(state.policy);
    return state;
  }

  /** Called only through an authenticated owner operation; stores metadata, never policy source. */
  async approvePolicy(input: { digest: string; revision: string; source: string; approvedBy: string }): Promise<PolicyProvenance> {
    if (!input.source?.trim() || input.source.length > 200 || !input.approvedBy?.trim() || input.approvedBy.length > 100) throw new PolicyReviewError('Owner approval needs a source (at most 200 characters) and an approving identity (at most 100).', 422);
    if (this.opts.git === false) throw new PolicyReviewError('Git provenance is disabled; policy approval refused.');
    const state = await this.current(true), snapshot = await policySnapshot(this.vaultRoot, this.policyPath, state.policy);
    if (input.digest !== snapshot.digest || input.revision !== snapshot.revision) throw new PolicyReviewError('Policy changed since approval was requested; inspect the current committed digest and revision and approve those exact values.');
    const receipt = { repo: snapshot.repo, path: snapshot.path, revision: snapshot.revision, digest: snapshot.digest, source: input.source.trim(), approvedBy: input.approvedBy.trim() };
    try { await this.approvalProvider().write(receipt); }
    catch (err) { throw new PolicyReviewError(`Could not save owner policy approval: ${(err as Error).message}`, 503); }
    this.invalidate();
    return receipt;
  }

  private async policyStatus(p: LoadedPolicy): Promise<PolicyStatus> {
    let revision: string | null = null, dirty: boolean | null = null;
    if (p.exists && (this.opts.git ?? true)) {
      const top = await gitTop(dirname(this.policyPath));
      if (top) {
        let path = this.policyPath; try { path = realpathSync(path); } catch { /* Missing path remains unknown. */ }
        const rel = toPosix(relative(top, path)); revision = await lastRevision(top, rel);
        const st = await git(top, ['status', '--porcelain', '--', rel]); dirty = st === null ? null : st.trim() !== '';
      }
    }
    let approval: PolicyProvenance | null = null, reviewError: string | null = null;
    if (p.mode === 'managed' && p.exists && p.valid) {
      // Inspect an independent parsed object: displaying approval must not mark the catalog state used by a caller.
      try { approval = await this.authorizePolicy({ ...p, policy: structuredClone(p.policy) }); }
      catch (err) { reviewError = (err as Error).message; }
    }
    return { file: toPosix(this.settings.policyFile), exists: p.exists, valid: p.valid, errors: p.errors, warnings: p.warnings, digest: p.digest, revision, dirty,
      reviewed: approval !== null, reviewError, approval };
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
    const md = sel ? await this.file(name, sel.id, 'SKILL.md') : null;
    if (md?.kind === 'text') instructions = splitFrontmatter(md.content ?? '').body;
    const files = sel ? await Promise.all(sel.packageFiles.map(async (f) => {
      const inspected = await this.file(name, sel.id, f.path);
      return { path: f.path, size: f.size, exec: f.exec, sha256: f.sha256, kind: inspected?.kind ?? 'binary' as const };
    })) : [];
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
    if (this.opts.db !== false || this.opts.observations) {
      const data = await this.observations();
      for (const host of data ? this.evaluateMachines(s, data) : []) for (const view of host.views) {
        const observed = view.skills.find((x) => x.name === name);
        if (!observed) continue;
        // A matching package is not a current deployment when the view is failed, stale, dirty or on an older policy.
        const state = view.status === 'current' ? observed.state : view.status === 'drift' ? 'drift' as const : 'unknown' as const;
        hosts.push({ host: host.host, agent: view.agent, runtime: view.runtime, observed: observed.observed, state,
          viewStatus: view.status, receivedAt: view.receivedAt });
      }
    }
    const ctx = await this.lifecycleContext();
    const drafts = life.listDrafts(ctx).filter((d) => d.name === name || (d.base && list.some((c) => c.id === d.base!.id)));
    const changes = (await life.listChanges(ctx)).filter((c) => c.skill === name);
    return {
      name, row: this.row(s, name, list, cells), selected: sel ? publicCandidate(sel) : null, instructions, files, history: hist, agents,
      dependents: dependentsOf(s.catalog, name, s.policy.policy), hosts, drafts, changes, mode: s.policy.mode,
    };
  }

  async file(name: string, id: string | undefined, path: string): Promise<FileResponse | null> {
    const s = await this.current();
    const c = this.candidate(s, name, id);
    // Only paths the bounded, link-checked scan listed are served; anything else is a 404.
    const f = c?.packageFiles.find((x) => x.path === path);
    if (!c || !f) return null;
    // Re-check at read time: a file swapped for a link since the scan must still resolve inside the package.
    let real: string;
    try { real = realpathSync(f.abs); } catch { this.invalidate(); return null; }
    if (!packageFileAllowed(c.dir, real)) { this.invalidate(); return null; }
    let buf: Buffer;
    try {
      const st = statSync(real);
      if (!st.isFile() || st.size > LIMITS.fileBytes) { this.invalidate(); return null; }
      buf = readFileSync(real);
    } catch { this.invalidate(); return null; }
    if (createHash('sha256').update(buf).digest('hex') !== f.sha256) {
      this.invalidate();
      throw new life.LifecycleError(409, 'The package changed since the catalog scan; rescan it before inspecting its files.');
    }
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
    if (this.opts.db === false && !this.opts.observations) return { staleAfterHours: this.settings.staleAfterHours, hosts: [], mode: s.policy.mode, notes: [...notes, 'No database on this machine.'] };
    const data = (await this.observations(true))!;
    return { staleAfterHours: this.settings.staleAfterHours, hosts: this.evaluateMachines(s, data), mode: s.policy.mode, notes };
  }

  /** Both machine and detail views use exactly the same policy/status/age evaluation. */
  private evaluateMachines(s: State, data: AckData): MachinesResponse['hosts'] {
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
    const unresolved = (agent: string) => {
      if (s.policy.mode !== 'managed') return [];
      const a = s.roster.agents.find(x => x.name === agent);
      return a ? unresolvedAssignments(resolveAgent(a, s.policy, s.catalog).values()) : [];
    };
    return machineStates(data, desired, this.settings.staleAfterHours, new Date(), s.policy.digest, unresolved);
  }

  /** Removal must never turn an unavailable operational read into an empty deployment list. */
  private async observations(required = false): Promise<AckData | null> {
    if (this.opts.db === false && !this.opts.observations) {
      if (required) throw new life.LifecycleError(503, 'Machine acknowledgement state is unavailable; removal requires a database connection.');
      return null;
    }
    try { return await (this.opts.observations ?? readAcks)(); }
    catch {
      if (required) throw new life.LifecycleError(503, 'Machine acknowledgement state could not be read; removal is refused until the database is available.');
      return null;
    }
  }

  // ---- lifecycle ----

  async lifecycleContext(refresh = false, requireObservations = false): Promise<life.LifecycleContext> {
    const s = await this.current(refresh);
    let observed: life.LifecycleContext['observed'] = [];
    const data = await this.observations(requireObservations);
    observed = (data?.acks ?? []).map((a) => ({ host: a.host, agent: a.agent, runtime: a.runtime, skills: a.skills.map((x) => x.name) }));
    return {
      vaultRoot: this.vaultRoot, policyFile: this.policyPath, policyRel: toPosix(relative(this.vaultRoot, this.policyPath)),
      draftsDir: expandPath(this.vaultRoot, this.settings.draftsDir), changesDir: expandPath(this.vaultRoot, this.settings.changesDir),
      reviewReceipts: this.opts.reviewReceipts ?? (this.opts.db === false ? undefined : acceptedReviewReceipts),
      privateRoot: expandPath(this.vaultRoot, this.settings.privateRoot), catalog: s.catalog, policy: s.policy, roster: s.roster, observed, observationsAvailable: data !== null,
    };
  }

  async drafts(): Promise<Draft[]> { return life.listDrafts(await this.lifecycleContext()); }
  async draft(name: string): Promise<Draft> { return life.getDraft(await this.lifecycleContext(), name); }
  async createDraft(name: string, from?: string, description?: string): Promise<Draft> { return life.createDraft(await this.lifecycleContext(true), name, from, description); }
  async writeDraftFile(name: string, path: string, content: string, exec?: boolean, expectedVersion?: string | null): Promise<Draft> { return life.writeDraftFile(await this.lifecycleContext(), name, path, content, exec, expectedVersion); }
  async readDraftFile(name: string, path: string) { return life.readDraftFile(await this.lifecycleContext(), name, path); }
  async deleteDraftFile(name: string, path: string, expectedVersion?: string): Promise<Draft> { return life.deleteDraftFile(await this.lifecycleContext(), name, path, expectedVersion); }
  async deleteDraft(name: string): Promise<void> { life.deleteDraft(await this.lifecycleContext(), name); }
  async preview(req: ChangeRequest): Promise<ChangePreview> { return (await life.previewChange(await this.lifecycleContext(true, req.kind === 'remove'), req)).preview; }
  async propose(req: ChangeRequest): Promise<Change> { return life.proposeChange(await this.lifecycleContext(true, req.kind === 'remove'), req); }
  async changes(): Promise<Change[]> { return life.listChanges(await this.lifecycleContext()); }
  async apply(id: string) {
    let ctx = await this.lifecycleContext(true);
    if ((await life.listChanges(ctx)).find(c => c.id === id)?.kind === 'remove') ctx = await this.lifecycleContext(false, true);
    const r = await life.applyChange(ctx, id); this.invalidate(); return r;
  }
}
