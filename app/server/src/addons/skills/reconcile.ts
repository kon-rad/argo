import { createHash, randomBytes } from 'node:crypto';
import { accessSync, chmodSync, constants, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, rmdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { delimiter, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ACK_LIMITS, AckRequestSchema } from '@secondbrain/contracts/skills';
import type { AckRequest, AckView, Requirement, SkillRuntime } from '@secondbrain/contracts/skills';
import type { Catalog } from './catalog.js';
import { isIgnoredName, isSecretLike, LIMITS, NAME_RE, readMeta, scanPackage } from './package.js';
import { resolveAgent, selectedCandidate, supportFor, unresolvedAssignments, type LoadedPolicy } from './policy.js';
import type { Roster } from './roster.js';
import { assertPolicyReviewed } from './policy-review.js';

/**
 * Machine reconciliation: resolve the approved skills per agent and runtime, stage the exact packages
 * into a content-addressed store under a managed root, verify every full digest, and switch each
 * agent's generated view with one atomic rename. A failure at any step leaves the previous view
 * active. Only the managed root is written; source packages and unmanaged installs are never touched.
 *
 *   <root>/store/<hex>/                    one package per full digest, read-only
 *   <root>/views/<agent>/<runtime>         symlink -> <runtime>.<generation>
 *   <root>/views/<agent>/<runtime>.<gen>/  manifest.json + <name> -> ../../../store/<hex>
 *   <root>/quarantine/                     store folders found modified, moved aside by --repair
 *   <root>/state.json                      the last report (what `skills ack` sends)
 */

export const VIEW_FORMAT = 'secondbrain-skills-view/1';
export const ADAPTER_RUNTIMES: SkillRuntime[] = ['zen-agent', 'claude-code', 'hermes', 'codex'];

export interface PlannedSkill { name: string; id: string; digest: string; revision: string | null; dirty: boolean | null; description: string; depends?: string[]; requires: { bins: string[]; env: string[] } }
export interface PackageSource { files: { path: string; exec: boolean; read: () => Buffer }[] }
export interface ViewPlan { agent: string; runtime: SkillRuntime; skills: PlannedSkill[]; excluded: { name: string; reason: string }[] }
export interface Plan { policyDigest: string | null; views: ViewPlan[]; packages: Map<string, PackageSource> }

export class ReconcileError extends Error {}

// Approval is an in-process capability, never a boolean that a transport bundle can assert.
// The fingerprint binds every manifest field that can affect a runtime and every selected digest.
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const authorizedPlans = new WeakMap<Plan, { fingerprint: string; at: number }>();
const AUTHORIZATION_MAX_AGE_MS = 60_000;
export function planFingerprint(plan: Pick<Plan, 'policyDigest' | 'views'>): string {
  const views = plan.views.map(v => ({ agent: v.agent, runtime: v.runtime,
    skills: v.skills.map(s => ({ name: s.name, id: s.id, digest: s.digest, revision: s.revision,
      dirty: s.dirty, description: s.description, depends: [...(s.depends ?? [])].sort(),
      requires: { bins: [...s.requires.bins].sort(), env: [...s.requires.env].sort() } }))
      .sort((a, b) => compare(a.name, b.name)),
    excluded: [...(v.excluded ?? [])].map(e => ({ name: e.name, reason: e.reason }))
      .sort((a, b) => compare(a.name, b.name) || compare(a.reason, b.reason)),
  })).sort((a, b) => compare(a.agent, b.agent) || compare(a.runtime, b.runtime));
  return `sha256:${createHash('sha256').update(JSON.stringify({ policyDigest: plan.policyDigest, views })).digest('hex')}`;
}
function authorizePlan(plan: Plan): void { authorizedPlans.set(plan, { fingerprint: planFingerprint(plan), at: Date.now() }); }
function assertPlanAuthorized(plan: Plan): void {
  const proof = authorizedPlans.get(plan);
  if (!proof || proof.fingerprint !== planFingerprint(plan) || Date.now() - proof.at > AUTHORIZATION_MAX_AGE_MS)
    throw new ReconcileError('Managed plan has no current accepted policy review authorization, or was modified after authorization. Verify it with the server before packing or synchronizing; existing views are unchanged.');
}

/** Authenticate an untrusted local proposal/bundle against the server's clean, reviewed canonical plan.
 * A device token can request verification but cannot approve a policy. No receipt in a bundle is trusted.
 * An offline/unreachable server fails closed; already installed views remain available.
 */
export async function authorizeRemotePlan(plan: Plan, server: string, token: string, fetchFn: typeof fetch = fetch): Promise<void> {
  authorizedPlans.delete(plan);
  planCapacity(plan);
  let base: URL;
  try { base = new URL(server); } catch { throw new ReconcileError('A valid HTTPS skills server is required for policy review authorization'); }
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || (base.pathname !== '/' && base.pathname !== ''))
    throw new ReconcileError('Policy review authorization requires an HTTPS server origin without credentials, a path, query or fragment');
  if (!token || /[\r\n]/.test(token)) throw new ReconcileError('A live device token is required for policy review authorization');
  const fingerprint = planFingerprint(plan);
  let response: Response;
  try {
    response = await fetchFn(new URL('/api/skills/authorize', base), { method: 'POST', redirect: 'error', credentials: 'omit',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ policyDigest: plan.policyDigest, fingerprint, views: plan.views.map(({ agent, runtime }) => ({ agent, runtime })) }),
      signal: AbortSignal.timeout(30_000) });
  } catch { throw new ReconcileError('Skills policy authorization server is unavailable; nothing deployed, existing views are unchanged'); }
  if (!response.ok) throw new ReconcileError(`Skills policy review authorization refused (HTTP ${response.status}); nothing deployed, existing views are unchanged`);
  // The tiny response has no package content. Refuse oversized or malformed protocol responses.
  const body = await response.text();
  if (body.length > 1024) throw new ReconcileError('Invalid skills policy authorization response');
  let accepted: { policyDigest?: unknown; fingerprint?: unknown };
  try { accepted = JSON.parse(body) as typeof accepted; } catch { throw new ReconcileError('Invalid skills policy authorization response'); }
  if (!accepted || accepted.policyDigest !== plan.policyDigest || accepted.fingerprint !== fingerprint || planFingerprint(plan) !== fingerprint)
    throw new ReconcileError('Skills policy authorization does not match this exact plan; nothing deployed, existing views are unchanged');
  authorizePlan(plan);
}

