import { createHash, randomBytes } from 'node:crypto';
import { accessSync, chmodSync, constants, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { delimiter, join, relative, sep } from 'node:path';
import type { AckRequest, AckView, Requirement, SkillRuntime } from '@secondbrain/contracts/skills';
import type { Catalog } from './catalog.js';
import { isIgnoredName, isSecretLike, LIMITS, NAME_RE, readMeta, scanPackage } from './package.js';
import { resolveAgent, selectedCandidate, supportFor, type LoadedPolicy } from './policy.js';
import type { Roster } from './roster.js';

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

export interface PlannedSkill { name: string; id: string; digest: string; revision: string | null; dirty: boolean; description: string; requires: { bins: string[]; env: string[] } }
export interface PackageSource { files: { path: string; exec: boolean; read: () => Buffer }[] }
export interface ViewPlan { agent: string; runtime: SkillRuntime; skills: PlannedSkill[]; excluded: { name: string; reason: string }[] }
export interface Plan { policyDigest: string | null; views: ViewPlan[]; packages: Map<string, PackageSource> }

export class ReconcileError extends Error {}

const hex = (digest: string) => digest.slice('sha256:'.length);

export function viewDigest(skills: { name: string; digest: string }[]): string {
  const h = createHash('sha256');
  for (const s of [...skills].sort((a, b) => (a.name < b.name ? -1 : 1))) h.update(`${s.name}\0${s.digest}\n`);
  return `sha256:${h.digest('hex')}`;
}

/** The managed resolution for the selected agents. Refuses a legacy or unparseable policy: there is nothing approved to deploy. */
export function planViews(catalog: Catalog, policy: LoadedPolicy, roster: Roster, sel: { agents?: string[]; runtime?: SkillRuntime } = {}): Plan {
  if (policy.mode !== 'managed') throw new ReconcileError('the skills policy is in legacy mode (or missing): runtimes keep their own folders and there is nothing managed to deploy. Set `mode: managed` in the policy through review first.');
  if (!policy.valid) throw new ReconcileError(`the skills policy does not parse (${policy.errors.join('; ')}); nothing deployed, existing deployments left as they are`);
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
    const excluded: ViewPlan['excluded'] = [];
    for (const c of [...cells.values()].sort((a, b) => (a.skill < b.skill ? -1 : 1))) {
      if (c.state !== 'assigned') { if (c.state === 'unavailable') excluded.push({ name: c.skill, reason: c.reasons.filter((r) => r.kind === 'deny').map((r) => r.detail).join('; ') }); continue; }
      const cand = selectedCandidate(policy.policy, catalog, c.skill).candidate!;
      skills.push({ name: c.skill, id: cand.id, digest: cand.digest!, revision: cand.revision, dirty: cand.dirty === true, description: cand.description, requires: cand.metadata.requires });
      if (!packages.has(cand.digest!)) packages.set(cand.digest!, { files: cand.packageFiles.map((f) => ({ path: f.path, exec: f.exec, read: () => readFileSync(f.abs) })) });
    }
    views.push({ agent: name, runtime, skills, excluded });
  }
  return { policyDigest: policy.digest, views, packages };
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
  return { policyDigest: x.policyDigest ?? null, views: x.views, packages };
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
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) lockDown(p);
    else chmodSync(p, (lstatSync(p).mode & 0o111) ? 0o555 : 0o444);
  }
  chmodSync(dir, 0o555);
}

function unlock(dir: string): void {
  if (!existsSync(dir)) return;
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

function stagePackage(root: string, digest: string, src: PackageSource, hooks: SyncHooks): void {
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
    throw new ReconcileError(`store package ${hex(digest).slice(0, 12)} was modified on this machine (dirty); run with --repair to move it to quarantine and redeploy`);
  }
  const staging = join(root, '.staging', `${hex(digest).slice(0, 12)}-${randomBytes(4).toString('hex')}`);
  mkdirSync(staging, { recursive: true });
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
    const members = strictStoreFiles(staging);
    if (members.length !== expected.size || members.some((p) => !expected.has(p))) throw new ReconcileError('staged package contains files outside its approved manifest');
    const scan = scanPackage(staging);
    if (!scan.ok) throw new ReconcileError(`staged package ${hex(digest).slice(0, 12)}: ${scan.error}`);
    if (scan.digest !== digest) throw new ReconcileError(`staged package digest ${scan.digest.slice(0, 19)} does not match the approved ${digest.slice(0, 19)}; the source changed or was tampered with`);
    mkdirSync(join(root, 'store'), { recursive: true });
    // Rename first (moving a read-only folder to a new parent needs write access to it on Linux), then lock.
    renameSync(staging, final);
    lockDown(final);
  } catch (err) {
    removeTree(staging);
    throw err;
  }
}

