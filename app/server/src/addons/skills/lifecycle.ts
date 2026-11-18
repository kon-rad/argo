import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import yaml from 'js-yaml';
import type { Change, ChangeKind, ChangePreview, ChangeRequest, Draft, FileDiff, FileEntry, Validation } from '@secondbrain/contracts/skills';
import type { Candidate, Catalog } from './catalog.js';
import { unifiedDiff } from './diff.js';
import { blob, git, gitTop, toPosix, treeAt } from './git.js';
import { digestOf, isIgnoredName, isSecretLike, isText, NAME_RE, readMeta, scanPackage } from './package.js';
import { dependentsOf, grantsOf, lifecycleOf, parsePolicy, resolveAgent, selectedCandidate, type LoadedPolicy, type Policy } from './policy.js';
import type { Roster } from './roster.js';

/**
 * The lifecycle service shared by the web app and `secondbrain skills`. It writes only inside two
 * folders of the vault: drafts (packages being edited, never in a skill root, so never active) and
 * proposed changes (a target package and/or policy file plus the base digests they were made against).
 * Nothing becomes active here. `applyChange` (CLI) commits a proposed change on a new branch in a
 * temporary Git worktree, leaving the owner's checkout untouched, for the vault's normal review route.
 * Source packages are never deleted: removal is a policy state plus removal from managed deployments.
 */

export class LifecycleError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export interface LifecycleContext {
  vaultRoot: string;
  policyFile: string;
  policyRel: string;
  draftsDir: string;
  changesDir: string;
  privateRoot: string;
  catalog: Catalog;
  policy: LoadedPolicy;
  roster: Roster;
  /** Hosts' acknowledged views, for "affected hosts". */
  observed: { host: string; agent: string; runtime: string; skills: string[] }[];
  observationsAvailable?: boolean;
}

export const RUNNING_SESSIONS = 'Changes apply to new runs after the change is merged and machines are synced. Sessions already running keep what they loaded: zen-agent runs keep their pinned snapshot until they end, and other runtimes keep instructions already in context. Stop or restart a session to drop a revoked skill; a machine that is offline keeps its last deployment until it syncs.';

const DRAFT_LIMIT_BYTES = 512 * 1024;

// ---- safe paths ----

function within(root: string, p: string): boolean {
  const r = relative(root, p);
  return r !== '' && !r.startsWith('..') && !r.startsWith(sep) && !r.split(sep).includes('..');
}

/** A package-relative path from a request: plain segments only, no dot-dot, no hidden files, no secrets. */
export function safeRel(path: string): string {
  const segs = path.split('/');
  if (!path || path.length > 255 || path.startsWith('/') || segs.some((s) => !s || s === '.' || s === '..' || !/^[A-Za-z0-9_.-]+$/.test(s) || s.startsWith('.'))) {
    throw new LifecycleError(400, `unsafe package path "${path}"`);
  }
  if (segs.some((s) => isSecretLike(s))) throw new LifecycleError(400, `"${path}" looks like a credential file; packages must not carry secrets`);
  if (segs.some(isIgnoredName)) throw new LifecycleError(400, `ignored package path "${path}" cannot be saved in a draft`);
  if (segs.length > 12) throw new LifecycleError(400, 'path nests too deeply');
  return segs.join('/');
}

/** Refuse if any existing segment between root and the target is a symlink (no writes through links). */
function assertNoLinks(root: string, target: string): void {
  if (existsSync(root) && lstatSync(root).isSymbolicLink()) throw new LifecycleError(400, 'the drafts folder is a symlink; refusing to write through it');
  let cur = root;
  for (const seg of relative(root, target).split(sep)) {
    cur = join(cur, seg);
    if (existsSync(cur) || (() => { try { lstatSync(cur); return true; } catch { return false; } })()) {
      if (lstatSync(cur).isSymbolicLink()) throw new LifecycleError(400, `refusing to write through the symlink ${relative(root, cur)}`);
    }
  }
}

function checkName(name: string): string {
  if (!NAME_RE.test(name)) throw new LifecycleError(400, `"${name}" is not a valid skill name`);
  return name;
}

