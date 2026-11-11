#!/usr/bin/env node
// Shared verification entry point for local use and GitHub-hosted CI. No dependencies.
//
//   node scripts/verify.mjs validate            check verification/contract.json, run nothing
//   node scripts/verify.mjs preflight           report whether a safe disposable backend is here
//   node scripts/verify.mjs run --out <dir>     execute the contract on a disposable backend only
//
// Exit codes: 0 pass, 1 a check failed, 2 contract or request invalid, 3 verification
// infrastructure unavailable. This file is repository-authored, so nothing it writes is
// trusted by itself: the coordinator re-derives every binding from GitHub and Git objects.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CONTRACT_PATH = 'verification/contract.json';
export const CAPABILITIES = Object.freeze(['postgres', 'loopback-listeners', 'dependency-download:npm', 'dependency-download:pypi']);
export const COVERS = Object.freeze(['dependencies', 'build', 'unit', 'migrations', 'integration', 'regression']);
// Bare program names only: no shells, interpreters with -c, absolute host paths or sudo.
export const EXECUTABLES = Object.freeze(['npm', 'npx', 'node', 'python3']);
export const LIMITS = Object.freeze({ checks: 20, argv: 40, arg: 500, timeoutSeconds: 1800, totalSeconds: 3600, logBytes: 2_000_000 });
const FORBIDDEN_ENV = ['GITHUB_TOKEN', 'GH_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_URL', 'NPM_TOKEN', 'NODE_AUTH_TOKEN'];
const CHILD_ENV = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR'];
const PG_ENV = ['PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE'];

const sha256 = data => createHash('sha256').update(data).digest('hex');
const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v);
const strings = v => Array.isArray(v) && v.every(x => typeof x === 'string');

/** Structural validation. Unknown capability names are unavailable infrastructure, not syntax errors. */
export function validateContract(contract) {
  const errors = [], unsupported = [];
  const err = (path, detail) => errors.push({ path, detail });
  if (!isObject(contract)) return { ok: false, errors: [{ path: '$', detail: 'contract must be a JSON object' }], unsupported };
  for (const key of Object.keys(contract)) if (!['version', 'capabilities', 'checks', 'externalIntegrations'].includes(key)) err(key, 'unknown field (mounts, privileges, env, shells and runner selection are not contract settings)');
  if (contract.version !== 1) err('version', 'only version 1 is supported');
  if (!strings(contract.capabilities) || new Set(contract.capabilities).size !== contract.capabilities.length) err('capabilities', 'unique strings required');
  else for (const c of contract.capabilities) if (!CAPABILITIES.includes(c)) unsupported.push(c);
  const declared = strings(contract.capabilities) ? contract.capabilities : [];
  if (!Array.isArray(contract.checks) || !contract.checks.length || contract.checks.length > LIMITS.checks) err('checks', `1 to ${LIMITS.checks} checks required`);
  const ids = new Set(); let total = 0;
  for (const [i, c] of (Array.isArray(contract.checks) ? contract.checks : []).entries()) {
    const at = `checks[${i}]`;
    if (!isObject(c)) { err(at, 'object required'); continue; }
    for (const key of Object.keys(c)) if (!['id', 'covers', 'cwd', 'argv', 'requires', 'timeoutSeconds', 'count', 'report'].includes(key)) err(`${at}.${key}`, 'unknown field');
    if (typeof c.id !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(c.id) || ids.has(c.id)) err(`${at}.id`, 'unique lowercase id required');
    ids.add(c.id);
    if (!strings(c.covers) || !c.covers.length || c.covers.some(x => !COVERS.includes(x))) err(`${at}.covers`, `nonempty subset of ${COVERS.join(', ')}`);
    if (!strings(c.argv) || !c.argv.length || c.argv.length > LIMITS.argv || c.argv.some(a => !a || a.length > LIMITS.arg || a.includes('\0'))) err(`${at}.argv`, 'bounded nonempty string array required');
    else if (!EXECUTABLES.includes(c.argv[0])) err(`${at}.argv[0]`, `executable must be one of ${EXECUTABLES.join(', ')}`);
    const cwd = c.cwd ?? '.';
    if (typeof cwd !== 'string' || isAbsolute(cwd) || cwd.split('/').some(p => p === '..' || p === '.git' || p === '') && cwd !== '.') err(`${at}.cwd`, 'repository-relative directory required');
    if (!strings(c.requires) || c.requires.some(r => !declared.includes(r))) err(`${at}.requires`, 'must list only declared capabilities');
    if (!Number.isInteger(c.timeoutSeconds) || c.timeoutSeconds < 1 || c.timeoutSeconds > LIMITS.timeoutSeconds) err(`${at}.timeoutSeconds`, `1 to ${LIMITS.timeoutSeconds}`);
    else total += c.timeoutSeconds;
    if (!['required', 'optional', 'none'].includes(c.count)) err(`${at}.count`, 'required, optional or none');
    if (c.report !== undefined && c.report !== 'vitest-json') err(`${at}.report`, 'only vitest-json is supported');
    const placeholders = strings(c.argv) ? c.argv.filter(a => a.includes('{report}')).length : 0;
    if ((c.report ? 1 : 0) !== placeholders) err(`${at}.argv`, 'a report needs exactly one {report} placeholder; none otherwise');
    if (c.count === 'required' && !c.report) err(`${at}.count`, 'a required count needs a machine-readable report');
  }
  if (total > LIMITS.totalSeconds) err('checks', `total timeout above ${LIMITS.totalSeconds}s`);
  if (contract.externalIntegrations !== undefined && !Array.isArray(contract.externalIntegrations)) err('externalIntegrations', 'array required');
  return { ok: !errors.length && !unsupported.length, errors, unsupported };
}