export interface Manifest {
  format: typeof VIEW_FORMAT; agent: string; runtime: SkillRuntime; generatedAt: string; policyDigest: string | null; mode: 'managed';
  support: string; viewDigest: string;
  skills: { name: string; id: string; digest: string; revision: string | null; dirty: boolean; description: string; path: string }[];
}

export function readCurrent(root: string, agent: string, runtime: string): { manifest: Manifest | null; dir: string | null; unmanaged: boolean } {
  const link = join(root, 'views', agent, runtime);
  let st;
  try { st = lstatSync(link); } catch { return { manifest: null, dir: null, unmanaged: false }; }
  if (!st.isSymbolicLink()) return { manifest: null, dir: null, unmanaged: true };
  const dir = join(root, 'views', agent, readlinkSync(link));
  try { return { manifest: JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Manifest, dir, unmanaged: false }; } catch { return { manifest: null, dir, unmanaged: false }; }
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

export interface SyncReport { root: string; policyDigest: string | null; views: AckView[]; at: string }

export function syncViews(root: string, plan: Plan, opts: { repair?: boolean; hooks?: SyncHooks; env?: NodeJS.ProcessEnv } = {}): SyncReport {
  const hooks = opts.hooks ?? {};
  mkdirSync(join(root, 'views'), { recursive: true });
  mkdirSync(join(root, 'store'), { recursive: true });
  const views: AckView[] = [];
  for (const v of plan.views) {
    const base = { agent: v.agent, runtime: v.runtime } as const;
    const current = verifyView(root, v.agent, v.runtime);
    const missing = checkRequirements(v.skills, opts.env);
    try {
      if (current.unmanaged) throw new ReconcileError(`views/${v.agent}/${v.runtime} is not a manager-made link; refusing to replace it`);
      if (current.dirty.length && !opts.repair) {
        views.push({ ...base, viewDigest: current.manifest?.viewDigest ?? null, generatedAt: current.manifest?.generatedAt ?? null, status: 'dirty',
          error: `deployed view was modified on this machine (${current.dirty.join(', ')}); left as is. Rerun with --repair to redeploy.`,
          skills: (current.manifest?.skills ?? []).map((s) => ({ name: s.name, id: s.id, digest: s.digest })), missing, dirty: current.dirty });
        continue;
      }
      if (opts.repair) {
        for (const s of current.manifest?.skills ?? []) {
          const dir = join(root, 'store', hex(s.digest));
          if (existsSync(dir) && !storeOk(root, s.digest)) {
            mkdirSync(join(root, 'quarantine'), { recursive: true });
            unlock(dir);
            renameSync(dir, join(root, 'quarantine', `${hex(s.digest)}-${Date.now()}`));
          }
        }
      }
      for (const s of v.skills) stagePackage(root, s.digest, plan.packages.get(s.digest) ?? (() => { throw new ReconcileError(`no source for ${s.name}`); })(), hooks);
      const generatedAt = new Date().toISOString();
      const gen = `${v.runtime}.${generatedAt.replace(/[-:.]/g, '').slice(0, 15)}-${randomBytes(3).toString('hex')}`;
      const agentDir = join(root, 'views', v.agent);
      mkdirSync(agentDir, { recursive: true });
      const genDir = join(agentDir, gen);
      mkdirSync(genDir);
      try {
        for (const s of v.skills) symlinkSync(`../../../store/${hex(s.digest)}`, join(genDir, s.name));
        const manifest: Manifest = {
          format: VIEW_FORMAT, agent: v.agent, runtime: v.runtime, generatedAt, policyDigest: plan.policyDigest, mode: 'managed',
          support: supportFor(v.runtime).level, viewDigest: viewDigest(v.skills),
          skills: v.skills.map((s) => ({ name: s.name, id: s.id, digest: s.digest, revision: s.revision, dirty: s.dirty, description: s.description, path: s.name })),
        };
        writeFileSync(join(genDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
        // Full verification of the new generation through its own links before it can become active.
        for (const s of v.skills) {
          const scan = scanPackage(join(genDir, s.name));
          if (!scan.ok || scan.digest !== s.digest) throw new ReconcileError(`verification of ${s.name} in the new view failed`);
        }
        hooks.beforeActivate?.(v);
        const tmp = join(agentDir, `.${v.runtime}.next-${randomBytes(3).toString('hex')}`);
        symlinkSync(gen, tmp);
        renameSync(tmp, join(agentDir, v.runtime)); // atomic switch
      } catch (err) {
        rmSync(genDir, { recursive: true, force: true });
        throw err;
      }
      pruneGenerations(agentDir, v.runtime);
      views.push({ ...base, viewDigest: viewDigest(v.skills), generatedAt, status: 'current', error: null, skills: v.skills.map((s) => ({ name: s.name, id: s.id, digest: s.digest })), missing, dirty: [] });
    } catch (err) {
      const prev = readCurrent(root, v.agent, v.runtime).manifest;
      views.push({ ...base, viewDigest: prev?.viewDigest ?? null, generatedAt: prev?.generatedAt ?? null, status: 'failed', error: (err as Error).message.slice(0, 500),
        skills: (prev?.skills ?? []).map((s) => ({ name: s.name, id: s.id, digest: s.digest })), missing, dirty: current.dirty });
    }
  }
  rmSync(join(root, '.staging'), { recursive: true, force: true });
  gcStore(root);
  const report: SyncReport = { root, policyDigest: plan.policyDigest, views, at: new Date().toISOString() };
  writeFileSync(join(root, 'state.json'), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

/** Keep the active generation and the one before it (for a manual switch back); delete older ones. */
function pruneGenerations(agentDir: string, runtime: string): void {
  const active = readlinkSync(join(agentDir, runtime));
  const gens = readdirSync(agentDir).filter((n) => n.startsWith(`${runtime}.`) && n !== active).sort();
  for (const g of gens.slice(0, Math.max(0, gens.length - 1))) rmSync(join(agentDir, g), { recursive: true, force: true });
}

/** Delete store packages no remaining generation links to. Only the manager's own store is touched. */
export function gcStore(root: string): string[] {
  const used = new Set<string>();
  const viewsDir = join(root, 'views');
  if (existsSync(viewsDir)) for (const agent of readdirSync(viewsDir)) {
    const ad = join(viewsDir, agent);
    if (!lstatSync(ad).isDirectory()) continue;
    for (const g of readdirSync(ad)) {
      const gd = join(ad, g);
      if (lstatSync(gd).isSymbolicLink() || !lstatSync(gd).isDirectory()) continue;
      for (const e of readdirSync(gd)) { try { const t = readlinkSync(join(gd, e)); used.add(t.split('/').pop()!); } catch { /* manifest.json */ } }
    }
  }
  const removed: string[] = [];
  const store = join(root, 'store');
  if (existsSync(store)) for (const h of readdirSync(store)) if (/^[0-9a-f]{64}$/.test(h) && !used.has(h)) { removeTree(join(store, h)); removed.push(h); }
  return removed;
}

/** Status of every view under the root, for `skills status` and an acknowledgement without a sync. */
export function inspectRoot(root: string, env: NodeJS.ProcessEnv = process.env): AckView[] {
  const out: AckView[] = [];
  let previous: SyncReport | null = null;
  try { previous = JSON.parse(readFileSync(join(root, 'state.json'), 'utf8')) as SyncReport; } catch { /* no previous sync */ }
  const viewsDir = join(root, 'views');
  if (!existsSync(viewsDir)) return out;
  for (const agent of readdirSync(viewsDir).sort()) {
    if (!NAME_RE.test(agent)) continue;
    for (const runtime of ADAPTER_RUNTIMES) {
      const v = verifyView(root, agent, runtime);
      if (!v.manifest) continue;
      const last = previous?.views?.find((r) => r.agent === agent && r.runtime === runtime);
      const unknown = new Set(v.dirty);
      const checked: PlannedSkill[] = [];
      for (const s of v.manifest.skills) {
        if (unknown.has(s.name)) continue;
        try {
          const meta = readMeta(readFileSync(join(root, 'store', hex(s.digest), 'SKILL.md'), 'utf8'), s.name);
          if (meta.errors.length) { unknown.add(s.name); continue; }
          checked.push({ ...s, requires: meta.requires });
        } catch { unknown.add(s.name); }
      }
      const missing = [...checkRequirements(checked, env), ...(last?.missing ?? []).filter((r) => unknown.has(r.skill))];
      const oldPolicy = previous !== null && previous.policyDigest !== v.manifest.policyDigest;
      out.push({ agent, runtime, viewDigest: v.manifest.viewDigest, generatedAt: v.manifest.generatedAt, status: v.dirty.length ? 'dirty' : oldPolicy ? 'failed' : 'current',
        error: v.dirty.length ? `modified on this machine: ${v.dirty.join(', ')}` : oldPolicy ? 'Active view uses an older policy than the last requested sync; sync it again.' : null,
        skills: v.manifest.skills.map((s) => ({ name: s.name, id: s.id, digest: s.digest })), missing, dirty: v.dirty });
    }
  }
  return out;
}

export function ackPayload(report: { policyDigest: string | null; views: AckView[] }, engine: string | null): AckRequest {
  if (report.views.length > 64) throw new ReconcileError(`Cannot acknowledge ${report.views.length} views: the limit is 64. Sync selected agents/runtimes into separate managed roots and acknowledge each root separately.`);
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
