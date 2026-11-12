import { readFile, realpath, stat } from 'node:fs/promises';
import { z } from 'zod';
import { childEnv, command, commandBytes } from '../review/process.js';
import { admit, ALLOWED_PROBES, failure, Contract, Sha, VerificationPolicy, type Failure } from './contract.js';
import { activationPending, artifactLimit, artifactName, docOrigin, evaluate, integrations, offStatePending, RunnerEvidence,
  type Collected, type Decision, type IntegrationStatus, type JobInfo, type RunInfo } from './evidence.js';
import { readZip } from './zip.js';

/** Everything the coordinator reads, obtained by itself. Nothing comes from builder output or PR-supplied URLs. */
export interface VerificationSource {
  runs(head: string): Promise<RunInfo[]>;
  jobs(runId: number): Promise<JobInfo[]>;
  /** The configured artifact of exactly this run: evidence.json plus the logs and reports it names, read in memory. */
  artifact(runId: number, name: string, maxBytes: number): Promise<{ evidence: unknown; files: Record<string, Buffer> } | null>;
  file(revision: string, path: string): Promise<string | null>;
  /** Only called for URLs on installation-approved origins. */
  document(url: string): Promise<string | null>;
  /** Admission: is the configured workflow usable at all? */
  workflow(path: string): Promise<{ state: string } | null>;
  actionsEnabled(): Promise<boolean>;
  latestSuccess(path: string): Promise<RunInfo | null>;
}

async function tracked(src: VerificationSource, policy: VerificationPolicy, revision: string): Promise<{ files: Record<string, string | null>; documents: Record<string, string | null> }> {
  const files: Record<string, string | null> = {}, documents: Record<string, string | null> = {};
  for (const path of new Set([policy.contractPath, ...Object.keys(policy.trustedFiles)])) files[path] = await src.file(revision, path);
  const parsed = Contract.safeParse((() => { try { return JSON.parse(files[policy.contractPath] ?? ''); } catch { return null; } })());
  if (parsed.success) for (const i of parsed.data.externalIntegrations) for (const a of i.assumptions) for (const e of a.evidence) {
    if (e.kind === 'observed-response' && !(e.path in files)) files[e.path] = await src.file(revision, e.path);
    if (e.kind === 'documentation' && !(e.url in documents) && policy.externalEvidence.documentationOrigins.includes(docOrigin(e.url) ?? '')) {
      documents[e.url] = await src.document(e.url).catch(() => null);
    }
  }
  return { files, documents };
}

export async function collect(src: VerificationSource, policy: VerificationPolicy, head: string): Promise<Collected> {
  const { files, documents } = await tracked(src, policy, head);
  const runs = (await src.runs(head)).filter(r => r.head_sha === head && r.path.replace(/@.*$/, '') === policy.workflow.path && (policy.workflow.events as string[]).includes(r.event));
  const run = runs.sort((a, b) => b.id - a.id)[0] ?? null;
  if (!run) return { run: null, jobs: [], evidence: null, artifact: {}, files, documents };
  const jobs = await src.jobs(run.id);
  const artifact = run.status === 'completed' ? await src.artifact(run.id, policy.workflow.artifact, policy.maxArtifactBytes) : null;
  return { run, jobs, evidence: artifact?.evidence ?? null, artifact: artifact?.files ?? {}, files, documents };
}

/** Collection errors are evidence failures for the verifier, never a pass and never a builder assertion. */
export async function verifyHead(src: VerificationSource, policy: VerificationPolicy, head: string): Promise<Decision> {
  try { return evaluate(policy, head, await collect(src, policy, head)); }
  catch (error) {
    const f = failure('evidence', 'collection-failed', `could not collect verification evidence: ${error instanceof Error ? error.message.slice(0, 200) : 'unknown error'}`);
    return { status: 'fail', head, failures: [f], integrations: [], record: { head, contractHash: null, workflow: policy.workflow.path, runId: null, runAttempt: null, runner: null, isolation: null, checks: [], failures: [f], integrations: [] } };
  }
}

/**
 * Before a builder launches: the configured workflow is active, Actions is enabled, and a recent successful run of the
 * configured job on a GitHub-hosted runner produced evidence that proved isolation and every requested capability.
 */