/** Only a GitHub-hosted VM is a disposable backend in this version. Self-hosted and local hosts are refused. */
export function detectBackend(env) {
  if (env.GITHUB_ACTIONS === 'true' && env.RUNNER_ENVIRONMENT === 'github-hosted') return { kind: 'github-hosted' };
  if (env.GITHUB_ACTIONS === 'true') return { kind: 'unavailable', code: 'self-hosted-runner', detail: `runner environment "${env.RUNNER_ENVIRONMENT ?? 'unknown'}" is not a disposable GitHub-hosted VM` };
  return { kind: 'unavailable', code: 'no-disposable-backend', detail: 'this host is not a disposable verifier; run the contract through the GitHub-hosted workflow (the container backend is not implemented)' };
}

function git(repo, args) {
  return spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], { cwd: repo, encoding: 'utf8', timeout: 30_000,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' } });
}
const probeTcp = (options, ms = 5000) => new Promise(done => {
  const socket = connect(options); const finish = ok => { socket.destroy(); done(ok); };
  socket.setTimeout(ms, () => finish(false)); socket.once('connect', () => finish(true)); socket.once('error', () => finish(false));
});
const probeListen = () => new Promise(done => {
  const server = createServer(); server.once('error', () => done(false));
  server.listen(0, '127.0.0.1', () => server.close(() => done(true)));
});

/** Every problem here is verification infrastructure, never a builder failure. */
export async function preflight({ contract, env, repo }) {
  const problems = [], add = (code, detail, capability) => problems.push({ code, detail, ...(capability ? { capability } : {}) });
  for (const c of validateContract(contract).unsupported) add('unsupported-capability', `no verifier backend provides "${c}"`, c);
  const backend = detectBackend(env);
  if (backend.kind !== 'github-hosted') add(backend.code, backend.detail);
  for (const name of FORBIDDEN_ENV) if (env[name]) add('credential-present', `${name} is set; the verifier must hold no tokens`);
  if (git(repo, ['config', '--local', '--get-regexp', '^http\\..*\\.extraheader$']).status === 0) add('checkout-credentials', 'checkout persisted an authorization header; use persist-credentials: false');
  if (problems.length) return { status: 'unavailable', backend, problems };
  const declared = contract.capabilities;
  if (declared.includes('postgres')) {
    const host = env.PGHOST ?? 'localhost', port = Number(env.PGPORT ?? 5432);
    if (!host.startsWith('/') && !['localhost', '127.0.0.1', '::1'].includes(host)) add('non-loopback-database', `PGHOST ${host} is not a disposable loopback service`, 'postgres');
    else if (!(await probeTcp(host.startsWith('/') ? { path: join(host, `.s.PGSQL.${port}`) } : { host, port }))) add('service-unreachable', `postgres at ${host}:${port} is not accepting connections`, 'postgres');
  }
  if (declared.includes('loopback-listeners') && !(await probeListen())) add('listener-denied', 'cannot bind a loopback listener', 'loopback-listeners');
  return { status: problems.length ? 'unavailable' : 'ready', backend, problems };
}