function atomicWrite(path: string, data: string | Buffer, exec = false): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${randomBytes(4).toString('hex')}`;
  writeFileSync(tmp, data, { mode: exec ? 0o755 : 0o644 });
  chmodSync(tmp, exec ? 0o755 : 0o644);
  renameSync(tmp, path);
}

// ---- drafts ----

interface DraftMeta { name: string; base: { id: string; digest: string | null } | null; createdAt: string }

const draftDir = (ctx: LifecycleContext, name: string) => join(ctx.draftsDir, checkName(name));
const draftMetaPath = (ctx: LifecycleContext, name: string) => join(ctx.draftsDir, `${checkName(name)}.draft.json`);

function fileEntries(files: { path: string; size: number; exec: boolean; sha256: string; abs: string }[]): FileEntry[] {
  return files.map((f) => {
    let kind: 'text' | 'binary' = 'binary';
    try { kind = isText(readFileSync(f.abs).subarray(0, 8192)) ? 'text' : 'binary'; } catch { /* unreadable stays binary */ }
    return { path: f.path, size: f.size, exec: f.exec, sha256: f.sha256, kind };
  });
}

export function validatePackage(dir: string, folder: string): { validation: Validation; digest: string | null; files: FileEntry[] } {
  const scan = scanPackage(dir, { rejectIgnored: true });
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!scan.ok) errors.push(scan.error);
  let md = '';
  try { md = readFileSync(join(dir, 'SKILL.md'), 'utf8'); } catch { /* reported by the scan */ }
  const meta = readMeta(md, folder);
  errors.push(...meta.errors);
  warnings.push(...meta.warnings);
  if (meta.name && meta.name !== folder) errors.push(`frontmatter name "${meta.name}" must equal the skill name "${folder}"`);
  return { validation: { valid: errors.length === 0, errors: [...new Set(errors)], warnings }, digest: scan.ok ? scan.digest : null, files: scan.ok ? fileEntries(scan.files) : [] };
}

export function getDraft(ctx: LifecycleContext, name: string): Draft {
  const dir = draftDir(ctx, name);
  if (!existsSync(dir)) throw new LifecycleError(404, `no draft ${name}`);
  let meta: DraftMeta = { name, base: null, createdAt: new Date(0).toISOString() };
  try { meta = JSON.parse(readFileSync(draftMetaPath(ctx, name), 'utf8')) as DraftMeta; } catch { /* a draft folder without meta is still a draft */ }
  const v = validatePackage(dir, name);
  const st = lstatSync(dir);
  return { name, base: meta.base, files: v.files, updatedAt: st.mtime.toISOString(), validation: v.validation, digest: v.digest };
}

export function listDrafts(ctx: LifecycleContext): Draft[] {
  if (!existsSync(ctx.draftsDir)) return [];
  return readdirSync(ctx.draftsDir).filter((n) => NAME_RE.test(n) && lstatSync(join(ctx.draftsDir, n)).isDirectory()).sort().map((n) => getDraft(ctx, n));
}

function findCandidate(catalog: Catalog, ref: string): Candidate | null {
  if (ref.includes(':')) return catalog.candidates.find((c) => c.id === ref) ?? null;
  return catalog.byName.get(ref)?.[0] ?? null;
}

export function createDraft(ctx: LifecycleContext, name: string, from?: string, description?: string): Draft {
  const dir = draftDir(ctx, name);
  if (existsSync(dir)) throw new LifecycleError(409, `a draft named ${name} already exists`);
  assertNoLinks(ctx.draftsDir, dir);
  mkdirSync(ctx.draftsDir, { recursive: true });
  const staging = mkdtempSync(join(ctx.draftsDir, `.new-${name}-`));
  try {
    let base: DraftMeta['base'] = null;
    if (from) {
      const c = findCandidate(ctx.catalog, from);
      if (!c) throw new LifecycleError(404, `no skill ${from} to start the draft from`);
      if (!c.valid || !c.digest) throw new LifecycleError(422, `${c.id} is invalid (${c.errors.join('; ')}); fix it at its source first`);
      for (const f of c.packageFiles) {
        const data = readFileSync(f.abs);
        atomicWrite(join(staging, ...f.path.split('/')), data, f.exec);
      }
      base = { id: c.id, digest: c.digest };
      if (c.name !== name) {
        // A copy under a new name: the frontmatter name follows the draft.
        const md = readFileSync(join(staging, 'SKILL.md'), 'utf8').replace(/^(---\r?\n[\s\S]*?^name:\s*).*$/m, `$1${name}`);
        atomicWrite(join(staging, 'SKILL.md'), md);
        base = null;
      }
    } else {
      const desc = (description ?? 'Describe what this skill does and when an agent should use it.').replace(/\n/g, ' ');
      atomicWrite(join(staging, 'SKILL.md'), `---\nname: ${name}\ndescription: ${JSON.stringify(desc)}\n---\n\n# ${name}\n\nSteps the agent follows.\n`);
    }
    renameSync(staging, dir);
    atomicWrite(draftMetaPath(ctx, name), `${JSON.stringify({ name, base, createdAt: new Date().toISOString() } satisfies DraftMeta, null, 2)}\n`);
  } catch (err) {
    rmSync(staging, { recursive: true, force: true });
    throw err;
  }
  return getDraft(ctx, name);
}