const hex = (digest: string) => digest.slice('sha256:'.length);
const dirtyNames = (names: string[]) => [...new Set(names.filter(n => NAME_RE.test(n)))].slice(0, ACK_LIMITS.skillsPerView);

const present = (path: string): boolean => { try { lstatSync(path); return true; } catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false; throw err; } };
const inside = (root: string, path: string): boolean => { const rel = relative(root, path); return rel === '' || rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); };

/** Never traverse a link inside the explicitly selected root, including during cleanup. */
function managedDirectory(root: string, path: string, create = false): string | null {
  root = resolve(root); path = resolve(path);
  if (!inside(root, path)) throw new ReconcileError('managed directory leaves its root');
  if (!present(root)) { if (!create) return null; mkdirSync(root, { recursive: true, mode: 0o700 }); }
  const rootStat = lstatSync(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new ReconcileError('managed root is not a regular directory; refusing links or unmanaged files');
  const canonical = realpathSync(root);
  let current = root;
  for (const part of relative(root, path).split(sep).filter(Boolean)) {
    current = join(current, part);
    if (!present(current)) { if (!create) return null; mkdirSync(current, { mode: 0o700 }); }
    const st = lstatSync(current);
    if (st.isSymbolicLink() || !st.isDirectory() || !inside(canonical, realpathSync(current))) throw new ReconcileError(`managed directory is a link or unmanaged path: ${relative(root, current)}`);
  }
  return current;
}
function managedRoot(root: string, create = false): boolean {
  if (!managedDirectory(root, root, create)) return false;
  const dirs = new Set(['store', 'views', 'quarantine', '.staging']);
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    if (dirs.has(name)) managedDirectory(root, path);
    else if (name === 'state.json') {
      const st = lstatSync(path);
      if (st.isSymbolicLink() || !st.isFile()) throw new ReconcileError('managed state is not a regular manager file');
      try {
        if (st.size > BUNDLE_MAX_BYTES) throw new Error('oversized manager state');
        const report = JSON.parse(readFileSync(path, 'utf8')) as SyncReport;
        if (!report || typeof report.root !== 'string' || resolve(report.root) !== resolve(root) || !Array.isArray(report.views)
          || !Number.isFinite(Date.parse(report.at)) || (report.policyDigest !== null && !/^sha256:[0-9a-f]{64}$/.test(report.policyDigest))) throw new Error('unrecognized manager report');
        for (const view of report.views) if (!view || !NAME_RE.test(view.agent) || !ADAPTER_RUNTIMES.includes(view.runtime)
          || !['current', 'not-ready', 'dirty', 'failed'].includes(view.status) || !Array.isArray(view.skills) || !Array.isArray(view.missing) || !Array.isArray(view.dirty)) throw new Error('invalid manager view state');
      } catch { throw new ReconcileError('unmanaged state.json: not a recognized report for this managed root; refusing to replace it'); }
    } else throw new ReconcileError(`unmanaged entry in the skills root: ${name}`);
  }
  return true;
}
function removeManagedDirectory(root: string, path: string): void {
  if (!present(path)) return;
  managedDirectory(root, path);
  removeTree(path);
}
const generatedName = (runtime: string, name: string) => name.startsWith(`${runtime}.`) && /^\d{8}T\d{6}-[a-f0-9]{6}$/.test(name.slice(runtime.length + 1));

export function viewDigest(skills: { name: string; digest: string }[]): string {
  const h = createHash('sha256');
  for (const s of [...skills].sort((a, b) => (a.name < b.name ? -1 : 1))) h.update(`${s.name}\0${s.digest}\n`);
  return `sha256:${h.digest('hex')}`;
}

/** Reserve acknowledgement capacity before producing or activating a managed deployment. */
function plannedAck(view: ViewPlan): AckView {
  return { agent: view.agent, runtime: view.runtime, status: 'current', error: null,
    viewDigest: viewDigest(view.skills), generatedAt: new Date().toISOString(), excluded: view.excluded ?? [],
    skills: view.skills.map(({ name, id, digest }) => ({ name, id, digest })), dirty: [],
    // A destination may lack every declared prerequisite; its report must still fit.
    missing: view.skills.filter(skill => skill.requires.bins.length || skill.requires.env.length)
      .map(skill => ({ skill: skill.name, bins: skill.requires.bins, env: skill.requires.env })) };
}
function acknowledgementCapacity(views: AckView[], policyDigest: string | null, engine: string | null = 'x'.repeat(64)): void {
  if (views.length > ACK_LIMITS.views) throw new ReconcileError(`Cannot acknowledge ${views.length} views: the limit is ${ACK_LIMITS.views}. Sync selected agents/runtimes into separate managed roots and acknowledge each root separately.`);
  if (views.some(view => view.skills.length > ACK_LIMITS.skillsPerView)) throw new ReconcileError(`A managed view supports at most ${ACK_LIMITS.skillsPerView} skills; narrow this agent's assignments before synchronizing.`);
  const payload = { v: 1, engine, policyDigest, views };
  const parsed = AckRequestSchema.safeParse(payload);
  if (!parsed.success) throw new ReconcileError(`Managed views cannot be acknowledged: ${parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`);
  if (Buffer.byteLength(JSON.stringify(payload)) > ACK_LIMITS.bytes) throw new ReconcileError(`Managed views exceed the ${ACK_LIMITS.bytes}-byte acknowledgement capacity; select fewer agents or skills in a separate managed root before synchronizing.`);
}
export function validatePlanCapacity(plan: Plan): void { acknowledgementCapacity(plan.views.map(plannedAck), plan.policyDigest); }
const planCapacity = validatePlanCapacity;

