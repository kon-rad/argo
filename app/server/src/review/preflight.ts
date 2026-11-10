import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { command, childEnv } from './process.js';
import { Plan, invalidPlan, validatePlan } from './plan.js';
import { ChangedFile, PathError, checkImport, collectCode, immediateImports, pathProblem, reviewable } from './scope.js';
import { CapacityError, evaluate, ScopeConfig, scopeObservation, type Reason, type ScopeResult } from './policy.js';

export type PreflightInput = { mode: 'forecast' | 'actual'; repository: string; base: string; head?: string; plan: unknown; config?: Partial<ScopeConfig>; contextSources?: { ref: string; chars: number }[] };
/** Git object reads only. No fetch, checkout, repo hooks, ambient Git config or application configuration. */
export async function preflight(input: PreflightInput): Promise<ScopeResult> {
  const result = await inspect(input);
  return { ...result, binding: { base: input.base, ...(input.head ? {head: input.head} : {}),
    planHash: createHash('sha256').update(JSON.stringify(input.plan) ?? 'null').digest('hex') } };
}
async function inspect(input: PreflightInput): Promise<ScopeResult> {
  const validation = validatePlan(input.plan, input.config);
  if (validation.status === 'invalid') return { ...validation, phase: input.mode };
  const p = Plan.parse(input.plan), config = ScopeConfig.parse(input.config ?? {});
  const fail = (code: string, action: string) => invalidPlan(input.mode, [{ code, action }], config);
  if (!/^[a-f0-9]{40}$/.test(input.base) || p.base !== input.base || input.mode === 'actual' && !/^[a-f0-9]{40}$/.test(input.head ?? '')) return fail('revision', 'Supply full base/head commit IDs and the admitted plan base.');
  if (input.mode === 'actual' && (!Array.isArray(input.contextSources) || input.contextSources.some(s => !s.ref || !Number.isSafeInteger(s.chars) || s.chars < 0))) return fail('context-measurement', 'Supply measured current non-code evidence as contextSources (an explicit empty list is allowed).');
  const contextChars = input.contextSources?.reduce((n,s) => n+s.chars,0) ?? 0;
  const contextMax = Math.max(0,...(input.contextSources ?? []).map(s => s.chars));
  try {
    const cwd = await realpath(input.repository);
    const git = (args: string[]) => command('/usr/bin/git', ['--no-optional-locks', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], cwd, childEnv(cwd), 120_000, 8_000_000);
    const resolveCommit = async (revision: string) => (await git(['rev-parse', '--verify', `${revision}^{commit}`])).trim();
    if (await resolveCommit(input.base) !== input.base) return fail('revision', 'Base must be an existing local commit.');
    if (input.mode === 'forecast') {
      const tracked = new Set((await git(['ls-tree', '-rz', '--name-only', input.base])).split('\0').filter(Boolean));
      const enriched = structuredClone(p);
      for (const file of enriched.files) {
        const oldPath = file.previousPath ?? file.path;
        if (file.status !== 'added' && !tracked.has(oldPath)) return fail('missing-path', `Planned existing path ${oldPath} is absent at the base revision.`);
        if (!tracked.has(oldPath) || !reviewable(file.path)) continue;
        const text = await git(['show', `${input.base}:${oldPath}`]);
        file.sourceChars = Math.max(file.sourceChars, text.length);
        if (file.status === 'removed') continue;
        for (const path of immediateImports(oldPath, text, tracked)) {
          checkImport(path, config.exclude);
          const sourceChars = (await git(['show', `${input.base}:${path}`])).length;
          const declared = file.imports.find(i => i.path === path);
          if (declared) declared.sourceChars = Math.max(sourceChars, declared.sourceChars);
          else file.imports.push({ path, sourceChars });
        }
      }
      for (const test of p.tests) for (const path of test.paths) {
        if (!enriched.files.some(f => f.path === path && f.status !== 'removed') && !tracked.has(path)) return fail('missing-test', `Test ${test.id} references missing path ${path}; declare its addition or name an existing test.`);
      }
      return validatePlan(enriched, config);
    }
    if (await resolveCommit(input.head!) !== input.head) return fail('revision', 'Head must be an existing local commit.');
    if ((await git(['rev-parse', 'HEAD'])).trim() !== input.head || (await git(['status', '--porcelain=v1', '--untracked-files=all'])).trim()) return fail('dirty-worktree', 'Commit the complete intended diff and use the clean current HEAD before submission.');
    await git(['merge-base', '--is-ancestor', input.base, input.head!]);
    const parts = (await git(['diff', '--name-status', '-z', '--find-renames', input.base, input.head!, '--'])).split('\0');
    const files: ChangedFile[] = [];
    for (let i = 0; i < parts.length && parts[i];) {
      const status = parts[i++]!, first = parts[i++]!;
      const kind = { A: 'added', M: 'modified', D: 'removed', R: 'renamed', C: 'copied', T: 'changed' }[status[0]!] as ChangedFile['status'] | undefined;
      if (!kind) return fail('diff-status', 'Unsupported Git change status; reconcile the diff before submission.');
      files.push(ChangedFile.parse({ path: /^[RC]/.test(status) ? parts[i++] : first, status: kind, ...(/^[RC]/.test(status) ? { previousPath: first } : {}) }));
    }
    for (const f of files) for (const path of [f.path, ...(f.previousPath ? [f.previousPath] : [])]) {
      const problem = pathProblem(path, config.exclude);
      if (problem) return invalidPlan('actual', [{code:'excluded-path',path,action:problem}], config);
    }
    const diff = await git(['diff', '--no-ext-diff', '--no-textconv', '--binary', input.base, input.head!, '--']);
    const tracked = new Set((await git(['ls-tree', '-rz', '--name-only', input.head!])).split('\0').filter(Boolean));
    const drift: Reason[] = files.filter(f => !p.files.some(expected => expected.path === f.path && expected.status === f.status && expected.previousPath === f.previousPath))
      .map(f => ({ code: 'unplanned-path', path: f.path, action: 'Revise the admitted plan to include this change and its requirements/tests, then rerun both checkpoints.' }));
    for (const f of p.files) if (!files.some(actual => actual.path === f.path)) drift.push({code:'missing-planned-path',path:f.path,action:'Account for omitted scope against every acceptance requirement and revise the plan before submission.'});
    let result: ScopeResult;
    try {
      const code = await collectCode(files, input.head!, input.base, tracked, (r, path) => git(['show', `${r}:${path}`]), config.exclude);
      const observed = scopeObservation(files, code, diff, undefined, contextChars);
      observed.sourceChars = Math.max(observed.sourceChars, contextMax);
      result = evaluate(observed, 'actual', config);
    } catch (error) {
      if (!(error instanceof CapacityError)) throw error;
      // Capacity failures carry measured observations. Collection was deliberately stopped at the hard boundary.
      const measured = error.result;
      result = evaluate({ ...measured.observations, diffChars: diff.length,
        sourceChars: Math.max(measured.observations.sourceChars,contextMax), combinedChars: measured.observations.combinedChars + diff.length + contextChars }, 'actual', config);
      result.reasons.push({ code: 'collection-stopped', action: 'Source collection stopped at a hard boundary; remaining source sizes are unmeasured. Decompose and rerun.' });
      result.status = 'decompose';
    }
    if (drift.length) { result.reasons.push(...drift); result.status = 'decompose'; }
    return result;
  } catch (error) {
    if (error instanceof PathError) return invalidPlan(input.mode,[{code:'excluded-path',path:error.path,action:error.message}],config);
    return fail('collection-unavailable', 'Unable to safely read local revision evidence. Check repository, object availability, excluded paths and Git output limits; rerun before building/submitting.');
  }
}