export async function backendFailures(src: VerificationSource, policy: VerificationPolicy, capabilities: string[], now = Date.now()): Promise<Failure[]> {
  const down = (code: string, detail: string) => [failure('infrastructure', code, detail)];
  try {
    if (!(await src.actionsEnabled())) return down('actions-disabled', 'GitHub Actions is disabled for the repository');
    const wf = await src.workflow(policy.workflow.path);
    if (wf?.state !== 'active') return down('workflow-unavailable', `${policy.workflow.path} is ${wf?.state ?? 'missing'}`);
    const run = await src.latestSuccess(policy.workflow.path);
    const age = run?.created_at ? now - Date.parse(run.created_at) : Infinity;
    if (!run || !(age <= policy.backend.maxAgeDays * 86_400_000)) return down('no-recent-verifier-run', `no successful ${policy.workflow.path} run in the last ${policy.backend.maxAgeDays} days`);
    const job = (await src.jobs(run.id)).find(j => j.name === policy.workflow.job);
    if (!job || job.conclusion !== 'success' || job.runner_group_name !== policy.runner.group || job.labels.includes('self-hosted') || !job.labels.some(l => policy.runner.labels.includes(l))) {
      return down('untrusted-runner', `run ${run.id} has no successful GitHub-hosted "${policy.workflow.job}" job`);
    }
    const ev = RunnerEvidence.safeParse((await src.artifact(run.id, policy.workflow.artifact, policy.maxArtifactBytes))?.evidence);
    if (!ev.success || ev.data.preflight?.status !== 'ready' || !ev.data.isolation || ev.data.isolation.problems.length) return down('isolation-unproven', `run ${run.id} did not prove an isolated backend`);
    const missing = capabilities.filter(c => !ev.data.isolation!.provided.includes(c) || (ALLOWED_PROBES[c as keyof typeof ALLOWED_PROBES] && ev.data.isolation!.probes?.[ALLOWED_PROBES[c as keyof typeof ALLOWED_PROBES]!] !== 'allowed'));
    if (missing.length) return down('capability-unproven', `run ${run.id} did not prove ${missing.join(', ')}`);
    return [];
  } catch (error) {
    return down('backend-unreachable', `could not establish the verifier backend: ${error instanceof Error ? error.message.slice(0, 200) : 'unknown error'}`);
  }
}

/** Integrations declared at a revision. Unparseable contracts make nothing complete. */
export async function integrationsAt(src: VerificationSource, policy: VerificationPolicy, revision: string, passed: Set<string>): Promise<IntegrationStatus[] | null> {
  const t = await tracked(src, policy, revision), admission = admit(t.files[policy.contractPath] ?? null, policy);
  return admission.contract ? integrations(admission.contract, policy, t.files, t.documents, passed) : null;
}

async function receipts(policy: VerificationPolicy, home: string, items: { id: string; args: string[] }[]): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const { id, args } of items) {
    if (!policy.activation) continue;
    try { out[id] = JSON.parse(await command(policy.activation.argv[0]!, [...policy.activation.argv.slice(1), ...args], policy.activation.cwd, childEnv(home), 120_000, 100_000)); }
    catch { /* no receipt: stays pending */ }
  }
  return out;
}

/** Owner program: `<argv> off-state <target> <flag>` prints {"target","flag","enabled","evidenceSha256"}. */
export async function offState(policy: VerificationPolicy, home: string, target: string, ints: IntegrationStatus[] | null): Promise<string[]> {
  if (!ints) return ['off-state-unproven: contract is unreadable'];
  return offStatePending(ints, target, await receipts(policy, home, ints.filter(i => i.mergeDisabled).map(i => ({ id: i.id, args: ['off-state', target, i.flag] }))));
}

/** Owner program: `<argv> activation <revision> <integration>` prints one JSON receipt. */
export async function activation(policy: VerificationPolicy, home: string, revision: string, ints: IntegrationStatus[] | null): Promise<string[]> {
  if (!ints) return ['activation-pending: contract at the merged revision is unreadable'];
  return activationPending(ints, revision, await receipts(policy, home, ints.filter(i => i.status === 'supported').map(i => ({ id: i.id, args: ['activation', revision, i.id] }))));
}