/** The managed resolution for the selected agents. Refuses a legacy or unparseable policy: there is nothing approved to deploy. */
export function planViews(catalog: Catalog, policy: LoadedPolicy, roster: Roster, sel: { agents?: string[]; runtime?: SkillRuntime } = {}): Plan {
  const plan = proposeViews(catalog, policy, roster, sel);
  assertPolicyReviewed(policy);
  authorizePlan(plan);
  return plan;
}

/** Inspection-only proposal. It cannot be packed or activated until a trusted authority verifies it. */
export function proposeViews(catalog: Catalog, policy: LoadedPolicy, roster: Roster, sel: { agents?: string[]; runtime?: SkillRuntime } = {}): Plan {
  if (policy.mode !== 'managed') throw new ReconcileError('the skills policy is in legacy mode (or missing): runtimes keep their own folders and there is nothing managed to deploy. Set `mode: managed` in the policy through review first.');
  if (!policy.valid) throw new ReconcileError(`the skills policy does not parse (${policy.errors.join('; ')}); nothing deployed, existing deployments left as they are`);
  if (roster.error) throw new ReconcileError(`the agent roster is invalid (${roster.error}); nothing deployed, existing views left unchanged`);
  const wanted = sel.agents?.length ? sel.agents : roster.agents.map((a) => a.name);
  const views: ViewPlan[] = [];
  const packages = new Map<string, PackageSource>();
  for (const name of wanted) {
    const agent = roster.agents.find((a) => a.name === name);
    if (!agent) throw new ReconcileError(`no agent ${name} in the roster`);
    const runtime = (sel.runtime ?? agent.runtime) as SkillRuntime;
    if (!ADAPTER_RUNTIMES.includes(runtime)) {
      if (sel.agents?.length) throw new ReconcileError(`${name} runs on ${agent.runtime}, which has no skills adapter; pass --runtime`);
      continue;
    }
    const cells = resolveAgent(agent, policy, catalog);
    const skills: PlannedSkill[] = [];
    const excluded: ViewPlan['excluded'] = unresolvedAssignments(cells.values());
    for (const c of [...cells.values()].sort((a, b) => (a.skill < b.skill ? -1 : 1))) {
      if (c.state !== 'assigned') {
        // Explicit denials and lifecycle revocations are intentional omissions. Broken assigned packages are not.
        continue;
      }
      const cand = selectedCandidate(policy.policy, catalog, c.skill).candidate!;
      if (cand.dirty !== false || cand.tracked !== true) throw new ReconcileError(`Skill ${c.skill} is dirty, untracked, or has unknown Git provenance; commit and review every package member before deploying managed views`);
      skills.push({ name: c.skill, id: cand.id, digest: cand.digest!, revision: cand.revision, dirty: cand.dirty, description: cand.description, depends: cand.metadata.depends, requires: cand.metadata.requires });
      if (!packages.has(cand.digest!)) packages.set(cand.digest!, { files: cand.packageFiles.map((f) => ({ path: f.path, exec: f.exec, read: () => readFileSync(f.abs) })) });
    }
    views.push({ agent: name, runtime, skills, excluded });
  }
  const plan = { policyDigest: policy.digest, views, packages };
  planCapacity(plan);
  return plan;
}

// ---- bundles: the explicit transport for a host with no vault checkout ----

export interface Bundle {
  format: 'secondbrain-skills-bundle/1';
  createdAt: string;
  policyDigest: string | null;
  views: ViewPlan[];
  packages: Record<string, { files: { path: string; exec: boolean; data: string }[] }>;
}
export const BUNDLE_MAX_BYTES = 200 * 1024 * 1024;

export function packBundle(plan: Plan): Bundle {
  planCapacity(plan);
  assertPlanAuthorized(plan);
  const packages: Bundle['packages'] = {};
  let total = 0;
  for (const [digest, src] of plan.packages) {
    packages[digest] = { files: src.files.map((f) => { const data = f.read(); total += data.length; return { path: f.path, exec: f.exec, data: data.toString('base64') }; }) };
    if (total > BUNDLE_MAX_BYTES) throw new ReconcileError('bundle over 200 MB; select fewer agents');
  }
  return { format: 'secondbrain-skills-bundle/1', createdAt: new Date().toISOString(), policyDigest: plan.policyDigest, views: plan.views, packages };
}

export function planFromBundle(b: unknown): Plan {
  const x = b as Bundle;
  if (!x || x.format !== 'secondbrain-skills-bundle/1' || !Array.isArray(x.views) || typeof x.packages !== 'object') throw new ReconcileError('not a skills bundle');
  const packages = new Map<string, PackageSource>();
  for (const [digest, p] of Object.entries(x.packages)) {
    if (!/^sha256:[0-9a-f]{64}$/.test(digest) || !Array.isArray(p.files)) throw new ReconcileError(`bad package entry ${digest.slice(0, 20)}`);
    const seen = new Set<string>();
    for (const f of p.files) {
      safePkgPath(String(f.path));
      if (seen.has(f.path)) throw new ReconcileError(`duplicate package path: ${f.path}`);
      seen.add(f.path);
    }
    if (p.files.length > LIMITS.files) throw new ReconcileError('too many package files');
    packages.set(digest, { files: p.files.map((f) => ({ path: String(f.path), exec: !!f.exec, read: () => Buffer.from(String(f.data), 'base64') })) });
  }
  for (const v of x.views) {
    if (!NAME_RE.test(v.agent) || !ADAPTER_RUNTIMES.includes(v.runtime)) throw new ReconcileError('bad view in bundle');
    for (const s of v.skills) if (!NAME_RE.test(s.name) || !packages.has(s.digest)) throw new ReconcileError(`bundle lacks the package for ${s.name}`);
  }
  const plan = { policyDigest: x.policyDigest ?? null, views: x.views, packages };
  planCapacity(plan);
  return plan;
}

// ---- staging and activation ----

