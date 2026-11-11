import { mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { childEnv, command } from '../review/process.js';
import { admit, failure, Contract, Sha, VerificationPolicy } from './contract.js';
import { activationPending, evaluate, integrations, RunnerEvidence, type Collected, type Decision, type IntegrationStatus, type JobInfo, type RunInfo } from './evidence.js';

/** Everything the coordinator reads, obtained by itself. Nothing comes from builder output or PR-supplied URLs. */
export interface VerificationSource {
  runs(head: string): Promise<RunInfo[]>;
  jobs(runId: number): Promise<JobInfo[]>;
  /** The configured artifact of exactly this run: evidence.json plus the logs it names. */
  artifact(runId: number, name: string, maxBytes: number): Promise<{ evidence: unknown; logs: Record<string, Buffer> } | null>;
  file(revision: string, path: string): Promise<string | null>;
}

async function files(src: VerificationSource, policy: VerificationPolicy, revision: string): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  for (const path of new Set([policy.contractPath, ...Object.keys(policy.trustedFiles)])) out[path] = await src.file(revision, path);
  const parsed = Contract.safeParse((() => { try { return JSON.parse(out[policy.contractPath] ?? ''); } catch { return null; } })());
  if (parsed.success) for (const i of parsed.data.externalIntegrations) for (const a of i.assumptions) for (const e of a.evidence) {
    if (e.kind === 'observed-response' && !(e.path in out)) out[e.path] = await src.file(revision, e.path);
  }
  return out;
}

export async function collect(src: VerificationSource, policy: VerificationPolicy, head: string): Promise<Collected> {
  const tracked = await files(src, policy, head);
  const runs = (await src.runs(head)).filter(r => r.head_sha === head && r.path.replace(/@.*$/, '') === policy.workflow.path && (policy.workflow.events as string[]).includes(r.event));
  const run = runs.sort((a, b) => b.id - a.id)[0] ?? null;
  if (!run) return { run: null, jobs: [], evidence: null, logs: {}, files: tracked };
  const jobs = await src.jobs(run.id);
  const artifact = run.status === 'completed' ? await src.artifact(run.id, policy.workflow.artifact, policy.maxArtifactBytes) : null;
  return { run, jobs, evidence: artifact?.evidence ?? null, logs: artifact?.logs ?? {}, files: tracked };
}

/** Collection errors are evidence failures for the verifier, never a pass and never a builder assertion. */
export async function verifyHead(src: VerificationSource, policy: VerificationPolicy, head: string): Promise<Decision> {
  try { return evaluate(policy, head, await collect(src, policy, head)); }
  catch (error) {
    const f = failure('evidence', 'collection-failed', `could not collect verification evidence: ${error instanceof Error ? error.message.slice(0, 200) : 'unknown error'}`);
    return { status: 'fail', head, failures: [f], integrations: [], record: { head, contractHash: null, workflow: policy.workflow.path, runId: null, runAttempt: null, runner: null, checks: [], failures: [f], integrations: [] } };
  }
}

/** Integrations declared at a merged revision. Unparseable contracts make nothing complete. */
export async function integrationsAt(src: VerificationSource, policy: VerificationPolicy, revision: string): Promise<IntegrationStatus[] | null> {
  const f = await files(src, policy, revision), admission = admit(f[policy.contractPath] ?? null, policy);
  // Off state is proven pre-merge from trusted evidence; after merge only the support level matters.
  return admission.contract ? integrations(admission.contract, f, new Set()) : null;
}

/** Owner-registered program: `<argv> activation <revision> <integration>` prints one JSON receipt. */
export async function activation(policy: VerificationPolicy, home: string, revision: string, ints: IntegrationStatus[] | null): Promise<string[]> {
  if (!ints) return ['activation-pending: contract at the merged revision is unreadable'];
  const receipts: Record<string, unknown> = {};
  for (const i of ints.filter(x => x.status === 'supported')) {
    if (!policy.activation) continue;
    try { receipts[i.id] = JSON.parse(await command(policy.activation.argv[0]!, [...policy.activation.argv.slice(1), 'activation', revision, i.id], policy.activation.cwd, childEnv(home), 120_000, 100_000)); }
    catch { /* no receipt: stays pending */ }
  }
  return activationPending(ints, revision, receipts);
}

const Run = z.object({ id: z.number(), head_sha: z.string(), path: z.string(), event: z.string(), status: z.string(), conclusion: z.string().nullable(), run_attempt: z.number().optional() }).passthrough();
const Job = z.object({ name: z.string(), conclusion: z.string().nullable(), runner_group_name: z.string().nullable(), labels: z.array(z.string()) }).passthrough();
const LOG = /^logs\/[a-z][a-z0-9-]{0,39}\.log$/;