const Run = z.object({ id: z.number(), head_sha: z.string(), path: z.string(), event: z.string(), status: z.string(), conclusion: z.string().nullable(), run_attempt: z.number().optional(), created_at: z.string().optional() }).passthrough();
const Job = z.object({ name: z.string(), conclusion: z.string().nullable(), runner_group_name: z.string().nullable(), labels: z.array(z.string()) }).passthrough();
const Artifact = z.object({ id: z.number(), name: z.string(), size_in_bytes: z.number(), expired: z.boolean(), workflow_run: z.object({ id: z.number() }).passthrough().nullable() }).passthrough();

/** Bounded https GET with no redirects, used only for installation-approved documentation origins. */
export async function fetchDocument(url: string, maxBytes = 2_000_000): Promise<string | null> {
  if (!url.startsWith('https://')) return null;
  const res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(15_000), headers: { accept: 'text/html,text/plain' } });
  if (!res.ok || !res.body) return null;
  const chunks: Buffer[] = []; let n = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) { n += chunk.length; if (n > maxBytes) return null; chunks.push(Buffer.from(chunk)); }
  return Buffer.concat(chunks).toString('utf8');
}

/** Real source: the configured repository through `gh`, Git objects from the coordinator's trusted repository. */
export class GitHubVerificationSource implements VerificationSource {
  constructor(private readonly gh: (args: string[]) => Promise<string>, private readonly ghBytes: (args: string[], maxBytes: number) => Promise<Buffer>,
    private readonly git: (args: string[]) => Promise<string>, private readonly repo: string, private readonly fetchDoc: (url: string) => Promise<string | null> = fetchDocument) {}
  async runs(head: string): Promise<RunInfo[]> {
    const body = JSON.parse(await this.gh(['api', `repos/${this.repo}/actions/runs?head_sha=${Sha.parse(head)}&per_page=100`]));
    return z.array(Run).parse(body.workflow_runs);
  }
  async jobs(runId: number): Promise<JobInfo[]> {
    return z.array(Job).parse(JSON.parse(await this.gh(['api', `repos/${this.repo}/actions/runs/${runId}/jobs?filter=latest&per_page=100`])).jobs);
  }
  async artifact(runId: number, name: string, maxBytes: number): Promise<{ evidence: unknown; files: Record<string, Buffer> } | null> {
    const list = z.array(Artifact).parse(JSON.parse(await this.gh(['api', `repos/${this.repo}/actions/runs/${runId}/artifacts?name=${encodeURIComponent(name)}`])).artifacts)
      .filter(a => a.name === name && !a.expired && a.workflow_run?.id === runId);
    if (list.length !== 1 || list[0]!.size_in_bytes > maxBytes) return null;
    // Downloaded into memory and inspected member by member; nothing is extracted to the coordinator's disk.
    const zip = await this.ghBytes(['api', `repos/${this.repo}/actions/artifacts/${list[0]!.id}/zip`], maxBytes);
    const members = readZip(zip, { maxEntries: 64, maxTotalBytes: maxBytes, allowed: artifactName, maxEntryBytes: artifactLimit });
    const evidence = members.get('evidence.json');
    if (!evidence) return null;
    members.delete('evidence.json');
    return { evidence: JSON.parse(evidence.toString('utf8')), files: Object.fromEntries(members) };
  }
  async file(revision: string, path: string): Promise<string | null> {
    try { return await this.git(['show', `${Sha.parse(revision)}:${path}`]); } catch { return null; }
  }
  document(url: string): Promise<string | null> { return this.fetchDoc(url); }
  async workflow(path: string): Promise<{ state: string } | null> {
    try { return z.object({ state: z.string() }).passthrough().parse(JSON.parse(await this.gh(['api', `repos/${this.repo}/actions/workflows/${encodeURIComponent(path.split('/').pop()!)}`]))); }
    catch { return null; }
  }
  async actionsEnabled(): Promise<boolean> {
    return z.object({ enabled: z.boolean() }).passthrough().parse(JSON.parse(await this.gh(['api', `repos/${this.repo}/actions/permissions`]))).enabled;
  }
  async latestSuccess(path: string): Promise<RunInfo | null> {
    const body = JSON.parse(await this.gh(['api', `repos/${this.repo}/actions/workflows/${encodeURIComponent(path.split('/').pop()!)}/runs?status=success&event=push&per_page=5`]));
    return z.array(Run).parse(body.workflow_runs).sort((a, b) => b.id - a.id)[0] ?? null;
  }
}