export function writeDraftFile(ctx: LifecycleContext, name: string, path: string, content: string, exec?: boolean): Draft {
  const dir = draftDir(ctx, name);
  if (!existsSync(dir)) throw new LifecycleError(404, `no draft ${name}`);
  const rel = safeRel(path);
  if (Buffer.byteLength(content) > DRAFT_LIMIT_BYTES) throw new LifecycleError(413, 'a file edited in the app is at most 512 KB');
  const target = join(dir, ...rel.split('/'));
  if (!within(dir, target)) throw new LifecycleError(400, 'path leaves the draft');
  assertNoLinks(dir, target);
  const prevExec = existsSync(target) ? (lstatSync(target).mode & 0o111) !== 0 : false;
  atomicWrite(target, content, exec ?? prevExec);
  return getDraft(ctx, name);
}

export function readDraftFile(ctx: LifecycleContext, name: string, path: string): { path: string; size: number; kind: 'text' | 'binary'; content: string | null; truncated: boolean } {
  const dir = draftDir(ctx, name);
  const rel = safeRel(path);
  const target = join(dir, ...rel.split('/'));
  if (!within(dir, target) || !existsSync(target)) throw new LifecycleError(404, `no file ${rel} in draft ${name}`);
  assertNoLinks(dir, target);
  const buf = readFileSync(target);
  const text = isText(buf);
  return { path: rel, size: buf.length, kind: text ? 'text' : 'binary', content: text ? buf.subarray(0, DRAFT_LIMIT_BYTES).toString('utf8') : null, truncated: buf.length > DRAFT_LIMIT_BYTES };
}

export function deleteDraftFile(ctx: LifecycleContext, name: string, path: string): Draft {
  const dir = draftDir(ctx, name);
  const rel = safeRel(path);
  if (rel === 'SKILL.md') throw new LifecycleError(400, 'SKILL.md is required; edit it instead');
  const target = join(dir, ...rel.split('/'));
  if (!within(dir, target) || !existsSync(target)) throw new LifecycleError(404, `no file ${rel} in draft ${name}`);
  assertNoLinks(dir, target);
  rmSync(target);
  return getDraft(ctx, name);
}

export function deleteDraft(ctx: LifecycleContext, name: string): void {
  const dir = draftDir(ctx, name);
  if (!existsSync(dir)) throw new LifecycleError(404, `no draft ${name}`);
  assertNoLinks(ctx.draftsDir, dir);
  rmSync(dir, { recursive: true, force: true });
  rmSync(draftMetaPath(ctx, name), { force: true });
}

// ---- previews ----

interface Target { files: Map<string, { data: Buffer; exec: boolean }> | null; policy: Policy | null; targetPath: string | null }

function readPackage(c: Candidate): Map<string, { data: Buffer; exec: boolean }> {
  return new Map(c.packageFiles.map((f) => [f.path, { data: readFileSync(f.abs), exec: f.exec }]));
}

function readDir(dir: string): Map<string, { data: Buffer; exec: boolean }> {
  const scan = scanPackage(dir);
  if (!scan.ok) throw new LifecycleError(422, scan.error);
  return new Map(scan.files.map((f) => [f.path, { data: readFileSync(f.abs), exec: f.exec }]));
}

