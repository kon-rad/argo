#!/usr/bin/env node
// Shared verification entry point for local use and GitHub-hosted CI. No dependencies.
//
//   node scripts/verify.mjs validate            check verification/contract.json, run nothing
//   node scripts/verify.mjs preflight           report whether a safe disposable backend is here
//   node scripts/verify.mjs run --out <dir>     execute the contract on a disposable backend only
//
// Exit codes: 0 pass, 1 a check failed, 2 contract or request invalid, 3 verification
// infrastructure unavailable.
//
// This process is the supervisor. It never runs repository code as itself: every check runs as
// the separate unprivileged user SANDBOX.user, whose network is loopback only (no DNS), who
// cannot read or write the evidence directory, signal this process or reach the Docker socket.
// A built-in adversarial probe proves that boundary on every run before any check starts; if it
// cannot be proven the run reports infrastructure unavailable. The coordinator still re-derives
// every binding from GitHub and Git objects and pins this file's contents.
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CONTRACT_PATH = 'verification/contract.json';
export const CAPABILITIES = Object.freeze(['postgres', 'loopback-listeners', 'dependency-download:npm']);
export const COVERS = Object.freeze(['dependencies', 'build', 'unit', 'migrations', 'integration', 'regression']);
// Bare program names only: no shells, interpreters with -c, absolute host paths or sudo.
export const EXECUTABLES = Object.freeze(['npm', 'npx', 'node', 'python3']);
export const LIMITS = Object.freeze({ checks: 20, argv: 40, arg: 500, timeoutSeconds: 1800, totalSeconds: 3600, logBytes: 2_000_000, reportBytes: 10_000_000 });
// Fixed identity and paths, so the coordinator can bind each check to its resolved argv and cwd.
export const SANDBOX = Object.freeze({ user: 'sbverify', group: 'sbverify-aux', home: '/home/sbverify', work: '/home/sbverify/work', reports: '/home/sbverify/reports' });
// Installation-approved download sources. The installation pins this file, so a PR cannot widen them.
export const DOWNLOADS = Object.freeze({ 'dependency-download:npm': Object.freeze({ registry: 'https://registry.npmjs.org/', hosts: Object.freeze(['registry.npmjs.org']) }) });
// Boundary probes: what repository code must be denied, and what each declared capability must allow.
export const PROBES = Object.freeze({ denied: Object.freeze(['read-evidence', 'write-evidence', 'write-checkout', 'supervisor-environ', 'signal-supervisor', 'docker-socket', 'sudo', 'egress', 'dns-resolver', 'dns-lookup']),
  allowed: Object.freeze({ postgres: 'postgres', 'loopback-listeners': 'loopback-listen' }) });
const FORBIDDEN_ENV = ['GITHUB_TOKEN', 'GH_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_URL', 'ACTIONS_RUNTIME_TOKEN', 'NPM_TOKEN', 'NODE_AUTH_TOKEN'];
const PG_ENV = ['PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE'];
// While checks run, the evidence directory holds only these; evidence.json is written last.
const OWN = new Set(['.canary', 'logs', 'reports']);

const sha256 = data => createHash('sha256').update(data).digest('hex');
const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v);
const strings = v => Array.isArray(v) && v.every(x => typeof x === 'string');
const delay = ms => new Promise(r => setTimeout(r, ms));

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
    else if (c.requires.some(r => r.startsWith('dependency-download:')) && !(strings(c.argv) && c.argv[0] === 'npm' && c.argv[1] === 'ci' && c.argv.includes('--ignore-scripts'))) {
      err(`${at}.argv`, 'a dependency download must be `npm ci --ignore-scripts ...`: lifecycle scripts stay disabled');
    }
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

/** Where each check runs inside the sandbox. The coordinator derives the same values. */
export const resolved = check => ({ cwd: !check.cwd || check.cwd === '.' ? SANDBOX.work : `${SANDBOX.work}/${check.cwd}`,
  argv: check.argv.map(a => a.replace('{report}', `${SANDBOX.reports}/${check.id}.json`)) });