async function ownerJSON(path: string): Promise<unknown> {
  const info = await stat(path);
  if (!path.startsWith('/') || !path.endsWith('.json') || info.size > 1_000_000 || (info.mode & 0o022) || (info.uid !== process.getuid?.() && info.uid !== 0)) throw new Error('policy must be an owner-owned, non-writable-by-others absolute JSON file');
  return JSON.parse(await readFile(path, 'utf8'));
}

const Remote = { github: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/), gh: z.string().startsWith('/'), home: z.string().startsWith('/') };
const source = (req: { github: string; gh: string; home: string }, git: (a: string[]) => Promise<string>) => new GitHubVerificationSource(
  a => command(req.gh, a, req.home, childEnv(req.home, true), 300_000, 8_000_000), (a, max) => commandBytes(req.gh, a, req.home, childEnv(req.home, true), 300_000, max), git, req.github);

/**
 * Coordinator hook (generic; a private runner calls this):
 *   verify admit <request.json> <policy.json>   before builder launch; request {"repository":"/abs/repo","revision":"<sha>","github":"owner/name","gh":"/abs/gh","home":"/abs/home"}
 *   verify check <request.json> <policy.json>   after CI; request {"github":"owner/name","gitDir":"/abs/repo.git","head":"<sha>","gh":"/abs/gh","git":"/abs/git","home":"/abs/home"}
 * Exit: 0 admitted/pass, 1 invalid/fail, 3 verification infrastructure unavailable. Never executes repository checks.
 */
export async function verifyMain(args: string[], make: typeof source = source): Promise<number> {
  const [mode, requestPath, policyPath] = args;
  try {
    if (!['admit', 'check'].includes(mode ?? '') || !requestPath || !policyPath || args.length !== 3) throw new Error('usage');
    const policy = VerificationPolicy.parse(await ownerJSON(policyPath));
    const raw = JSON.parse(await readFile(requestPath, 'utf8')) as unknown;
    if (mode === 'admit') {
      const req = z.object({ repository: z.string().startsWith('/'), revision: Sha, ...Remote }).strict().parse(raw);
      const cwd = await realpath(req.repository);
      const git = (a: string[]) => command('/usr/bin/git', ['--no-optional-locks', '-c', 'core.hooksPath=/dev/null', ...a], cwd, childEnv(cwd), 30_000, 1_000_000);
      const a = admit(await git(['show', `${req.revision}:${policy.contractPath}`]).catch(() => null), policy);
      // A contract that is admissible still waits for a backend that can actually verify it.
      if (a.status === 'admitted') a.failures.push(...await backendFailures(make(req, git), policy, a.contract!.capabilities));
      const status = a.failures.some(f => f.type === 'contract') ? 'invalid' : a.failures.length ? 'unavailable' : 'admitted';
      console.log(JSON.stringify({ status, contractHash: a.contractHash, capabilities: a.contract?.capabilities ?? [], failures: a.failures }));
      return status === 'admitted' ? 0 : status === 'unavailable' ? 3 : 1;
    }
    const req = z.object({ gitDir: z.string().startsWith('/'), head: Sha, git: z.string().startsWith('/'), ...Remote }).strict().parse(raw);
    const git = (a: string[]) => command(req.git, ['--git-dir', req.gitDir, '-c', 'core.hooksPath=/dev/null', ...a], req.home, childEnv(req.home, true));
    await git(['fetch', '--no-tags', `https://github.com/${req.github}.git`, req.head]);
    const d = await verifyHead(make(req, git), policy, req.head);
    console.log(JSON.stringify(d.record));
    return d.status === 'pass' ? 0 : d.failures.some(f => f.type === 'infrastructure') ? 3 : 1;
  } catch {
    console.log(JSON.stringify({ status: 'invalid', failures: [failure('contract', 'request', 'Usage: verify admit|check request.json /absolute/owner-policy.json with a valid version 1 policy')] }));
    return 1;
  }
}