function fileDiffs(before: Map<string, { data: Buffer; exec: boolean }>, after: Map<string, { data: Buffer; exec: boolean }>): FileDiff[] {
  const out: FileDiff[] = [];
  for (const p of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const a = before.get(p);
    const b = after.get(p);
    if (a && b && a.data.equals(b.data) && a.exec === b.exec) continue;
    const show = (x: { data: Buffer } | undefined) => (x ? (isText(x.data) ? x.data.toString('utf8') : `(binary, ${x.data.length} bytes)`) : null);
    let diff = unifiedDiff(p, show(a), show(b));
    if (a && b && a.exec !== b.exec) diff = `mode ${a.exec ? 'executable' : 'regular'} -> ${b.exec ? 'executable' : 'regular'}\n${diff}`;
    out.push({ path: p, change: !a ? 'added' : !b ? 'removed' : 'modified', diff: diff.slice(0, 200_000) });
  }
  return out;
}

function header(text: string | null): string {
  const lines = (text ?? '').split('\n');
  const head: string[] = [];
  for (const l of lines) { if (l.startsWith('#')) head.push(l); else break; }
  return head.length ? `${head.join('\n')}\n` : '# Skills assignment policy (docs/skills.md). Changed through `secondbrain skills` change review.\n';
}

export function dumpPolicy(p: Policy, previous: string | null): string {
  const clean: Record<string, unknown> = { version: 1, mode: p.mode };
  if (p.org.grant.length || p.org.deny.length) clean['org'] = p.org;
  if (Object.keys(p.teams).length) clean['teams'] = p.teams;
  if (Object.keys(p.agents).length) clean['agents'] = p.agents;
  if (Object.keys(p.lifecycle).length) clean['lifecycle'] = p.lifecycle;
  if (Object.keys(p.pins).length) clean['pins'] = p.pins;
  return `${header(previous)}${yaml.safeDump(clean, { lineWidth: 120, noRefs: true, sortKeys: false })}`;
}

function clonePolicy(p: Policy): Policy {
  return structuredClone(p);
}

function affectedAgents(ctx: LifecycleContext, name: string, policyAfter: Policy | null): string[] {
  const out = new Set<string>();
  const before = ctx.policy;
  const after = policyAfter ? parsePolicy(dumpPolicy(policyAfter, ctx.policy.text)) : before;
  for (const a of ctx.roster.agents) {
    const b = resolveAgent(a, before, ctx.catalog).get(name);
    const c = resolveAgent(a, after, ctx.catalog).get(name);
    const visible = (x: typeof b) => x?.state === 'assigned' || x?.state === 'legacy';
    if (visible(b) || visible(c)) out.add(a.name);
  }
  return [...out].sort();
}