function safePkgPath(p: string): string[] {
  const segs = p.split('/');
  if (p.length > LIMITS.pathLength || segs.length > LIMITS.depth + 1) throw new ReconcileError('package path exceeds length or depth limit');
  if (!p || p.startsWith('/') || segs.some((s) => !s || s === '.' || s === '..' || s.includes('\\') || s.includes('\0'))) throw new ReconcileError(`unsafe path in package: ${p.slice(0, 80)}`);
  if (segs.some((s) => isIgnoredName(s) || isSecretLike(s))) throw new ReconcileError(`ignored or credential path in package: ${p.slice(0, 80)}`);
  return segs;
}

/** Stores contain only materialized files. Nothing may hide from the package digest's walker. */
function strictStoreFiles(dir: string): string[] {
  const files: string[] = [];
  const walk = (folder: string): void => {
    for (const name of readdirSync(folder)) {
      const path = join(folder, name);
      const rel = relative(dir, path).split(sep).join('/');
      safePkgPath(rel);
      const st = lstatSync(path);
      if (st.isSymbolicLink()) throw new ReconcileError(`stored package contains a link: ${rel}`);
      if (st.isDirectory()) walk(path);
      else if (st.isFile()) files.push(rel);
      else throw new ReconcileError(`stored package contains a special file: ${rel}`);
      if (files.length > LIMITS.files) throw new ReconcileError('too many stored package files');
    }
  };
  walk(dir);
  return files.sort();
}

function lockDown(dir: string): void {
  if (lstatSync(dir).isSymbolicLink()) throw new ReconcileError('refusing to change permissions through a stored package link');
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (lstatSync(p).isSymbolicLink()) throw new ReconcileError('refusing to change permissions through a stored package link');
    if (e.isDirectory()) lockDown(p);
    else chmodSync(p, (lstatSync(p).mode & 0o111) ? 0o555 : 0o444);
  }
  chmodSync(dir, 0o555);
}

function unlock(dir: string): void {
  if (!existsSync(dir) || lstatSync(dir).isSymbolicLink() || !lstatSync(dir).isDirectory()) return;
  chmodSync(dir, 0o755);
  for (const e of readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) unlock(join(dir, e.name));
}

export function removeTree(dir: string): void {
  try { unlock(dir); } catch { /* best effort before rm */ }
  rmSync(dir, { recursive: true, force: true });
}

export interface SyncHooks { afterStage?: (digest: string, stagedDir: string) => void; beforeActivate?: (view: ViewPlan) => void }

/** Verify a store entry: its full digest must equal its name. */
function storeOk(root: string, digest: string): boolean {
  const dir = join(root, 'store', hex(digest));
  if (!existsSync(dir) || lstatSync(dir).isSymbolicLink()) return false;
  try {
    const members = strictStoreFiles(dir);
    const scan = scanPackage(dir);
    return scan.ok && scan.digest === digest && scan.files.length === members.length;
  } catch { return false; }
}

interface StoreRepair { root: string; final: string; backup: string; mode: number | null }
/** Moving a directory needs only its root writable; never traverse or chmod dirty contents. */
function directoryMode(path: string): number | null {
  const st = lstatSync(path);
  return st.isDirectory() && !st.isSymbolicLink() ? st.mode & 0o777 : null;
}
function setDirectoryMode(path: string, mode: number | null): void {
  const st = lstatSync(path);
  if (mode !== null && st.isDirectory() && !st.isSymbolicLink()) chmodSync(path, mode);
}
function restoreRepair(repair: StoreRepair): void {
  managedDirectory(repair.root, join(repair.root, 'store'));
  managedDirectory(repair.root, join(repair.root, 'quarantine'));
  removeManagedDirectory(repair.root, repair.final);
  setDirectoryMode(repair.backup, repair.mode === null ? null : 0o755);
  renameSync(repair.backup, repair.final);
  setDirectoryMode(repair.final, repair.mode);
}
function stagePackage(root: string, digest: string, src: PackageSource, hooks: SyncHooks, repairs?: StoreRepair[]): void {
  managedDirectory(root, join(root, 'store'), true);
  managedDirectory(root, join(root, '.staging'), true);
  const expected = new Set<string>();
  for (const file of src.files) {
    safePkgPath(file.path);
    if (expected.has(file.path)) throw new ReconcileError(`duplicate package path: ${file.path}`);
    expected.add(file.path);
  }
  if (expected.size > LIMITS.files) throw new ReconcileError('too many package files');
  const final = join(root, 'store', hex(digest));
  if (existsSync(final)) {
    if (storeOk(root, digest)) return;
    if (!repairs) throw new ReconcileError(`store package ${hex(digest).slice(0, 12)} was modified on this machine (dirty); run with --repair to move it to quarantine and redeploy`);
  }
  const staging = join(root, '.staging', `${hex(digest).slice(0, 12)}-${randomBytes(4).toString('hex')}`);
  mkdirSync(staging, { mode: 0o700 });
  let backup: string | null = null, installed = false;
  let mode: number | null = null;
  try {
    let bytes = 0;
    for (const f of src.files) {
      const segs = safePkgPath(f.path);
      const dest = join(staging, ...segs);
      mkdirSync(join(staging, ...segs.slice(0, -1)), { recursive: true });
      const data = f.read();
      bytes += data.length;
      if (data.length > LIMITS.fileBytes || bytes > LIMITS.totalBytes) throw new ReconcileError('package exceeds file or total size limit');
      writeFileSync(dest, data, { mode: f.exec ? 0o755 : 0o644 });
      chmodSync(dest, f.exec ? 0o755 : 0o644);
    }
    hooks.afterStage?.(digest, staging);
    managedDirectory(root, staging);
    const members = strictStoreFiles(staging);
    if (members.length !== expected.size || members.some((p) => !expected.has(p))) throw new ReconcileError('staged package contains files outside its approved manifest');
    const scan = scanPackage(staging);
    if (!scan.ok) throw new ReconcileError(`staged package ${hex(digest).slice(0, 12)}: ${scan.error}`);
    if (scan.digest !== digest) throw new ReconcileError(`staged package digest ${scan.digest.slice(0, 19)} does not match the approved ${digest.slice(0, 19)}; the source changed or was tampered with`);
    managedDirectory(root, join(root, 'store'), true);
    // A dirty entry stays readable until the complete replacement has been staged and verified.
    if (existsSync(final)) {
      if (storeOk(root, digest)) { removeManagedDirectory(root, staging); return; }
      if (!repairs) throw new ReconcileError('The destination store became dirty while staging; retry with --repair.');
      managedDirectory(root, join(root, 'quarantine'), true);
      const targetBackup = join(root, 'quarantine', `${hex(digest)}-${Date.now()}-${randomBytes(3).toString('hex')}`);
      mode = directoryMode(final);
      setDirectoryMode(final, mode === null ? null : 0o755);
      renameSync(final, targetBackup); backup = targetBackup; setDirectoryMode(backup, mode);
    }
    renameSync(staging, final); installed = true;
    lockDown(final);
    if (backup) repairs!.push({ root, final, backup, mode });
  } catch (err) {
    if (installed) removeManagedDirectory(root, final);
    if (backup) { setDirectoryMode(backup, mode === null ? null : 0o755); renameSync(backup, final); setDirectoryMode(final, mode); }
    else if (mode !== null && existsSync(final)) setDirectoryMode(final, mode);
    removeManagedDirectory(root, staging);
    throw err;
  }
}

