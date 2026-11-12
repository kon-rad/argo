import { z } from 'zod';
import { ChangedFile, importProblem, pathProblem, reviewable } from './scope.js';
import { emptyObservation, evaluate, policyHash, ScopeConfig, type Reason, type ScopeResult } from './policy.js';

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const id = z.string().min(1);
const ids = z.array(id);
const sha = z.string().regex(/^[a-f0-9]{40}$/);
export const Plan = z.object({
  version: z.literal(1), policyHash: z.literal(policyHash), card: id, repository: id, base: sha,
  requirements: z.array(z.object({ id, description: id, tasks: ids.min(1), tests: ids.min(1) }).strict()).min(1),
  tasks: z.array(z.object({ id, requirements: ids.min(1), paths: ids.min(1), tests: ids.min(1), dependencies: ids }).strict()).min(1),
  tests: z.array(z.object({ id, requirements: ids.min(1), paths: ids.min(1), command: id }).strict()).min(1),
  dependencies: z.array(z.object({ id, revision: sha, verification: id }).strict()),
  files: z.array(ChangedFile.extend({ sourceChars: count, imports: z.array(z.object({ path: id, sourceChars: count }).strict()) }).strict()).min(1),
  diffChars: count, otherContextChars: count, contextSources: z.array(z.object({ref:id,chars:count}).strict()).default([]),
  confidence: z.enum(['high', 'medium', 'low']),
  uncertainty: z.object({ reviewableFiles: count, sourceChars: count, diffChars: count, combinedChars: count, unknowns: ids }).strict(),
  verification: ids.min(1),
  decomposition: z.array(z.object({ id, requirements: ids.min(1), base: sha, paths: ids.min(1), diffChars: count, otherContextChars: count, dependencies: ids, verification: ids.min(1) }).strict()),
}).strict();
export type Plan = z.infer<typeof Plan>;
export function invalidPlan(phase: ScopeResult['phase'], reasons: Reason[], config: Partial<ScopeConfig> = {}): ScopeResult {
  return { ...evaluate(emptyObservation(), phase, config), status: 'invalid', reasons };
}
export function validatePlan(raw: unknown, config: Partial<ScopeConfig> = {}): ScopeResult {
  const parsed = Plan.safeParse(raw), settings = ScopeConfig.safeParse(config);
  if (!parsed.success || !settings.success) return invalidPlan('forecast', [{ code: 'plan-schema', action: 'Provide a complete version 1 plan using the current policy hash and valid owner scope config.',
    ...(!parsed.success ? { path: parsed.error.issues.map(i => i.path.join('.')).join(', ') } : {}) }], config);
  const p = parsed.data, reasons: Reason[] = [];
  const fail = (action: string) => reasons.push({ code: 'plan-mapping', action });
  const unique = (values: string[], label: string) => { if (new Set(values).size !== values.length) fail(`Remove duplicate ${label}.`); };
  unique(p.files.map(f => f.path), 'file paths');
  for (const [label, rows] of [['requirement', p.requirements], ['task', p.tasks], ['test', p.tests], ['dependency', p.dependencies], ['slice', p.decomposition]] as const) unique(rows.map(r => r.id), `${label} IDs`);
  unique([...p.tasks, ...p.dependencies].map(t => t.id), 'task/dependency IDs');
  const requirements = new Map(p.requirements.map(r => [r.id, r]));
  const tasks = new Map(p.tasks.map(t => [t.id, t]));
  const tests = new Map(p.tests.map(t => [t.id, t]));
  const paths = new Set(p.files.map(f => f.path));
  for (const file of p.files) {
    if ((!reviewable(file.path) || file.status === 'removed') && file.imports.length) fail(`Only changed reviewable head sources can declare imports: ${file.path}.`);
    if (file.status === 'unchanged') fail(`Only changed paths belong in the plan file list: ${file.path}.`);
    if (['renamed','copied'].includes(file.status) !== !!file.previousPath) fail(`Declare previousPath only for renames/copies: ${file.path}.`);
  }
  for (const r of p.requirements) {
    if (r.tasks.some(t => !tasks.get(t)?.requirements.includes(r.id)) || r.tests.some(t => !tests.get(t)?.requirements.includes(r.id))) fail(`Map requirement ${r.id} to declared tasks and tests in both directions.`);
  }
  for (const task of p.tasks) {
    if (task.requirements.some(r => !requirements.get(r)?.tasks.includes(task.id)) || task.tests.some(t => !tests.has(t)) || task.paths.some(path => !paths.has(path))) fail(`Repair requirement, path and test mappings for task ${task.id}.`);
    if (task.requirements.some(r => !task.tests.some(t => tests.get(t)?.requirements.includes(r)))) fail(`Give task ${task.id} a meaningful test for each requirement.`);
  }
  for (const test of p.tests) if (test.requirements.some(r => !requirements.get(r)?.tests.includes(test.id))) fail(`Map test ${test.id} to declared acceptance requirements.`);
  for (const path of paths) if (!p.tasks.some(t => t.paths.includes(path))) fail(`Assign ${path} to an acceptance task.`);
  function graph(rows: { id: string; dependencies: string[] }[], external: Set<string>) {
    const map = new Map(rows.map(r => [r.id, r])), visiting = new Set<string>(), visited = new Set<string>();
    const visit = (id: string): boolean => {
      if (visiting.has(id)) return false;
      if (visited.has(id) || external.has(id)) return true;
      const row = map.get(id); if (!row) return false;
      visiting.add(id); const ok = row.dependencies.every(visit); visiting.delete(id); visited.add(id); return ok;
    };
    if (!rows.every(r => visit(r.id))) fail('Declare all dependencies and remove dependency cycles.');
  }
  graph(p.tasks, new Set(p.dependencies.map(d => d.id)));
  if (p.decomposition.length) {
    graph(p.decomposition, new Set(p.dependencies.map(d => d.id)));
    if (p.requirements.some(r => !p.decomposition.some(s => s.requirements.includes(r.id))) || p.decomposition.some(s => s.requirements.some(r => !requirements.has(r)))) fail('Preserve all and only original requirements across independently verifiable slices.');
    if (p.files.some(f => !p.decomposition.some(s => s.paths.includes(f.path)))) fail('Preserve every planned path across the proposed slices.');
    for (const slice of p.decomposition) {
      if (slice.paths.some(path => !paths.has(path))) fail(`Slice ${slice.id} references an undeclared path.`);
      const selected = p.files.filter(f => slice.paths.includes(f.path));
      const imported = new Map<string, number>();
      for (const f of selected) {
        if (reviewable(f.path)) imported.set(f.path, Math.max(imported.get(f.path) ?? 0, f.sourceChars));
        if (f.status !== 'removed') for (const i of f.imports) imported.set(i.path, Math.max(imported.get(i.path) ?? 0, i.sourceChars));
      }
      const check = evaluate({changedFiles:selected.length,reviewableFiles:selected.filter(f=>reviewable(f.path)).length,sources:imported.size,
        sourceChars:Math.max(0,...imported.values()),diffChars:slice.diffChars,combinedChars:slice.otherContextChars+slice.diffChars+[...imported.values()].reduce((n,c)=>n+c,0)},'forecast',config);
      if(check.status!=='pass') fail(`Reduce slice ${slice.id} to fit policy before presenting the decomposition as actionable.`);
    }
  }
  const allPaths = [...p.files.flatMap(f => [f.path, ...(f.previousPath ? [f.previousPath] : []), ...f.imports.map(i => i.path)]), ...p.tests.flatMap(t => t.paths)];
  for (const path of allPaths) { const problem = pathProblem(path, settings.data.exclude); if (problem) reasons.push({ code: 'excluded-path', path, action: problem }); }
  for (const file of p.files) for (const imported of file.imports) {
    const problem = importProblem(imported.path, settings.data.exclude);
    if (problem) reasons.push({code:'excluded-import',path:imported.path,action:problem});
  }
  if ((p.confidence !== 'high' || p.uncertainty.unknowns.length > 0) &&
      (p.uncertainty.reviewableFiles === 0 || p.uncertainty.sourceChars === 0 || p.uncertainty.diffChars === 0 || p.uncertainty.combinedChars === 0)) fail('Quantify file, source, diff and combined margins for uncertain scope before launching a builder.');
  const sources = new Map<string, number>();
  for (const f of p.files) {
    if (reviewable(f.path)) sources.set(f.path, Math.max(sources.get(f.path) ?? 0, f.sourceChars));
    if (f.status !== 'removed') for (const i of f.imports) sources.set(i.path, Math.max(sources.get(i.path) ?? 0, i.sourceChars));
  }
  const u = p.uncertainty;
  const observations = { changedFiles: p.files.length + u.reviewableFiles,
    reviewableFiles: p.files.filter(f => reviewable(f.path)).length + u.reviewableFiles,
    sources: sources.size + u.reviewableFiles, sourceChars: Math.max(0, ...sources.values(), ...p.contextSources.map(s=>s.chars)) + u.sourceChars,
    diffChars: p.diffChars + u.diffChars,
    combinedChars: Math.max(p.otherContextChars,p.contextSources.reduce((n,s)=>n+s.chars,0)) + p.diffChars + [...sources.values()].reduce((n, c) => n + c, 0) + u.combinedChars + u.diffChars + u.sourceChars };
  const result = evaluate(observations, 'forecast', config);
  return reasons.length ? { ...result, status: 'invalid', reasons: [...reasons, ...result.reasons] } : result;
}