export async function previewChange(ctx: LifecycleContext, req: ChangeRequest): Promise<{ preview: ChangePreview; target: Target; basePolicyDigest: string | null }> {
  const name = checkName(req.skill);
  const blocked: string[] = [];
  const warnings: string[] = ctx.observationsAvailable === false ? ['Machine acknowledgement state is unavailable; affected machines are unknown.'] : [];
  const p = ctx.policy.policy;
  const current = selectedCandidate(p, ctx.catalog, name).candidate;
  let target: Target = { files: null, policy: null, targetPath: null };
  let validation: Validation = { valid: true, errors: [], warnings: [] };
  let files: FileDiff[] = [];
  let targetDigest: string | null = null;
  let rollbackTarget: string | null = current?.digest ?? null;
  let summary = '';
  if (!ctx.policy.valid && req.kind !== 'create' && req.kind !== 'update' && req.kind !== 'rollback') blocked.push('the policy file does not parse; fix it before changing lifecycle state');

  const kind: ChangeKind = req.kind;
  if (kind === 'create' || kind === 'update') {
    if (!req.draft) throw new LifecycleError(400, `${kind} needs a draft`);
    const draft = getDraft(ctx, req.draft);
    if (req.draft !== name) blocked.push(`the draft is named ${req.draft}, the change is for ${name}`);
    validation = draft.validation;
    if (!validation.valid) blocked.push('the draft does not validate');
    const after = readDir(draftDir(ctx, req.draft));
    targetDigest = digestOf([...after].map(([path, f]) => ({ path, size: f.data.length, exec: f.exec, sha256: createSha(f.data) })));
    if (targetDigest !== draft.digest) blocked.push('the draft changed while previewing; retry the preview');
    if (kind === 'create') {
      const privateExisting = ctx.catalog.byName.get(name)?.find((c) => c.source === 'private');
      if (privateExisting) blocked.push(`${privateExisting.id} already exists; use update`);
      const others = ctx.catalog.byName.get(name) ?? [];
      if (others.length) warnings.push(`a private ${name} will override ${others.map((c) => c.id).join(', ')}`);
      files = fileDiffs(new Map(), after);
      target = { files: after, policy: null, targetPath: toPosix(relative(ctx.vaultRoot, join(ctx.privateRoot, name))) };
      summary = `Create the private skill ${name} from the draft (${after.size} files).`;
      rollbackTarget = null;
    } else {
      if (!current) throw new LifecycleError(404, `no skill ${name} to update; use create`);
      if (draft.base && draft.base.id !== current.id) blocked.push(`the draft was made from ${draft.base.id}, but ${name} now deploys ${current.id}`);
      if (draft.base && draft.base.digest !== current.digest) blocked.push(`${current.id} changed since the draft was made (draft base ${draft.base.digest?.slice(0, 19)}, now ${current.digest?.slice(0, 19)}); start a new draft`);
      if (!current.gitTop || !ctx.vaultRoot || current.gitTop !== (await gitTop(ctx.vaultRoot))) blocked.push(`${current.id} is not in the vault's repository; change it at its source (engine or external root) or create a private override`);
      files = fileDiffs(readPackage(current), after);
      if (!files.length) blocked.push('the draft is identical to the current package');
      target = { files: after, policy: null, targetPath: current.gitRel };
      summary = `Replace ${current.id} (${current.digest?.slice(0, 19)}...) with the draft (${targetDigest?.slice(0, 19)}...).`;
    }
  } else if (kind === 'rollback') {
    if (!req.revision) throw new LifecycleError(400, 'rollback needs a revision');
    if (!current) throw new LifecycleError(404, `no skill ${name}`);
    if (!current.gitTop || !current.gitRel) throw new LifecycleError(422, `${current.id} has no Git history to roll back to`);
    if (current.gitTop !== (await gitTop(ctx.vaultRoot))) blocked.push(`${current.id} is not in the vault's repository; roll it back at its source`);
    const full = await git(current.gitTop, ['rev-parse', '--verify', '--quiet', `${req.revision}^{commit}`]);
    if (!full) throw new LifecycleError(404, `no revision ${req.revision}`);
    const tree = await treeAt(current.gitTop, full.trim(), current.gitRel);
    if (!tree || !tree.length || !tree.some((t) => t.path === 'SKILL.md')) throw new LifecycleError(422, `${current.id} did not exist as a plain package at ${req.revision}`);
    const after = new Map<string, { data: Buffer; exec: boolean }>();
    for (const t of tree) {
      if (t.path.split('/').some((s) => s === '..' || isSecretLike(s))) throw new LifecycleError(422, `revision ${req.revision} has an unsafe path ${t.path}`);
      const data = await blob(current.gitTop, t.blob);
      if (!data) throw new LifecycleError(500, `could not read ${t.path} at ${req.revision}`);
      after.set(t.path, { data, exec: t.exec });
    }
    targetDigest = digestOf([...after].map(([path, f]) => ({ path, size: f.data.length, exec: f.exec, sha256: createSha(f.data) })));
    files = fileDiffs(readPackage(current), after);
    if (!files.length) blocked.push(`${current.id} already matches ${req.revision.slice(0, 12)}`);
    target = { files: after, policy: null, targetPath: current.gitRel };
    summary = `Roll ${current.id} back to its files at ${full.trim().slice(0, 12)} (${targetDigest.slice(0, 19)}...).`;
  } else {
    const next = clonePolicy(p);
    const life = lifecycleOf(p, name);
    if (!ctx.catalog.byName.has(name) && kind !== 'restore') blocked.push(`no skill ${name} in any root`);
    if (kind === 'disable') {
      if (life.status === 'disabled') blocked.push(`${name} is already disabled`);
      next.lifecycle[name] = { status: 'disabled', ...(req.note ? { note: req.note } : {}), since: today() };
      summary = `Disable ${name}: no new runs receive it; the package stays in its folder and history.`;
    } else if (kind === 'deprecate') {
      if (life.status === 'deprecated') blocked.push(`${name} is already deprecated`);
      if (req.replacement && !ctx.catalog.byName.has(req.replacement)) blocked.push(`replacement ${req.replacement} is not in any skill root`);
      next.lifecycle[name] = { status: 'deprecated', ...(req.replacement ? { replacement: req.replacement } : {}), ...(req.note ? { note: req.note } : {}), since: today() };
      summary = `Deprecate ${name}${req.replacement ? ` in favour of ${req.replacement}` : ''}: agents keep it, with a warning.`;
    } else if (kind === 'restore') {
      if (life.status === 'active') blocked.push(`${name} is already active`);
      delete next.lifecycle[name];
      summary = `Restore ${name} to active (was ${life.status}).`;
    } else if (kind === 'remove') {
      const grants = grantsOf(p, name);
      const deployments = ctx.observed.filter(o => o.skills.includes(name));
      if (deployments.length && !req.resolve) blocked.push(`still deployed on ${deployments.map(o => `${o.host}/${o.agent}/${o.runtime}`).join(', ')}; explicitly confirm revoking managed deployments with this change`);
      const deps = dependentsOf(ctx.catalog, name, ctx.policy.policy);
      if (deps.length) blocked.push(`skills that depend on ${name}: ${deps.join(', ')}; change them first`);
      if (grants.length && !req.resolve) blocked.push(`still granted or pinned by ${grants.join(', ')}; revoke those grants first or confirm revoking them with this change`);
      if (grants.length && req.resolve) {
        for (const scope of [next.org, ...Object.values(next.teams), ...Object.values(next.agents)]) {
          // Resolve just this skill without removing a wildcard's grants to every other skill.
          if (scope.grant.includes('*') && !scope.deny.includes(name)) scope.deny.push(name);
          scope.grant = scope.grant.filter((n) => n !== name);
        }
        delete next.pins[name];
      }
      next.lifecycle[name] = { status: 'removed', ...(req.note ? { note: req.note } : {}), since: today() };
      summary = `Remove ${name} from managed deployments${grants.length && req.resolve ? ` and revoke ${grants.join(', ')}` : ''}. The package files and their Git history are kept; machines delete only the copies the manager deployed.`;
    }
    if (ctx.policy.mode === 'legacy') warnings.push('the policy is in legacy mode: this lifecycle state is recorded but runtimes keep loading every skill until `mode: managed`');
    target = { files: null, policy: next, targetPath: null };
  }

  const policyDiff = target.policy ? unifiedDiff(ctx.policyRel, ctx.policy.text, dumpPolicy(target.policy, ctx.policy.text)) : '';
  const agents = affectedAgents(ctx, name, target.policy);
  const hosts = [...new Set(ctx.observed.filter((o) => o.skills.includes(name) || agents.includes(o.agent)).map((o) => o.host))].sort();
  validation = { ...validation, warnings: [...validation.warnings, ...warnings] };
  const preview: ChangePreview = {
    kind, skill: name, summary, validation, files, policyDiff, targetDigest, baseDigest: current?.digest ?? null, baseRevision: current?.revision ?? null,
    affectedAgents: agents, affectedHosts: hosts, dependents: dependentsOf(ctx.catalog, name, ctx.policy.policy), blocked, runningSessions: RUNNING_SESSIONS, rollbackTarget,
  };
  return { preview, target, basePolicyDigest: ctx.policy.digest };
}