export interface Manifest {
  format: typeof VIEW_FORMAT; agent: string; runtime: SkillRuntime; generatedAt: string; policyDigest: string | null; mode: 'managed';
  support: string; viewDigest: string;
  skills: { name: string; id: string; digest: string; revision: string | null; dirty: boolean | null; description: string; path: string }[];
}

/** Validate a generation's identity without assuming that matching directory names confer ownership. */
function readGeneration(root: string, agent: string, runtime: string, target: string): { manifest: Manifest; dir: string } | null {
  if (!generatedName(runtime, target)) return null;
  const dir = join(root, 'views', agent, target);
  try {
    if (!managedDirectory(root, dir)) return null;
    const file = join(dir, 'manifest.json'), fs = lstatSync(file);
    if (!fs.isFile() || fs.isSymbolicLink() || fs.size > 2_000_000) return null;
    const m = JSON.parse(readFileSync(file, 'utf8')) as Manifest;
    if (!m || m.format !== VIEW_FORMAT || m.mode !== 'managed' || m.agent !== agent || m.runtime !== runtime || !Array.isArray(m.skills) || m.skills.length > ACK_LIMITS.skillsPerView) return null;
    const names = new Set<string>();
    for (const pkg of m.skills) {
      if (!pkg || typeof pkg.name !== 'string' || typeof pkg.path !== 'string' || typeof pkg.digest !== 'string' || !NAME_RE.test(pkg.name) || pkg.path !== pkg.name || names.has(pkg.name) || !/^sha256:[0-9a-f]{64}$/.test(pkg.digest) || typeof pkg.id !== 'string') return null;
      names.add(pkg.name);
    }
    if (m.viewDigest !== viewDigest(m.skills) || !Number.isFinite(Date.parse(m.generatedAt)) || new Date(m.generatedAt).toISOString() !== m.generatedAt || (m.policyDigest !== null && !/^sha256:[0-9a-f]{64}$/.test(m.policyDigest))) return null;
    return { manifest: m, dir };
  } catch { return null; }
}
function generationEntriesOwned(dir: string, manifest: Manifest): boolean {
  const names = new Set(manifest.skills.map(s => s.name));
  for (const entry of readdirSync(dir)) {
    if (entry === 'manifest.json') continue;
    const skill = manifest.skills.find(s => s.name === entry);
    if (!skill || !names.has(entry)) return false;
    const path = join(dir, entry);
    if (!lstatSync(path).isSymbolicLink() || readlinkSync(path) !== `../../../store/${hex(skill.digest)}`) return false;
  }
  return manifest.skills.every(s => present(join(dir, s.name)));
}
function agentDirectory(root: string, agent: string, create = false): string | null {
  const path = managedDirectory(root, join(root, 'views', agent), create);
  if (!path) return null;
  for (const name of readdirSync(path)) {
    const entry = join(path, name);
    if (ADAPTER_RUNTIMES.includes(name as SkillRuntime)) {
      if (!lstatSync(entry).isSymbolicLink()) throw new ReconcileError(`views/${agent}/${name} is not a manager-made link; refusing an unmanaged directory`);
      const target = readlinkSync(entry);
      if (!generatedName(name, target)) throw new ReconcileError(`views/${agent}/${name} is not a manager-made generation link`);
    } else {
      const runtime = ADAPTER_RUNTIMES.find(r => generatedName(r, name));
      if (!runtime || !readGeneration(root, agent, runtime, name)) throw new ReconcileError(`unmanaged generation or directory in views/${agent}: ${name}`);
    }
  }
  return path;
}
export function readCurrent(root: string, agent: string, runtime: string): { manifest: Manifest | null; dir: string | null; unmanaged: boolean } {
  try {
    if (!NAME_RE.test(agent) || !ADAPTER_RUNTIMES.includes(runtime as SkillRuntime)) return { manifest: null, dir: null, unmanaged: true };
    if (!managedRoot(root) || !managedDirectory(root, join(root, 'views', agent))) return { manifest: null, dir: null, unmanaged: false };
    const link = join(root, 'views', agent, runtime);
    if (!present(link)) return { manifest: null, dir: null, unmanaged: false };
    if (!lstatSync(link).isSymbolicLink()) return { manifest: null, dir: null, unmanaged: true };
    const target = readlinkSync(link);
    const generation = readGeneration(root, agent, runtime, target);
    return generation ? { ...generation, unmanaged: false } : { manifest: null, dir: null, unmanaged: !generatedName(runtime, target) };
  } catch { return { manifest: null, dir: null, unmanaged: true }; }
}