/** Real source: the configured repository through `gh`, Git objects from the coordinator's trusted repository. */
export class GitHubVerificationSource implements VerificationSource {
  constructor(private readonly gh: (args: string[]) => Promise<string>, private readonly git: (args: string[]) => Promise<string>, private readonly repo: string) {}
  async runs(head: string): Promise<RunInfo[]> {
    const body = JSON.parse(await this.gh(['api', `repos/${this.repo}/actions/runs?head_sha=${Sha.parse(head)}&per_page=100`]));
    return z.array(Run).parse(body.workflow_runs);
  }
  async jobs(runId: number): Promise<JobInfo[]> {
    return z.array(Job).parse(JSON.parse(await this.gh(['api', `repos/${this.repo}/actions/runs/${runId}/jobs?filter=latest&per_page=100`])).jobs);
  }
  async artifact(runId: number, name: string, maxBytes: number): Promise<{ evidence: unknown; logs: Record<string, Buffer> } | null> {
    const list = z.array(z.object({ name: z.string(), size_in_bytes: z.number(), expired: z.boolean(), workflow_run: z.object({ id: z.number() }).passthrough().nullable() }).passthrough())
      .parse(JSON.parse(await this.gh(['api', `repos/${this.repo}/actions/runs/${runId}/artifacts?name=${encodeURIComponent(name)}`])).artifacts)
      .filter(a => a.name === name && !a.expired && a.workflow_run?.id === runId);
    if (list.length !== 1 || list[0]!.size_in_bytes > maxBytes) return null;
    const dir = await mkdtemp(join(tmpdir(), 'verification-'));
    try {
      await this.gh(['run', 'download', String(runId), '--repo', this.repo, '--name', name, '--dir', dir]);
      const root = await realpath(dir), read = async (rel: string) => {
        const path = await realpath(join(root, rel));
        if (!path.startsWith(root + '/') || (await stat(path)).size > maxBytes) throw new Error('artifact path escapes or is too large');
        return readFile(path);
      };
      const evidence: unknown = JSON.parse((await read('evidence.json')).toString('utf8'));
      const logs: Record<string, Buffer> = {};
      const parsed = RunnerEvidence.safeParse(evidence);
      for (const c of parsed.success ? parsed.data.checks : []) if (c.log && LOG.test(c.log.path)) { try { logs[c.log.path] = await read(c.log.path); } catch { /* missing log is judged later */ } }
      return { evidence, logs };
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
  async file(revision: string, path: string): Promise<string | null> {
    try { return await this.git(['show', `${Sha.parse(revision)}:${path}`]); } catch { return null; }
  }
}

async function ownerJSON(path: string): Promise<unknown> {
  const info = await stat(path);
  if (!path.startsWith('/') || !path.endsWith('.json') || info.size > 1_000_000 || (info.mode & 0o022) || (info.uid !== process.getuid?.() && info.uid !== 0)) throw new Error('policy must be an owner-owned, non-writable-by-others absolute JSON file');
  return JSON.parse(await readFile(path, 'utf8'));
}

/**
 * Coordinator hook (generic; a private runner calls this):
 *   verify admit <request.json> <policy.json>   before builder launch; request {"repository":"/abs/repo","revision":"<sha>"}
 *   verify check <request.json> <policy.json>   after CI; request {"github":"owner/name","gitDir":"/abs/repo.git","head":"<sha>","gh":"/abs/gh","git":"/abs/git","home":"/abs/home"}
 * Exit: 0 admitted/pass, 1 invalid/fail, 3 verification infrastructure unavailable. Never executes repository checks.
 */
export async function verifyMain(args: string[]): Promise<number> {
  const [mode, requestPath, policyPath] = args;
  try {
    if (!['admit', 'check'].includes(mode ?? '') || !requestPath || !policyPath || args.length !== 3) throw new Error('usage');
    const policy = VerificationPolicy.parse(await ownerJSON(policyPath));
    const raw = JSON.parse(await readFile(requestPath, 'utf8')) as unknown;
    if (mode === 'admit') {
      const req = z.object({ repository: z.string().startsWith('/'), revision: Sha }).strict().parse(raw);
      const cwd = await realpath(req.repository);
      const text = await command('/usr/bin/git', ['--no-optional-locks', '-c', 'core.hooksPath=/dev/null', 'show', `${req.revision}:${policy.contractPath}`], cwd, childEnv(cwd), 30_000, 1_000_000).catch(() => null);
      const a = admit(text, policy);
      console.log(JSON.stringify({ status: a.status, contractHash: a.contractHash, capabilities: a.contract?.capabilities ?? [], failures: a.failures }));
      return a.status === 'admitted' ? 0 : a.status === 'unavailable' ? 3 : 1;
    }
    const req = z.object({ github: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/), gitDir: z.string().startsWith('/'), head: Sha,
      gh: z.string().startsWith('/'), git: z.string().startsWith('/'), home: z.string().startsWith('/') }).strict().parse(raw);
    const git = (a: string[]) => command(req.git, ['--git-dir', req.gitDir, '-c', 'core.hooksPath=/dev/null', ...a], req.home, childEnv(req.home, true));
    await git(['fetch', '--no-tags', `https://github.com/${req.github}.git`, req.head]);
    const d = await verifyHead(new GitHubVerificationSource(a => command(req.gh, a, req.home, childEnv(req.home, true), 300_000, 8_000_000), git, req.github), policy, req.head);
    console.log(JSON.stringify(d.record));
    return d.status === 'pass' ? 0 : d.failures.some(f => f.type === 'infrastructure') ? 3 : 1;
  } catch {
    console.log(JSON.stringify({ status: 'invalid', failures: [failure('contract', 'request', 'Usage: verify admit|check request.json /absolute/owner-policy.json with a valid version 1 policy')] }));
    return 1;
  }
}