function createSha(b: Buffer): string { return createHash('sha256').update(b).digest('hex'); }
function today(): string { return new Date().toISOString().slice(0, 10); }

// ---- proposed changes ----

interface StoredChange {
  id: string; kind: ChangeKind; skill: string; createdAt: string; request: ChangeRequest;
  basePolicyDigest: string | null; targetPath: string | null; hasPackage: boolean; hasPolicy: boolean;
  branch: string | null; commit: string | null; preview: ChangePreview;
}

const CHANGE_ID = /^\d{8}-\d{6}-[a-z]+-[a-z0-9._-]{1,64}-[0-9a-f]{6}$/;

function changeDir(ctx: LifecycleContext, id: string): string {
  if (!CHANGE_ID.test(id)) throw new LifecycleError(400, `bad change id ${id}`);
  return join(ctx.changesDir, id);
}

export async function proposeChange(ctx: LifecycleContext, req: ChangeRequest): Promise<Change> {
  const { preview, target, basePolicyDigest } = await previewChange(ctx, req);
  if (req.expectedDraftDigest && req.expectedDraftDigest !== preview.targetDigest) throw new LifecycleError(409, 'The draft changed after preview; preview the new draft before exporting.');
  if (preview.blocked.length) throw new LifecycleError(409, `not exported: ${preview.blocked.join('; ')}`);
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const id = `${stamp}-${req.kind}-${req.skill}-${randomBytes(3).toString('hex')}`;
  const dir = changeDir(ctx, id);
  mkdirSync(ctx.changesDir, { recursive: true });
  assertNoLinks(ctx.changesDir, dir);
  const staging = mkdtempSync(join(ctx.changesDir, '.new-'));
  try {
    if (target.files) for (const [p, f] of target.files) atomicWrite(join(staging, 'package', ...p.split('/')), f.data, f.exec);
    if (target.policy) atomicWrite(join(staging, 'policy.yaml'), dumpPolicy(target.policy, ctx.policy.text));
    const stored: StoredChange = {
      id, kind: req.kind, skill: req.skill, createdAt: new Date().toISOString(), request: req, basePolicyDigest,
      targetPath: target.targetPath, hasPackage: !!target.files, hasPolicy: !!target.policy, branch: null, commit: null, preview,
    };
    atomicWrite(join(staging, 'change.json'), `${JSON.stringify(stored, null, 2)}\n`);
    renameSync(staging, dir);
  } catch (err) {
    rmSync(staging, { recursive: true, force: true });
    throw err;
  }
  return toChange(ctx, readStored(ctx, id));
}