/** Public coordinator contract. A request is data, never a shell command or authority grant. */
export async function scopeMain(args: string[]): Promise<number> {
  const { z } = await import('zod');
  const { readFile, stat } = await import('node:fs/promises');
  const { POLICY, policyHash } = await import('./policy.js');
  const emit = (result: ScopeResult) => { console.log(JSON.stringify(result)); return result.status === 'pass' ? 0 : result.status === 'decompose' ? 2 : 1; };
  const [mode, requestPath, configPath] = args;
  if (mode === 'policy' && args.length === 1) { console.log(JSON.stringify({ policyVersion: POLICY.version, policyHash, limits: POLICY, config: ScopeConfig.parse({}) })); return 0; }
  if (mode === 'schema' && args.length === 1) { console.log(JSON.stringify(z.toJSONSchema(Plan))); return 0; }
  const phase = mode === 'actual' ? 'actual' : 'forecast';
  try {
    if (!['forecast', 'actual'].includes(mode ?? '') || !requestPath || args.length > 3) throw new Error('usage');
    const readJSON = async (path: string) => {
      if (!path.endsWith('.json') || (await stat(path)).size > 1_000_000) throw new Error('input');
      return JSON.parse(await readFile(path, 'utf8')) as unknown;
    };
    const config = ScopeConfig.parse(configPath ? await readJSON(configPath) : {});
    const request = z.object({ repository: z.string().min(1), base: z.string(), head: z.string().optional(), plan: z.unknown().optional(),
      contextSources: z.array(z.object({ref:z.string().min(1),chars:z.number().int().nonnegative()}).strict()).optional() }).strict().parse(await readJSON(requestPath));
    return emit(await preflight({ ...request, plan: request.plan, mode: phase, config }));
  } catch {
    return emit(invalidPlan(phase, [{ code: 'request', action: 'Usage: review scope policy|schema or review scope forecast|actual request.json [owner-scope.json]. Supply readable bounded JSON, a version 1 plan and valid owner config.' }]));
  }
}