/** Dirty names in an active view: a store package that no longer matches its digest, or a view entry that is not the manager's link. */
export function verifyView(root: string, agent: string, runtime: string): { dirty: string[]; manifest: Manifest | null; unmanaged: boolean } {
  const cur = readCurrent(root, agent, runtime);
  if (!cur.manifest || !cur.dir) return { dirty: [], manifest: cur.manifest, unmanaged: cur.unmanaged };
  const dirty: string[] = [];
  const names = new Set(cur.manifest.skills.map((s) => s.path));
  for (const s of cur.manifest.skills) {
    const entry = join(cur.dir, s.path);
    let ok = false;
    try { ok = lstatSync(entry).isSymbolicLink() && readlinkSync(entry) === `../../../store/${hex(s.digest)}` && storeOk(root, s.digest); } catch { ok = false; }
    if (!ok) dirty.push(s.name);
  }
  for (const e of readdirSync(cur.dir)) if (e !== 'manifest.json' && !names.has(e)) dirty.push(e);
  return { dirty: [...new Set(dirty)].sort(), manifest: cur.manifest, unmanaged: false };
}

/** Missing programs (on PATH) and environment variable names. Values are never read or copied. */
export function checkRequirements(skills: PlannedSkill[], env: NodeJS.ProcessEnv = process.env): Requirement[] {
  const path = (env['PATH'] ?? '').split(delimiter).filter(Boolean);
  const has = (bin: string) => path.some((d) => { try { accessSync(join(d, bin), constants.X_OK); return true; } catch { return false; } });
  const out: Requirement[] = [];
  for (const s of skills) {
    const bins = s.requires.bins.filter((b) => !has(b));
    const envs = s.requires.env.filter((e) => !(e in env));
    if (bins.length || envs.length) out.push({ skill: s.name, bins, env: envs });
  }
  return out;
}

/** Dependencies are skills, not programs: unresolved direct or transitive dependencies block activation. */
export function dependencyFailures(skills: { name: string; depends?: string[] }[]): { name: string; reason: string }[] {
  const available = new Set(skills.map(s => s.name));
  const failed = new Map<string, string>();
  let changed: boolean;
  do {
    changed = false;
    for (const skill of skills) {
      if (!available.has(skill.name)) continue;
      const absent = (skill.depends ?? []).filter(name => !available.has(name));
      if (!absent.length) continue;
      failed.set(skill.name, `unresolved skill dependencies: ${absent.join(', ')}`);
      available.delete(skill.name); changed = true;
    }
  } while (changed);
  return [...failed].map(([name, reason]) => ({ name, reason }));
}

export interface SyncReport { root: string; policyDigest: string | null; views: AckView[]; at: string }