function readStored(ctx: LifecycleContext, id: string): StoredChange {
  const dir = changeDir(ctx, id);
  try { return JSON.parse(readFileSync(join(dir, 'change.json'), 'utf8')) as StoredChange; } catch { throw new LifecycleError(404, `no change ${id}`); }
}

function toChange(ctx: LifecycleContext, s: StoredChange): Change {
  const current = selectedCandidate(ctx.policy.policy, ctx.catalog, s.skill).candidate;
  let status: Change['status'] = s.branch ? 'branch' : 'proposed';
  const packageLive = !s.hasPackage || (current?.digest === s.preview.targetDigest);
  const policyLive = !s.hasPolicy || (() => {
    try { return parsePolicy(readFileSync(join(changeDir(ctx, s.id), 'policy.yaml'), 'utf8')).digest === ctx.policy.digest; } catch { return false; }
  })();
  if (!s.branch && s.kind === 'create' && s.targetPath && occupied(join(ctx.vaultRoot, s.targetPath))) status = 'stale';
  else if (packageLive && policyLive) status = 'live';
  else if (!s.branch && ((s.hasPackage && s.kind !== 'create' && current?.digest !== s.preview.baseDigest) || (s.hasPolicy && ctx.policy.digest !== s.basePolicyDigest))) status = 'stale';
  return { id: s.id, kind: s.kind, skill: s.skill, createdAt: s.createdAt, status, branch: s.branch, commit: s.commit, preview: s.preview };
}