function git(repo, args) {
  return spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], { cwd: repo, encoding: 'utf8', timeout: 30_000,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' } });
}
const probeTcp = (options, ms = 5000) => new Promise(done => {
  const socket = connect(options); const finish = ok => { socket.destroy(); done(ok); };
  socket.setTimeout(ms, () => finish(false)); socket.once('connect', () => finish(true)); socket.once('error', () => finish(false));
});

/** Every lockfile download is pinned to the approved registry with sha512 integrity; nothing else is fetched. */
export function lockedSources(text, registry) {
  let lock; try { lock = JSON.parse(text); } catch { return ['package-lock.json is missing or not JSON']; }
  if (!isObject(lock?.packages) || !(lock.lockfileVersion >= 2)) return ['a lockfile version 2 or 3 with a packages map is required'];
  const bad = [];
  for (const [path, p] of Object.entries(lock.packages)) {
    if (!path.includes('node_modules/') || p?.link || p?.inBundle) continue;
    if (typeof p?.resolved !== 'string' || !p.resolved.startsWith(registry) || typeof p.integrity !== 'string' || !p.integrity.startsWith('sha512-')) bad.push(`${path} is not a locked ${registry} download with sha512 integrity`);
  }
  return bad.slice(0, 20);
}

/** CONNECT-only proxy that reaches the approved hosts on 443 and nothing else. Runs as the supervisor. */
export function downloadProxy(hosts) {
  const log = { allowed: 0, denied: [] };
  const server = createServer(client => {
    let head = Buffer.alloc(0);
    client.on('error', () => client.destroy());
    const onData = chunk => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\r\n\r\n');
      if (end < 0) { if (head.length > 4096) client.destroy(); return; }
      client.off('data', onData);
      const m = /^CONNECT ([A-Za-z0-9.-]+):443 HTTP\/1\.[01]\r\n/.exec(head.subarray(0, end + 2).toString('latin1'));
      const host = m?.[1].toLowerCase();
      if (!host || !hosts.includes(host)) { if (log.denied.length < 20) log.denied.push(host ?? 'malformed'); client.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
      log.allowed++;
      const upstream = connect(443, host, () => { client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); const rest = head.subarray(end + 4); if (rest.length) upstream.write(rest); upstream.pipe(client); client.pipe(upstream); });
      upstream.on('error', () => client.destroy()); client.on('close', () => upstream.destroy());
    };
    client.on('data', onData);
  });
  return new Promise((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', () => done({ port: server.address().port, log, close: () => new Promise(r => { server.close(() => r()); server.closeAllConnections?.(); }) })); });
}

// Run as the sandbox user. Each probe is an attempt repository code could make; the boundary must deny it.
export const PROBE_SOURCE = `
const fs = require('fs'), net = require('net'), dns = require('dns'), cp = require('child_process');
const cfg = JSON.parse(process.argv[1]), out = {};
const sync = f => { try { f(); return 'allowed'; } catch (e) { return 'denied:' + (e.code || 'error'); } };
const tcp = (o, ms = 5000) => new Promise(r => { const s = net.connect(o); const end = v => { s.destroy(); r(v); };
  s.setTimeout(ms, () => end('denied:timeout')); s.once('connect', () => end('allowed')); s.once('error', e => end('denied:' + (e.code || 'error'))); });
(async () => {
  out['read-evidence'] = sync(() => fs.readFileSync(cfg.canary));
  out['write-evidence'] = sync(() => fs.writeFileSync(cfg.out + '/probe-write', 'x'));
  out['write-checkout'] = sync(() => fs.writeFileSync(cfg.checkout + '/.verify-probe-write', 'x'));
  out['supervisor-environ'] = sync(() => fs.readFileSync('/proc/' + cfg.pid + '/environ'));
  out['signal-supervisor'] = sync(() => process.kill(cfg.pid, 0));
  out['docker-socket'] = await tcp({ path: '/var/run/docker.sock' });
  const sudo = cp.spawnSync('sudo', ['-n', 'true'], { stdio: 'ignore', timeout: 10000 });
  out['sudo'] = sudo.status === 0 ? 'allowed' : 'denied:' + (sudo.error ? sudo.error.code : 'status-' + sudo.status);
  out['egress'] = cfg.external ? await tcp({ host: cfg.external, port: 443 }) : 'denied:no-target';
  out['dns-resolver'] = await dns.promises.resolve4('example.com').then(() => 'allowed', e => 'denied:' + (e.code || 'error'));
  out['dns-lookup'] = await dns.promises.lookup('example.com').then(() => 'allowed', e => 'denied:' + (e.code || 'error'));
  if (cfg.pg) out['postgres'] = await tcp(cfg.pg);
  if (cfg.listen) out['loopback-listen'] = await new Promise(r => { const s = net.createServer(); s.once('error', e => r('denied:' + (e.code || 'error')));
    s.listen(0, '127.0.0.1', () => { const c = net.connect({ host: '127.0.0.1', port: s.address().port });
      c.once('connect', () => { c.destroy(); s.close(); r('allowed'); }); c.once('error', e => { s.close(); r('denied:' + (e.code || 'error')); }); }); });
  process.stdout.write(JSON.stringify(out));
})();`;

/** Compare probe results with what the declared capabilities need. Any mismatch means no safe backend. */
export function judgeProbes(results, declared) {
  const problems = [];
  if (!isObject(results)) return ['the boundary probe produced no result'];
  for (const name of PROBES.denied) if (typeof results[name] !== 'string' || !results[name].startsWith('denied')) problems.push(`${name}: ${results[name] ?? 'missing'} (must be denied)`);
  for (const [cap, name] of Object.entries(PROBES.allowed)) if (declared.includes(cap) && results[name] !== 'allowed') problems.push(`${name}: ${results[name] ?? 'missing'} (declared ${cap} must work)`);
  return problems;
}

/**
 * The isolated execution backend: a fresh unprivileged Linux user on the disposable VM. Needs passwordless sudo
 * (GitHub-hosted runners have it), iptables and ip6tables. `sudo` is injectable for tests.
 */
export function linuxSandbox(sudo = (args, opts = {}) => spawnSync('sudo', ['-n', ...args], { encoding: 'utf8', timeout: 300_000, maxBuffer: 4_000_000, ...opts })) {
  const ok = r => !r.error && r.status === 0;
  const as = (argv, cwd, env) => ['-u', SANDBOX.user, '--', '/usr/bin/env', '-i', '-C', cwd, ...Object.entries(env).map(([k, v]) => `${k}=${v}`), ...argv];
  const U = ['-m', 'owner', '--uid-owner', SANDBOX.user];
  // Inserted at the top in this order, so DNS is refused first, then loopback allowed, then everything else refused.
  const RULES = [[...U, '-j', 'REJECT'], [...U, '-o', 'lo', '-j', 'ACCEPT'], [...U, '-p', 'udp', '--dport', '53', '-j', 'REJECT'], [...U, '-p', 'tcp', '--dport', '53', '-j', 'REJECT']];
  const step = (problems, what, r) => { if (!ok(r)) problems.push(`${what} failed${r.stderr ? `: ${String(r.stderr).trim().slice(0, 200)}` : ''}`); return ok(r); };
  return {
    kind: 'linux-user',
    available() {
      if (process.platform !== 'linux') return ['the user and egress boundary needs a Linux VM'];
      if (!ok(sudo(['true']))) return ['passwordless sudo is unavailable to the supervisor'];
      const problems = [];
      for (const t of ['iptables', 'ip6tables']) if (!ok(sudo([t, '-w', '-S', 'OUTPUT']))) problems.push(`${t} is unavailable`);
      if (ok(spawnSync('id', ['-u', SANDBOX.user]))) problems.push(`user ${SANDBOX.user} already exists; the verifier needs a fresh VM`);
      return problems;
    },
    prepare({ repo, sha }) {
      const problems = [];
      if (!step(problems, 'groupadd', sudo(['groupadd', SANDBOX.group]))) return problems;
      // A supplementary group, like an ordinary login, and no membership in docker, adm or sudo.
      if (!step(problems, 'useradd', sudo(['useradd', '--create-home', '--home-dir', SANDBOX.home, '--shell', '/usr/sbin/nologin', '--user-group', '--groups', SANDBOX.group, SANDBOX.user]))) return problems;
      for (const t of ['iptables', 'ip6tables']) for (const rule of RULES) if (!step(problems, `${t} rule`, sudo([t, '-w', '-I', 'OUTPUT', '1', ...rule]))) return problems;
      // Copy the exact clean checkout; the sandbox works on its own copy and never touches the supervisor's.
      // /tmp, not TMPDIR: the sandbox user must be able to traverse to the archive.
      const tmp = mkdtempSync(join(process.platform === 'linux' ? '/tmp' : tmpdir(), 'verify-src-'));
      try {
        chmodSync(tmp, 0o755);
        const tar = join(tmp, 'src.tar');
        if (!step(problems, 'archive checkout', spawnSync('tar', ['-C', repo, '-cf', tar, '.'], { encoding: 'utf8', timeout: 300_000 }))) return problems;
        chmodSync(tar, 0o644);
        const env = { PATH: '/usr/bin:/bin', HOME: SANDBOX.home };
        if (!step(problems, 'create work and reports', sudo(as(['mkdir', '-m', '0700', SANDBOX.work, SANDBOX.reports], SANDBOX.home, env)))) return problems;
        if (!step(problems, 'extract checkout', sudo(as(['tar', '-xf', tar, '-C', SANDBOX.work], SANDBOX.home, env)))) return problems;
        const head = sudo(as(['git', '-c', 'core.hooksPath=/dev/null', 'rev-parse', 'HEAD'], SANDBOX.work, env));
        if (!ok(head) || head.stdout.trim() !== sha) problems.push(`sandbox copy is not ${sha}`);
      } finally { rmSync(tmp, { recursive: true, force: true }); }
      return problems;
    },
    /** A host the supervisor can reach, so the sandbox's denial proves the boundary rather than a dead network. */
    async control() {
      const target = await lookup(DOWNLOADS['dependency-download:npm'].hosts[0], { family: 4 }).then(a => a.address, () => null);
      return { target, reachable: !!target && await probeTcp({ host: target, port: 443 }) };
    },
    spawnArgs: (argv, cwd, env) => ['sudo', ['-n', ...as(argv, cwd, env)]],
    capture: (argv, cwd, env, timeout) => sudo(as(argv, cwd, env), { timeout }),
    async kill() {
      sudo(['pkill', '-KILL', '-u', SANDBOX.user]);
      for (let i = 0; i < 50; i++) { if (spawnSync('pgrep', ['-u', SANDBOX.user]).status === 1) return true; await delay(100); }
      return false;
    },
    /** Read as the sandbox user: whatever a symlink points at, the sandbox could read it anyway. */
    read(path, limit) {
      const r = sudo(as(['head', '-c', String(limit + 1), '--', path], SANDBOX.home, { PATH: '/usr/bin:/bin' }), { encoding: 'buffer', maxBuffer: limit + 2 });
      return ok(r) ? r.stdout : null;
    },
  };
}

/** Every problem here is verification infrastructure, never a builder failure. */
export async function preflight({ contract, env, repo, sandbox }) {
  const problems = [], add = (code, detail, capability) => problems.push({ code, detail, ...(capability ? { capability } : {}) });
  for (const c of validateContract(contract).unsupported) add('unsupported-capability', `no verifier backend provides "${c}"`, c);
  const backend = detectBackend(env);
  if (backend.kind !== 'github-hosted') add(backend.code, backend.detail);
  for (const name of FORBIDDEN_ENV) if (env[name]) add('credential-present', `${name} is set; the verifier must hold no tokens`);
  if (git(repo, ['config', '--local', '--get-regexp', '^http\\..*\\.extraheader$']).status === 0) add('checkout-credentials', 'checkout persisted an authorization header; use persist-credentials: false');
  if (problems.length) return { status: 'unavailable', backend, problems };
  for (const detail of await sandbox.available()) add('isolation-unavailable', detail);
  if (contract.capabilities.includes('postgres')) {
    const host = env.PGHOST ?? 'localhost', port = Number(env.PGPORT ?? 5432);
    if (!['localhost', '127.0.0.1', '::1'].includes(host)) add('non-loopback-database', `PGHOST ${host} is not a disposable loopback service`, 'postgres');
    else if (!(await probeTcp({ host, port }))) add('service-unreachable', `postgres at ${host}:${port} is not accepting connections`, 'postgres');
  }
  return { status: problems.length ? 'unavailable' : 'ready', backend, problems };
}

function provenance(env) {
  const pick = ['GITHUB_REPOSITORY', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'GITHUB_WORKFLOW_REF', 'GITHUB_WORKFLOW_SHA', 'GITHUB_JOB', 'GITHUB_EVENT_NAME', 'RUNNER_OS', 'RUNNER_ARCH', 'RUNNER_ENVIRONMENT', 'ImageOS', 'ImageVersion'];
  return Object.fromEntries(pick.filter(k => env[k]).map(k => [k, env[k]]));
}

/** Establish and prove the boundary. Returns the isolation record for the evidence. */
async function isolate({ sandbox, repo, sha, out, contract, env }) {
  const declared = contract.capabilities;
  const record = { kind: sandbox.kind, user: SANDBOX.user, egress: 'loopback-only', downloads: declared.flatMap(c => DOWNLOADS[c]?.hosts ?? []), probes: null, provided: [], problems: [] };
  record.problems.push(...await sandbox.prepare({ repo, sha }));
  if (record.problems.length) return record;
  writeFileSync(join(out, '.canary'), randomBytes(32).toString('hex'), { mode: 0o600 });
  const { target, reachable } = await sandbox.control();
  if (!reachable) record.problems.push('egress control: the supervisor cannot reach the approved registry, so a denial proves nothing');
  const pg = declared.includes('postgres') ? { host: env.PGHOST ?? 'localhost', port: Number(env.PGPORT ?? 5432) } : null;
  const cfg = { canary: join(out, '.canary'), out, checkout: resolve(repo), pid: process.pid, external: target, pg, listen: declared.includes('loopback-listeners') };
  const r = sandbox.capture(['node', '-e', PROBE_SOURCE, JSON.stringify(cfg)], SANDBOX.home, { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: SANDBOX.home }, 60_000);
  try { record.probes = JSON.parse(String(r.stdout)); } catch { record.probes = null; }
  record.problems.push(...judgeProbes(record.probes, declared));
  if (!(await sandbox.kill())) record.problems.push('sandbox processes survived the probe');
  record.provided = record.problems.length ? [] : declared.filter(c => !PROBES.allowed[c] || record.probes[PROBES.allowed[c]] === 'allowed');
  return record;
}

/** After every check: the evidence directory and canary are exactly as the supervisor left them. */
function intact(out, canary) {
  const problems = [];
  try {
    const s = statSync(out);
    if (s.uid !== process.getuid?.() || (s.mode & 0o777) !== 0o700) problems.push('evidence directory owner or mode changed');
    if (readFileSync(join(out, '.canary'), 'utf8') !== canary) problems.push('evidence canary changed');
    const extra = readdirSync(out).filter(n => !OWN.has(n));
    if (extra.length) problems.push(`unexpected files in the evidence directory: ${extra.slice(0, 5).join(', ')}`);
  } catch { problems.push('evidence directory unreadable'); }
  return problems;
}

function execute(check, { out, sandbox, childEnv }) {
  const log = join(out, 'logs', `${check.id}.log`), { argv, cwd } = resolved(check);
  const fd = openSync(log, 'w', 0o600), hash = createHash('sha256');
  let bytes = 0, truncated = false;
  const started = Date.now();
  const [exe, args] = sandbox.spawnArgs(argv, cwd, childEnv);
  return new Promise(done => {
    let child;
    const base = { argv, cwd, started };
    try { child = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (error) { closeSync(fd); done({ ...base, status: 'error', observed: 'spawn-error', detail: String(error.message), exitCode: null, signal: null, log: { bytes: 0, sha256: sha256(''), truncated } }); return; }
    let timedOut = false, spawnError = null;
    const timer = setTimeout(() => { timedOut = true; void sandbox.kill(); }, check.timeoutSeconds * 1000);
    const write = chunk => {
      const room = LIMITS.logBytes - bytes; if (room <= 0) { truncated = true; return; }
      const part = chunk.length > room ? chunk.subarray(0, room) : chunk; if (part.length < chunk.length) truncated = true;
      writeSync(fd, part); hash.update(part); bytes += part.length;
    };
    child.stdout.on('data', write); child.stderr.on('data', write);
    child.on('error', error => { spawnError = error; });
    child.on('close', (code, signal) => {
      clearTimeout(timer); closeSync(fd);
      const result = { ...base, exitCode: code, signal, log: { bytes, sha256: hash.digest('hex'), truncated } };
      if (spawnError) done({ ...result, status: 'error', observed: 'spawn-error', detail: spawnError.code ?? 'spawn failed' });
      else if (timedOut) done({ ...result, status: 'timeout', observed: 'timeout' });
      else if (signal) done({ ...result, status: 'fail', observed: 'signal' });
      else done({ ...result, status: code === 0 ? 'pass' : 'fail', observed: 'exit' });
    });
  });
}

const FIELDS = ['numTotalTests', 'numPassedTests', 'numFailedTests', 'numPendingTests', 'numTodoTests', 'numTotalTestSuites', 'numFailedTestSuites'];
/** Failure type from the error name and code the test runner serialized. Never from free-form log text. */
export function failureKind(message) {
  const first = String(message ?? '').split('\n')[0];
  if (/^\s*AssertionError\b/.test(first)) return 'assertion';
  const text = String(message ?? '').slice(0, 4000);
  if (/\b(ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN|ENOTFOUND|57P01|57P03|08006|08001)\b|Connection terminated|terminating connection due to administrator command|the database system is (?:starting up|shutting down)/.test(text)) return 'service';
  if (/\b(ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND)\b|Cannot find (?:module|package)\b|Failed to load url\b/.test(text)) return 'dependency';
  if (/\b(EACCES|EPERM)\b|permission denied/i.test(text)) return 'permission';
  return 'other';
}

/**
 * A count is machine-reported or explicitly unknown. Every field must be present and consistent:
 * passed + failed + pending + todo = total. Failed tests and failed suites are typed by their serialized error.
 */
export function summarize(text) {
  let r; try { r = JSON.parse(String(text)); } catch { return 'unknown'; }
  if (!isObject(r) || FIELDS.some(k => !Number.isSafeInteger(r[k]) || r[k] < 0)) return 'unknown';
  const [total, passed, failed, pending, todo, suites, failedSuites] = FIELDS.map(k => r[k]);
  if (passed + failed + pending + todo !== total || failedSuites > suites) return 'unknown';
  const kinds = { assertion: 0, service: 0, dependency: 0, permission: 0, other: 0 };
  let typedTests = 0;
  for (const file of Array.isArray(r.testResults) ? r.testResults : []) {
    for (const t of Array.isArray(file?.assertionResults) ? file.assertionResults : []) if (t?.status === 'failed') { typedTests++; kinds[failureKind(Array.isArray(t.failureMessages) ? t.failureMessages[0] : '')]++; }
    if (file?.status === 'failed' && !(file.assertionResults ?? []).some(t => t?.status === 'failed')) kinds[failureKind(file.message)]++;
  }
  if (typedTests !== failed) return 'unknown';
  return { total, passed, failed, pending, todo, suites, failedSuites, kinds };
}

export async function run({ repo, out, env, contractPath = CONTRACT_PATH, sandbox = linuxSandbox() }) {
  const startedAt = new Date().toISOString();
  let raw = null, contract = null;
  try { raw = readFileSync(join(repo, contractPath)); contract = JSON.parse(raw.toString('utf8')); } catch { /* reported below */ }
  const head = git(repo, ['rev-parse', 'HEAD']), dirty = git(repo, ['status', '--porcelain=v1', '--untracked-files=all']);
  const evidence = { version: 2, source: { sha: head.status === 0 ? head.stdout.trim() : null, clean: dirty.status === 0 && !dirty.stdout.trim() },
    contract: { path: contractPath, sha256: raw ? sha256(raw) : null }, backend: { ...detectBackend(env), provenance: provenance(env) },
    startedAt, preflight: null, isolation: null, checks: [], result: 'invalid', problems: [] };
  mkdirSync(out, { recursive: true }); chmodSync(out, 0o700);
  if (readdirSync(out).length) { evidence.problems = [{ path: out, detail: 'evidence directory must start empty' }]; }
  mkdirSync(join(out, 'logs'), { recursive: true, mode: 0o700 }); mkdirSync(join(out, 'reports'), { recursive: true, mode: 0o700 });
  const finish = result => {
    rmSync(join(out, '.canary'), { force: true });
    evidence.result = result; evidence.finishedAt = new Date().toISOString();
    writeFileSync(join(out, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 }); return evidence;
  };
  if (evidence.problems.length) return finish('invalid');
  const validation = validateContract(contract);
  if (!raw || validation.errors.length) { evidence.problems = raw ? validation.errors : [{ path: contractPath, detail: 'contract missing or not JSON' }]; return finish('invalid'); }
  if (!evidence.source.sha || !evidence.source.clean) { evidence.problems = [{ path: '.', detail: 'source checkout is not a clean exact commit' }]; return finish('invalid'); }
  const pending = check => ({ id: check.id, covers: check.covers, argvTemplate: check.argv, ...resolved(check), status: 'not-run', exitCode: null, signal: null, count: 'unknown', report: null, log: null });
  evidence.preflight = await preflight({ contract, env, repo, sandbox });
  if (evidence.preflight.status !== 'ready') { evidence.checks = contract.checks.map(pending); return finish('unavailable'); }
  evidence.isolation = await isolate({ sandbox, repo, sha: evidence.source.sha, out, contract, env });
  if (evidence.isolation.problems.length) {
    evidence.preflight = { ...evidence.preflight, status: 'unavailable', problems: evidence.isolation.problems.map(detail => ({ code: 'isolation-unavailable', detail })) };
    evidence.checks = contract.checks.map(pending); return finish('unavailable');
  }
  const canary = readFileSync(join(out, '.canary'), 'utf8');
  const base = { PATH: `${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`, HOME: SANDBOX.home, LANG: 'C.UTF-8', CI: 'true' };
  const pg = contract.capabilities.includes('postgres') ? Object.fromEntries(PG_ENV.filter(k => env[k] !== undefined).map(k => [k, env[k]])) : {};
  for (const check of contract.checks) {
    if (evidence.checks.some(c => c.status !== 'pass')) { evidence.checks.push(pending(check)); continue; }
    const download = check.requires.map(r => DOWNLOADS[r]).find(Boolean);
    let proxy = null, r;
    const unlocked = download ? lockedSources(existsSync(join(repo, check.cwd ?? '.', 'package-lock.json')) ? readFileSync(join(repo, check.cwd ?? '.', 'package-lock.json'), 'utf8') : '', download.registry) : [];
    if (unlocked.length) {
      r = { ...resolved(check), started: Date.now(), status: 'fail', observed: 'unlocked-source', detail: unlocked.join('; '), exitCode: null, signal: null, log: null };
    } else {
      if (download) proxy = await downloadProxy(download.hosts);
      const childEnv = { ...base, ...(check.requires.includes('postgres') || pg.PGHOST ? pg : {}),
        ...(proxy ? { npm_config_registry: download.registry, npm_config_https_proxy: `http://127.0.0.1:${proxy.port}`, npm_config_proxy: `http://127.0.0.1:${proxy.port}`,
          npm_config_ignore_scripts: 'true', npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false', npm_config_strict_ssl: 'true', npm_config_userconfig: '/dev/null', npm_config_globalconfig: '/dev/null' } : {}) };
      r = await execute(check, { out, sandbox, childEnv });
      if (proxy) await proxy.close();
    }
    const survivors = !(await sandbox.kill());
    let count = 'unknown', report = null;
    if (check.report) {
      const bytes = sandbox.read(resolved(check).argv.find(a => a.startsWith(SANDBOX.reports)), LIMITS.reportBytes);
      if (bytes && bytes.length <= LIMITS.reportBytes) {
        writeFileSync(join(out, 'reports', `${check.id}.json`), bytes, { mode: 0o600 });
        report = { path: `reports/${check.id}.json`, bytes: bytes.length, sha256: sha256(bytes) }; count = summarize(bytes);
      }
    }
    let status = r.status;
    if (status === 'pass' && check.count === 'required' && (count === 'unknown' || count.total === 0 || count.failed > 0 || count.pending + count.todo > 0 || count.failedSuites > 0)) status = 'incomplete';
    evidence.checks.push({ id: check.id, covers: check.covers, argvTemplate: check.argv, argv: r.argv, cwd: r.cwd, status, observed: r.observed, ...(r.detail ? { detail: r.detail } : {}),
      exitCode: r.exitCode, signal: r.signal, durationMs: Date.now() - r.started, count, report, ...(proxy ? { downloads: proxy.log } : {}),
      log: r.log ? { path: `logs/${check.id}.log`, ...r.log } : null });
    const breach = [...intact(out, canary), ...(survivors ? ['sandbox processes survived the check'] : [])];
    if (breach.length) {
      evidence.isolation.problems.push(...breach.map(b => `${check.id}: ${b}`));
      evidence.preflight = { ...evidence.preflight, status: 'unavailable', problems: breach.map(detail => ({ code: 'isolation-breach', detail: `${check.id}: ${detail}` })) };
      for (const c of contract.checks.slice(evidence.checks.length)) evidence.checks.push(pending(c));
      return finish('unavailable');
    }
  }
  return finish(evidence.checks.every(c => c.status === 'pass') ? 'pass' : 'fail');
}

const EXIT = { pass: 0, fail: 1, invalid: 2, unavailable: 3 };
export async function main(args, env = process.env, repo = process.cwd(), sandbox = linuxSandbox()) {
  const [mode, ...rest] = args;
  const load = () => { try { return JSON.parse(readFileSync(join(repo, CONTRACT_PATH), 'utf8')); } catch { return null; } };
  if (mode === 'validate' && !rest.length) {
    const v = validateContract(load()); console.log(JSON.stringify({ status: v.errors.length ? 'invalid' : v.unsupported.length ? 'unavailable' : 'valid', ...v }));
    return v.errors.length ? EXIT.invalid : v.unsupported.length ? EXIT.unavailable : 0;
  }
  if (mode === 'preflight' && !rest.length) {
    const contract = load(), v = validateContract(contract);
    if (v.errors.length) { console.log(JSON.stringify({ status: 'invalid', errors: v.errors })); return EXIT.invalid; }
    const p = await preflight({ contract, env, repo, sandbox });
    if (p.backend.kind !== 'github-hosted') {
      const docker = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { encoding: 'utf8', timeout: 5000 });
      p.docker = docker.error ? 'cli-missing' : docker.status === 0 ? 'daemon-running (container backend not implemented)' : 'daemon-unavailable';
    }
    console.log(JSON.stringify(p)); return p.status === 'ready' ? 0 : EXIT.unavailable;
  }
  if (mode === 'run' && rest.length === 2 && rest[0] === '--out') {
    const out = resolve(rest[1]), rel = relative(resolve(repo), out);
    if (!rel.startsWith('..') && !isAbsolute(rel)) { console.error('--out must be outside the checkout'); return EXIT.invalid; }
    const evidence = await run({ repo, out, env, sandbox });
    console.log(JSON.stringify({ result: evidence.result, source: evidence.source, problems: evidence.problems, preflight: evidence.preflight, isolation: evidence.isolation,
      checks: evidence.checks.map(c => ({ id: c.id, status: c.status, exitCode: c.exitCode, count: c.count })) }));
    return EXIT[evidence.result];
  }
  console.error('Usage: node scripts/verify.mjs validate | preflight | run --out <dir outside the checkout>');
  return EXIT.invalid;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