/** Persist only an outcome, never an intermediate per-view activation. */
function saveReport(root: string, report: SyncReport): void {
  managedRoot(root);
  const staging = managedDirectory(root, join(root, '.staging'), true)!;
  const state = join(staging, `.state-next-${randomBytes(6).toString('hex')}`);
  try {
    writeFileSync(state, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    managedDirectory(root, staging); renameSync(state, join(root, 'state.json'));
  } finally {
    // The rename is the commit point. Cleanup must not turn a committed result into a failed call.
    try { if (managedDirectory(root, staging)) { if (present(state)) rmSync(state, { force: true }); rmdirSync(staging); } } catch { /* Preserve other staging members or replaced paths. */ }
  }
}

export function syncViews(root: string, plan: Plan, opts: { repair?: boolean; hooks?: SyncHooks; env?: NodeJS.ProcessEnv } = {}): SyncReport {
  const hooks = opts.hooks ?? {};
  planCapacity(plan);
  assertPlanAuthorized(plan);
  const installed = new Map(inspectRoot(root, opts.env).map(view => [`${view.agent}/${view.runtime}`, view]));
  const projected = new Map(installed);
  for (const view of plan.views) projected.set(`${view.agent}/${view.runtime}`, plannedAck(view));
  acknowledgementCapacity([...projected.values()], plan.policyDigest);
  const identities = new Set<string>();
  for (const v of plan.views) {
    const key = `${v.agent}/${v.runtime}`;
    if (!NAME_RE.test(v.agent) || !ADAPTER_RUNTIMES.includes(v.runtime) || identities.has(key)) throw new ReconcileError('invalid or duplicate managed view identity');
    identities.add(key);
  }
  managedRoot(root, true);
  managedDirectory(root, join(root, 'views'), true);
  managedDirectory(root, join(root, 'store'), true);
  const repairs: StoreRepair[] = [];
  const staged: { view: ViewPlan; gen: string; dir: string; previous: string | null; ack: AckView }[] = [];
  const switched: typeof staged = [];
  const observations = new Map<string, { current: ReturnType<typeof verifyView>; missing: Requirement[]; excluded: { name: string; reason: string }[] }>();
  let failing: ViewPlan | null = null;
  let report: SyncReport;
  try {
    // Prepare every selected generation before changing any active link.
    for (const v of plan.views) {
      failing = v;
      agentDirectory(root, v.agent);
      const current = verifyView(root, v.agent, v.runtime), missing = checkRequirements(v.skills, opts.env), excluded = [...(v.excluded ?? [])];
      const observation = { current, missing, excluded }; observations.set(`${v.agent}/${v.runtime}`, observation);
      if (excluded.length) throw new ReconcileError(`Unresolved assignments: ${excluded.map(e => `${e.name}: ${e.reason}`).join('; ')}`);
      if (current.unmanaged) throw new ReconcileError(`views/${v.agent}/${v.runtime} is not a manager-made link; refusing to replace it`);
      if (current.dirty.length && !opts.repair) throw new ReconcileError(`deployed view was modified on this machine (${current.dirty.length} entries: ${current.dirty.join(', ')}); left as is. Rerun with --repair to redeploy.`);
      for (const s of v.skills) stagePackage(root, s.digest, plan.packages.get(s.digest) ?? (() => { throw new ReconcileError(`no source for ${s.name}`); })(), hooks, opts.repair ? repairs : undefined);
      const checked: PlannedSkill[] = [];
      for (const skill of v.skills) {
        const meta = readMeta(readFileSync(join(root, 'store', hex(skill.digest), 'SKILL.md'), 'utf8'), skill.name);
        if (meta.errors.length) excluded.push({ name: skill.name, reason: `invalid package metadata: ${meta.errors.join('; ')}` });
        else checked.push({ ...skill, depends: meta.depends, requires: meta.requires });
      }
      observation.missing = checkRequirements(checked, opts.env);
      excluded.push(...dependencyFailures(checked));
      if (excluded.length) throw new ReconcileError(`Unresolved assignments: ${excluded.map(e => `${e.name}: ${e.reason}`).join('; ')}`);
      const generatedAt = new Date().toISOString();
      const gen = `${v.runtime}.${generatedAt.replace(/[-:.]/g, '').slice(0, 15)}-${randomBytes(3).toString('hex')}`;
      const agentDir = agentDirectory(root, v.agent, true)!;
      const candidate: AckView = { ...plannedAck(v), generatedAt, missing: observation.missing, status: observation.missing.length ? 'not-ready' : 'current' };
      projected.set(`${v.agent}/${v.runtime}`, candidate);
      acknowledgementCapacity([...projected.values()], plan.policyDigest);
      const genDir = join(agentDir, gen);
      const active = join(agentDir, v.runtime);
      const entry = { view: v, gen, dir: genDir, previous: present(active) ? readlinkSync(active) : null, ack: candidate };
      mkdirSync(genDir); staged.push(entry);
      for (const s of v.skills) symlinkSync(`../../../store/${hex(s.digest)}`, join(genDir, s.name));
      const manifest: Manifest = {
        format: VIEW_FORMAT, agent: v.agent, runtime: v.runtime, generatedAt, policyDigest: plan.policyDigest, mode: 'managed',
        support: supportFor(v.runtime).level, viewDigest: viewDigest(v.skills),
        skills: v.skills.map((s) => ({ name: s.name, id: s.id, digest: s.digest, revision: s.revision, dirty: s.dirty, description: s.description, path: s.name })),
      };
      writeFileSync(join(genDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
      for (const s of v.skills) {
        const scan = scanPackage(join(genDir, s.name));
        if (!scan.ok || scan.digest !== s.digest) throw new ReconcileError(`verification of ${s.name} in the new view failed`);
      }
    }
    for (const entry of staged) {
      failing = entry.view;
      hooks.beforeActivate?.(entry.view);
      const agentDir = agentDirectory(root, entry.view.agent)!;
      managedDirectory(root, entry.dir);
      const active = join(agentDir, entry.view.runtime);
      if ((present(active) ? readlinkSync(active) : null) !== entry.previous) throw new ReconcileError('active view changed during synchronization; refusing to overwrite it');
      const tmp = join(agentDir, `.${entry.view.runtime}.next-${randomBytes(3).toString('hex')}`);
      try { symlinkSync(entry.gen, tmp); renameSync(tmp, active); switched.push(entry); }
      finally { if (present(tmp)) rmSync(tmp); }
    }
    report = { root, policyDigest: plan.policyDigest, views: staged.map(entry => entry.ack), at: new Date().toISOString() };
    saveReport(root, report);
  } catch (err) {
    const rollbackErrors: string[] = [];
    for (const entry of [...switched].reverse()) {
      try {
        const agentDir = managedDirectory(root, join(root, 'views', entry.view.agent))!;
        const active = join(agentDir, entry.view.runtime);
        if (!lstatSync(active).isSymbolicLink() || readlinkSync(active) !== entry.gen) throw new ReconcileError('active view changed before rollback');
        if (entry.previous === null) rmSync(active);
        else {
          const tmp = join(agentDir, `.${entry.view.runtime}.rollback-${randomBytes(3).toString('hex')}`);
          try { symlinkSync(entry.previous, tmp); renameSync(tmp, active); } finally { if (present(tmp)) rmSync(tmp); }
        }
      } catch (rollback) { rollbackErrors.push((rollback as Error).message); }
    }
    for (const repair of [...repairs].reverse()) { try { restoreRepair(repair); } catch (rollback) { rollbackErrors.push((rollback as Error).message); } }
    if (rollbackErrors.length) throw new ReconcileError(`Synchronization failed: ${(err as Error).message}; rollback failed: ${rollbackErrors.join('; ')}`);
    for (const entry of staged) { try { removeManagedDirectory(root, entry.dir); } catch { /* Never clean through a replaced parent link. */ } }
    report = { root, policyDigest: plan.policyDigest, at: new Date().toISOString(), views: plan.views.map(v => {
      const seen = observations.get(`${v.agent}/${v.runtime}`), prev = readCurrent(root, v.agent, v.runtime).manifest;
      const dirty = dirtyNames(seen?.current.dirty ?? []);
      return { agent: v.agent, runtime: v.runtime, viewDigest: prev?.viewDigest ?? null, generatedAt: prev?.generatedAt ?? null,
        status: dirty.length && !opts.repair ? 'dirty' as const : 'failed' as const,
        error: `Synchronization transaction failed at ${failing?.agent}/${failing?.runtime}: ${(err as Error).message}`.slice(0, 500),
        skills: (prev?.skills ?? []).map(s => ({ name: s.name, id: s.id, digest: s.digest })), missing: seen?.missing ?? [], dirty, excluded: seen?.excluded ?? v.excluded };
    }) };
    saveReport(root, report);
    return report;
  }
  // Once the outcome is committed, cleanup is best effort and cannot invalidate it.
  for (const v of plan.views) { try { pruneGenerations(root, v.agent, v.runtime); } catch { /* Preserve uncertain generations. */ } }
  try { gcStore(root); } catch { /* Defer collection if the root changed. */ }
  return report;
}

/** Keep the active generation and the one before it (for a manual switch back); delete older ones. */
function pruneGenerations(root: string, agent: string, runtime: string): void {
  const agentDir = agentDirectory(root, agent);
  if (!agentDir) return;
  const active = readlinkSync(join(agentDir, runtime));
  const gens = readdirSync(agentDir).filter(n => n !== active && generatedName(runtime, n)).flatMap(name => {
    const generation = readGeneration(root, agent, runtime, name);
    return generation && generationEntriesOwned(generation.dir, generation.manifest) ? [{ name, ...generation }] : [];
  }).sort((a, b) => a.manifest.generatedAt.localeCompare(b.manifest.generatedAt) || a.name.localeCompare(b.name));
  for (const generation of gens.slice(0, Math.max(0, gens.length - 1))) removeManagedDirectory(root, generation.dir);
}

/** Only verified, unused manager packages can be collected. Unknown views or members defer collection. */
export function gcStore(root: string): string[] {
  if (!managedRoot(root)) return [];
  const used = new Set<string>();
  const viewsDir = managedDirectory(root, join(root, 'views'));
  if (viewsDir) for (const agent of readdirSync(viewsDir)) {
    if (!NAME_RE.test(agent)) return [];
    let ad: string | null;
    try { ad = agentDirectory(root, agent); } catch { return []; }
    if (!ad) continue;
    for (const name of readdirSync(ad)) {
      if (ADAPTER_RUNTIMES.includes(name as SkillRuntime)) continue;
      const runtime = ADAPTER_RUNTIMES.find(r => generatedName(r, name));
      const generation = runtime ? readGeneration(root, agent, runtime, name) : null;
      if (!generation || !generationEntriesOwned(generation.dir, generation.manifest)) return [];
      for (const s of generation.manifest.skills) used.add(hex(s.digest));
    }
  }
  const removed: string[] = [];
  const store = managedDirectory(root, join(root, 'store'));
  if (store) for (const h of readdirSync(store)) if (/^[0-9a-f]{64}$/.test(h) && !used.has(h) && storeOk(root, `sha256:${h}`)) {
    removeManagedDirectory(root, join(store, h)); removed.push(h);
  }
  return removed;
}

/** Status of every view under the root, for `skills status` and an acknowledgement without a sync. */
export function inspectRoot(root: string, env: NodeJS.ProcessEnv = process.env): AckView[] {
  const out: AckView[] = [];
  let previous: SyncReport | null = null;
  try { previous = JSON.parse(readFileSync(join(root, 'state.json'), 'utf8')) as SyncReport; } catch { /* no previous sync */ }
  const viewsDir = join(root, 'views');
  if (!existsSync(viewsDir)) return (previous?.views ?? []).map(v => ({ ...v, status: 'failed', error: 'The managed views folder is missing; synchronize again.', skills: [] }));
  for (const agent of readdirSync(viewsDir).sort()) {
    if (!NAME_RE.test(agent)) continue;
    for (const runtime of ADAPTER_RUNTIMES) {
      const v = verifyView(root, agent, runtime);
      const last = previous?.views?.find((r) => r.agent === agent && r.runtime === runtime);
      if (!v.manifest) {
        let active = false; try { lstatSync(join(viewsDir, agent, runtime)); active = true; } catch { /* absent */ }
        if (active || last) out.push({ agent, runtime, status: 'failed', error: 'Active managed view or its manifest is missing or invalid; synchronize again.', viewDigest: null, generatedAt: last?.generatedAt ?? null, skills: [], missing: last?.missing ?? [], dirty: [], excluded: last?.excluded ?? [] });
        continue;
      }
      const unknown = new Set(v.dirty);
      const checked: PlannedSkill[] = [];
      for (const s of v.manifest.skills) {
        if (unknown.has(s.name)) continue;
        try {
          const meta = readMeta(readFileSync(join(root, 'store', hex(s.digest), 'SKILL.md'), 'utf8'), s.name);
          if (meta.errors.length) { unknown.add(s.name); continue; }
          checked.push({ ...s, depends: meta.depends, requires: meta.requires });
        } catch { unknown.add(s.name); }
      }
      const missing = [...checkRequirements(checked, env), ...(last?.missing ?? []).filter((r) => unknown.has(r.skill))];
      const dependencies = dependencyFailures(checked);
      const excluded = [...new Map([...(last?.excluded ?? []), ...dependencies].map(e => [e.name, e])).values()];
      const oldPolicy = previous !== null && previous.policyDigest !== v.manifest.policyDigest;
      const failed = last?.status === 'failed';
      out.push({ agent, runtime, viewDigest: v.manifest.viewDigest, generatedAt: v.manifest.generatedAt, status: v.dirty.length ? 'dirty' : failed || oldPolicy || excluded.length ? 'failed' : missing.length ? 'not-ready' : 'current',
        error: v.dirty.length ? `modified on this machine (${v.dirty.length} entries): ${v.dirty.join(', ')}`.slice(0, 500) : failed ? last.error ?? 'The last synchronization failed; sync again.' : oldPolicy ? 'Active view uses an older policy than the last requested sync; sync it again.' : excluded.length ? `Unresolved assignments: ${excluded.map(e => `${e.name}: ${e.reason}`).join('; ')}`.slice(0, 500) : null,
        skills: v.manifest.skills.map((s) => ({ name: s.name, id: s.id, digest: s.digest })), missing, dirty: dirtyNames(v.dirty), excluded });
    }
  }
  for (const last of previous?.views ?? []) if (!out.some(v => v.agent === last.agent && v.runtime === last.runtime)) out.push({ ...last, status: 'failed', error: 'Previously deployed managed view is missing; synchronize again.', skills: [] });
  return out;
}

export function ackPayload(report: { policyDigest: string | null; views: AckView[] }, engine: string | null): AckRequest {
  acknowledgementCapacity(report.views, report.policyDigest, engine);
  return { v: 1, engine, policyDigest: report.policyDigest, views: report.views };
}

/** POST the acknowledgement with the machine's device token. Only digests, names and requirement names leave the machine. */
export async function sendAck(server: string, token: string, payload: AckRequest, fetchFn: typeof fetch = fetch): Promise<{ ok: boolean; status: number; body: string }> {
  let url: URL;
  try { url = new URL(server); } catch { throw new ReconcileError('--server must be a valid HTTPS URL'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw new ReconcileError('--server requires HTTPS except for loopback development');
  if (url.username || url.password || url.search || url.hash) throw new ReconcileError('--server must not contain credentials, query or fragment');
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/api/skills/ack`;
  const res = await fetchFn(url.toString(), { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(payload), signal: AbortSignal.timeout(30_000) });
  return { ok: res.ok, status: res.status, body: (await res.text()).slice(0, 2000) };
}