function occupied(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

export function listChanges(ctx: LifecycleContext): Change[] {
  if (!existsSync(ctx.changesDir)) return [];
  return readdirSync(ctx.changesDir).filter((n) => CHANGE_ID.test(n)).sort().reverse().map((id) => {
    try { return toChange(ctx, readStored(ctx, id)); } catch { return null; }
  }).filter((c): c is Change => c !== null);
}

/**
 * Commit a proposed change on a new branch `skills/<id>` through a temporary worktree. The owner's
 * checkout and its branch are not touched; nothing is pushed or merged. The result is a branch for the
 * vault's normal review; the change goes live when that branch is merged and machines sync.
 */
export async function applyChange(ctx: LifecycleContext, id: string, opts: { message?: string } = {}): Promise<{ branch: string; commit: string; worktreeFiles: string[] }> {
  const stored = readStored(ctx, id);
  if (stored.kind === 'remove') {
    const current = await previewChange(ctx, stored.request);
    if (current.preview.blocked.length) throw new LifecycleError(409, `not applied: ${current.preview.blocked.join('; ')}`);
  }
  const change = toChange(ctx, stored);
  if (stored.branch) throw new LifecycleError(409, `already on branch ${stored.branch} (${stored.commit})`);
  if (change.status === 'stale') throw new LifecycleError(409, 'the change is stale: its base package or policy moved since it was proposed; propose it again');
  if (change.status === 'live') throw new LifecycleError(409, 'the vault already matches this change');
  const top = await gitTop(ctx.vaultRoot);
  if (!top) throw new LifecycleError(422, 'the vault is not a Git repository; copy the change by hand');
  const branch = `skills/${id}`;
  if (await git(top, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])) throw new LifecycleError(409, `branch ${branch} already exists`);
  const wt = mkdtempSync(join(tmpdir(), 'sb-skills-apply-'));
  rmSync(wt, { recursive: true, force: true });
  if ((await git(top, ['worktree', 'add', '--quiet', '-b', branch, wt, 'HEAD'], 60_000)) === null) throw new LifecycleError(500, 'git worktree add failed');
  const touched: string[] = [];
  try {
    const dir = changeDir(ctx, id);
    const vaultRelToTop = toPosix(relative(top, ctx.vaultRoot));
    const inTree = (rel: string) => join(wt, ...(vaultRelToTop ? vaultRelToTop.split('/') : []), ...rel.split('/'));
    if (stored.hasPackage) {
      if (!stored.targetPath) throw new LifecycleError(500, 'change has a package but no target path');
      // targetPath is repo-relative for update/rollback (gitRel) and vault-relative for create.
      const dest = stored.kind === 'create' ? inTree(stored.targetPath) : join(wt, ...stored.targetPath.split('/'));
      if (!within(wt, dest)) throw new LifecycleError(400, 'target leaves the repository');
      if (stored.kind === 'create') {
        // Check both the live source and new Git worktree, then claim the destination exclusively.
        if (occupied(join(ctx.vaultRoot, stored.targetPath)) || occupied(dest)) throw new LifecycleError(409, 'create destination is occupied; propose the change again');
        mkdirSync(dirname(dest), { recursive: true });
        try { mkdirSync(dest); }
        catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw new LifecycleError(409, 'create destination already exists');
          throw err;
        }
      } else rmSync(dest, { recursive: true, force: true });
      const src = join(dir, 'package');
      const scan = scanPackage(src);
      if (!scan.ok) throw new LifecycleError(422, `stored package: ${scan.error}`);
      if (scan.digest !== stored.preview.targetDigest) throw new LifecycleError(409, 'the stored package does not match its previewed digest; it was edited after export');
      for (const f of scan.files) atomicWrite(join(dest, ...f.path.split('/')), readFileSync(f.abs), f.exec);
      const check = scanPackage(dest);
      if (!check.ok || check.digest !== stored.preview.targetDigest) throw new LifecycleError(500, 'written package digest does not match the preview');
      touched.push(toPosix(relative(wt, dest)));
    }
    if (stored.hasPolicy) {
      const dest = inTree(ctx.policyRel);
      atomicWrite(dest, readFileSync(join(dir, 'policy.yaml')));
      touched.push(toPosix(relative(wt, dest)));
    }
    if ((await git(wt, ['add', '-A', '--', ...touched])) === null) throw new LifecycleError(500, 'git add failed');
    const msg = opts.message ?? `skills(${stored.skill}): ${stored.kind}\n\n${stored.preview.summary}\nChange ${id}; target ${stored.preview.targetDigest ?? 'policy only'}.`;
    if ((await git(wt, ['commit', '-q', '-m', msg], 60_000)) === null) throw new LifecycleError(500, 'git commit failed (is user.name/user.email set?)');
    const commit = ((await git(wt, ['rev-parse', 'HEAD'])) ?? '').trim();
    stored.branch = branch;
    stored.commit = commit;
    atomicWrite(join(dir, 'change.json'), `${JSON.stringify(stored, null, 2)}\n`);
    return { branch, commit, worktreeFiles: touched };
  } catch (err) {
    // Failure leaves nothing behind: no worktree, no half-made branch.
    await git(top, ['worktree', 'remove', '--force', wt], 60_000);
    rmSync(wt, { recursive: true, force: true });
    await git(top, ['branch', '-D', branch]);
    throw err;
  } finally {
    if (existsSync(wt)) {
      await git(top, ['worktree', 'remove', '--force', wt], 60_000);
      rmSync(wt, { recursive: true, force: true });
    }
    await git(top, ['worktree', 'prune']);
  }
}