function provenance(env) {
  const pick = ['GITHUB_REPOSITORY', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'GITHUB_WORKFLOW_REF', 'GITHUB_WORKFLOW_SHA', 'GITHUB_JOB', 'GITHUB_EVENT_NAME', 'RUNNER_OS', 'RUNNER_ARCH', 'RUNNER_ENVIRONMENT', 'ImageOS', 'ImageVersion'];
  return Object.fromEntries(pick.filter(k => env[k]).map(k => [k, env[k]]));
}

function execute(check, { repo, out, env, pg }) {
  const log = join(out, 'logs', `${check.id}.log`), report = join(out, 'reports', `${check.id}.json`);
  const argv = check.argv.map(a => a.replace('{report}', report));
  const childEnv = { CI: 'true', ...Object.fromEntries([...CHILD_ENV, ...(pg ? PG_ENV : [])].filter(k => env[k] !== undefined).map(k => [k, env[k]])) };
  const fd = openSync(log, 'w', 0o600), hash = createHash('sha256');
  let bytes = 0, truncated = false;
  const started = Date.now();
  return new Promise(done => {
    let child;
    try { child = spawn(argv[0], argv.slice(1), { cwd: resolve(repo, check.cwd ?? '.'), env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], detached: true }); }
    catch (error) { closeSync(fd); done({ status: 'error', observed: 'spawn-error', detail: String(error.message), exitCode: null, signal: null, argv, started, log: { bytes: 0, sha256: sha256(''), truncated } }); return; }
    let timedOut = false, spawnError = null;
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGKILL'); } catch { /* exited */ } }, check.timeoutSeconds * 1000);
    const write = chunk => {
      const room = LIMITS.logBytes - bytes; if (room <= 0) { truncated = true; return; }
      const part = chunk.length > room ? chunk.subarray(0, room) : chunk; if (part.length < chunk.length) truncated = true;
      writeSync(fd, part); hash.update(part); bytes += part.length;
    };
    child.stdout.on('data', write); child.stderr.on('data', write);
    child.on('error', error => { spawnError = error; });
    child.on('close', (code, signal) => {
      clearTimeout(timer); closeSync(fd);
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* group already gone */ }
      const result = { exitCode: code, signal, argv, started, log: { bytes, sha256: hash.digest('hex'), truncated } };
      if (spawnError) done({ ...result, status: 'error', observed: 'spawn-error', detail: spawnError.code ?? 'spawn failed' });
      else if (timedOut) done({ ...result, status: 'timeout', observed: 'timeout' });
      else if (signal) done({ ...result, status: 'fail', observed: 'signal' });
      else done({ ...result, status: code === 0 ? 'pass' : 'fail', observed: 'exit' });
    });
  });
}

/** A count is machine-reported or explicitly unknown. Never parsed from free-form log text. */
export function readCount(path) {
  try {
    const r = JSON.parse(readFileSync(path, 'utf8'));
    const n = k => (Number.isSafeInteger(r[k]) && r[k] >= 0 ? r[k] : null);
    const count = { total: n('numTotalTests'), passed: n('numPassedTests'), failed: n('numFailedTests'), skipped: (n('numPendingTests') ?? 0) + (n('numTodoTests') ?? 0),
      suites: n('numTotalTestSuites'), failedSuites: n('numFailedTestSuites') };
    return Object.values(count).some(v => v === null) ? 'unknown' : count;
  } catch { return 'unknown'; }
}

export async function run({ repo, out, env, contractPath = CONTRACT_PATH }) {
  const startedAt = new Date().toISOString();
  let raw = null, contract = null;
  try { raw = readFileSync(join(repo, contractPath)); contract = JSON.parse(raw.toString('utf8')); } catch { /* reported below */ }
  const head = git(repo, ['rev-parse', 'HEAD']), dirty = git(repo, ['status', '--porcelain=v1', '--untracked-files=all']);
  const evidence = { version: 1, source: { sha: head.status === 0 ? head.stdout.trim() : null, clean: dirty.status === 0 && !dirty.stdout.trim() },
    contract: { path: contractPath, sha256: raw ? sha256(raw) : null }, backend: { ...detectBackend(env), provenance: provenance(env) },
    startedAt, preflight: null, checks: [], result: 'invalid', problems: [] };
  mkdirSync(join(out, 'logs'), { recursive: true, mode: 0o700 }); mkdirSync(join(out, 'reports'), { recursive: true, mode: 0o700 });
  const finish = result => { evidence.result = result; evidence.finishedAt = new Date().toISOString(); writeFileSync(join(out, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 }); return evidence; };
  const validation = validateContract(contract);
  if (!raw || validation.errors.length) { evidence.problems = raw ? validation.errors : [{ path: contractPath, detail: 'contract missing or not JSON' }]; return finish('invalid'); }
  if (!evidence.source.sha || !evidence.source.clean) { evidence.problems = [{ path: '.', detail: 'source checkout is not a clean exact commit' }]; return finish('invalid'); }
  evidence.preflight = await preflight({ contract, env, repo });
  const pending = check => ({ id: check.id, covers: check.covers, argvTemplate: check.argv, status: 'not-run', exitCode: null, count: 'unknown', log: null });
  if (evidence.preflight.status !== 'ready') { evidence.checks = contract.checks.map(pending); return finish('unavailable'); }
  const pg = contract.capabilities.includes('postgres');
  for (const check of contract.checks) {
    if (evidence.checks.some(c => c.status !== 'pass')) { evidence.checks.push(pending(check)); continue; }
    const r = await execute(check, { repo, out, env, pg });
    const count = check.report ? readCount(join(out, 'reports', `${check.id}.json`)) : 'unknown';
    let status = r.status;
    if (status === 'pass' && check.count === 'required' && (count === 'unknown' || count.total === 0 || count.failed > 0 || count.failedSuites > 0)) status = 'incomplete';
    evidence.checks.push({ id: check.id, covers: check.covers, argvTemplate: check.argv, argv: r.argv, status, observed: r.observed, ...(r.detail ? { detail: r.detail } : {}),
      exitCode: r.exitCode, signal: r.signal, durationMs: Date.now() - r.started, count, log: { path: `logs/${check.id}.log`, ...r.log } });
  }
  return finish(evidence.checks.every(c => c.status === 'pass') ? 'pass' : 'fail');
}

const EXIT = { pass: 0, fail: 1, invalid: 2, unavailable: 3 };
export async function main(args, env = process.env, repo = process.cwd()) {
  const [mode, ...rest] = args;
  const load = () => { try { return JSON.parse(readFileSync(join(repo, CONTRACT_PATH), 'utf8')); } catch { return null; } };
  if (mode === 'validate' && !rest.length) {
    const v = validateContract(load()); console.log(JSON.stringify({ status: v.errors.length ? 'invalid' : v.unsupported.length ? 'unavailable' : 'valid', ...v }));
    return v.errors.length ? EXIT.invalid : v.unsupported.length ? EXIT.unavailable : 0;
  }
  if (mode === 'preflight' && !rest.length) {
    const contract = load(), v = validateContract(contract);
    if (v.errors.length) { console.log(JSON.stringify({ status: 'invalid', errors: v.errors })); return EXIT.invalid; }
    const p = await preflight({ contract, env, repo });
    if (p.backend.kind !== 'github-hosted') {
      const docker = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { encoding: 'utf8', timeout: 5000 });
      p.docker = docker.error ? 'cli-missing' : docker.status === 0 ? 'daemon-running (container backend not implemented)' : 'daemon-unavailable';
    }
    console.log(JSON.stringify(p)); return p.status === 'ready' ? 0 : EXIT.unavailable;
  }
  if (mode === 'run' && rest.length === 2 && rest[0] === '--out') {
    const out = resolve(rest[1]), rel = relative(resolve(repo), out);
    if (!rel.startsWith('..') && !isAbsolute(rel)) { console.error('--out must be outside the checkout'); return EXIT.invalid; }
    const evidence = await run({ repo, out, env });
    console.log(JSON.stringify({ result: evidence.result, source: evidence.source, problems: evidence.problems, preflight: evidence.preflight,
      checks: evidence.checks.map(c => ({ id: c.id, status: c.status, exitCode: c.exitCode, count: c.count })) }));
    return EXIT[evidence.result];
  }
  console.error('Usage: node scripts/verify.mjs validate | preflight | run --out <dir outside the checkout>');
  return EXIT.invalid;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
