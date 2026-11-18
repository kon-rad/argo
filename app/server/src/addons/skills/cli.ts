import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ChangeKindSchema, ChangeRequestSchema, RuntimeSchema, type ChangePreview, type SkillRuntime } from '@secondbrain/contracts/skills';
import { parseArgs } from '../../cli-args.js';
import { LifecycleError } from './lifecycle.js';
import { ackPayload, inspectRoot, packBundle, planFromBundle, planViews, readCurrent, ReconcileError, sendAck, syncViews, type SyncReport } from './reconcile.js';
import { expandPath, type SkillsService } from './service.js';

/**
 * `secondbrain skills ...`: the same service the web app uses. Every command that changes something
 * says what it changed and what it did not: a proposal is not applied, an applied change is a branch
 * awaiting review, and a sync reports per view whether it activated, kept a dirty view or failed.
 */

export const USAGE = `secondbrain skills <command>

Inspect
  list [--json] [--refresh]                 the library: every candidate, effective source, digest, revision, flags
  show <name> [--id <candidate>] [--json]   one skill: candidates, files, history, agents, hosts
  matrix [--agent <name>] [--json]          agents x skills with the state of each pair
  explain <agent> <skill>                   why an agent has (or lacks) a skill
  machines [--json]                         desired vs acknowledged digests per host (needs the database)

Change (writes only drafts and proposals; nothing becomes active here)
  draft list | draft show <name>
  draft new <name> [--from <name|candidate-id>] [--description <text>]
  draft write <name> <package-path> --file <local-file> [--exec]
  draft rm <name>
  preview <kind> <skill> [--draft <name>] [--replacement <skill>] [--note <text>] [--revision <sha>] [--resolve]
  propose <kind> <skill> [same options]     export the change for review
      kinds: create | update | disable | deprecate | restore | remove | rollback
  changes [--json]                          proposed changes and their status
  apply <change-id>                         commit it on branch skills/<id> (temporary worktree; your checkout is untouched)

Deploy to this machine
  sync [--agents a,b] [--runtime zen-agent|claude-code|hermes] [--root <dir>] [--bundle <file>] [--repair]
       [--ack --server <url> [--token-file <file>]]
  pack --out <file> [--agents a,b] [--runtime <r>]   a bundle for a host with no vault checkout (copy it yourself)
  status [--root <dir>] [--json]                     verify deployed views against their digests
  ack --server <url> [--root <dir>] [--token-file <file>]   send this machine's state (device token: SB_LEDGER_TOKEN)
  view-path <agent> [--runtime <r>] [--root <dir>]   the folder to point a runtime at
`;

export interface CliIo { out: (s: string) => void; err: (s: string) => void; env: NodeJS.ProcessEnv; fetch?: typeof fetch; engine?: string | null }

const short = (d: string | null | undefined, n = 12) => (d ? d.replace('sha256:', '').slice(0, n) : '-');

function printPreview(io: CliIo, p: ChangePreview): void {
  io.out(`${p.summary}`);
  io.out(`  validation: ${p.validation.valid ? 'ok' : 'FAILED'}${p.validation.errors.length ? ` (${p.validation.errors.join('; ')})` : ''}`);
  for (const w of p.validation.warnings) io.out(`  warning: ${w}`);
  io.out(`  base ${short(p.baseDigest)} @ ${short(p.baseRevision)}  ->  target ${short(p.targetDigest)}`);
  io.out(`  agents affected: ${p.affectedAgents.join(', ') || 'none'}`);
  io.out(`  hosts affected:  ${p.affectedHosts.join(', ') || 'none acknowledged'}`);
  if (p.dependents.length) io.out(`  depended on by: ${p.dependents.join(', ')}`);
  for (const f of p.files) io.out(`\n${f.diff}`);
  if (p.policyDiff) io.out(`\n${p.policyDiff}`);
  io.out(`\n  running sessions: ${p.runningSessions}`);
  if (p.blocked.length) io.out(`\n  BLOCKED:\n${p.blocked.map((b) => `    - ${b}`).join('\n')}`);
}

function token(io: CliIo, file: string | true | undefined): string {
  if (typeof file === 'string') {
    const st = statSync(file);
    if (st.mode & 0o077) throw new ReconcileError(`${file} is readable by other users; chmod 600 it`);
    return readFileSync(file, 'utf8').trim();
  }
  const t = io.env['SB_LEDGER_TOKEN'];
  if (!t) throw new ReconcileError('no device token: set SB_LEDGER_TOKEN or pass --token-file (create one on the server with `secondbrain ingest-device add <host>`)');
  return t;
}

async function ack(io: CliIo, report: Pick<SyncReport, 'policyDigest' | 'views'>, server: string | true | undefined, tokenFile: string | true | undefined): Promise<boolean> {
  const url = typeof server === 'string' ? server : io.env['SECONDBRAIN_SERVER'];
  if (!url) throw new ReconcileError('--server <url> (or SECONDBRAIN_SERVER) is required to acknowledge');
  const r = await sendAck(url, token(io, tokenFile), ackPayload(report, io.engine ?? null), io.fetch);
  if (r.ok) io.out(`acknowledged to ${url}: ${r.body}`);
  else io.err(`acknowledgement refused (HTTP ${r.status}): ${r.body}. The deployment on this machine is unchanged; the server still shows the previous acknowledgement.`);
  return r.ok;
}

function changeRequest(kind: string, skill: string, opts: Record<string, string | true>) {
  return ChangeRequestSchema.parse({
    kind: ChangeKindSchema.parse(kind), skill,
    ...(typeof opts['draft'] === 'string' ? { draft: opts['draft'] } : ['create', 'update'].includes(kind) ? { draft: skill } : {}),
    ...(typeof opts['replacement'] === 'string' ? { replacement: opts['replacement'] } : {}),
    ...(typeof opts['note'] === 'string' ? { note: opts['note'] } : {}),
    ...(typeof opts['revision'] === 'string' ? { revision: opts['revision'] } : {}),
    ...(opts['resolve'] ? { resolve: true } : {}),
  });
}

export async function runSkillsCli(argv: string[], service: SkillsService, io: CliIo): Promise<number> {
  const { pos, opts } = parseArgs(argv);
  const [cmd, ...args] = pos;
  const json = opts['json'] === true;
  const root = typeof opts['root'] === 'string' ? expandPath(service.vaultRoot, opts['root']) : service.managedRoot;
  const runtime = typeof opts['runtime'] === 'string' ? (RuntimeSchema.parse(opts['runtime']) as SkillRuntime) : undefined;
  const agents = typeof opts['agents'] === 'string' ? opts['agents'].split(',').map((s) => s.trim()).filter(Boolean) : undefined;
  try {
    switch (cmd) {
      case 'list': {
        const lib = await service.library(opts['refresh'] === true);
        if (json) { io.out(JSON.stringify(lib, null, 2)); return 0; }
        io.out(`mode: ${lib.mode}${lib.policy.exists ? ` (policy ${lib.policy.file}${lib.policy.valid ? '' : ', INVALID'})` : ' (no policy file: legacy behaviour)'}`);
        for (const e of lib.policy.errors) io.out(`  policy error: ${e}`);
        for (const r of lib.roots) io.out(`root ${r.id}: ${r.label} ${r.exists ? `${r.packages} packages${r.git ? `, git ${short(r.revision)}` : ', not git'}` : 'missing'}${r.error ? ` (${r.error})` : ''}`);
        for (const s of lib.skills) {
          const e = s.effective;
          const flags = [s.flags.override && 'override', s.flags.duplicate && 'duplicate', s.flags.invalid && 'invalid', s.flags.dirty && 'dirty', s.lifecycle.status !== 'active' && s.lifecycle.status].filter(Boolean).join(',');
          io.out([s.name, e?.id ?? '-', short(e?.digest), short(e?.revision), `assigned ${s.assigned}`, flags || '-'].join('\t'));
        }
        return 0;
      }
      case 'show': {
        if (!args[0]) break;
        const d = await service.detail(args[0], typeof opts['id'] === 'string' ? opts['id'] : undefined);
        if (!d) { io.err(`no skill ${args[0]}`); return 1; }
        if (json) { io.out(JSON.stringify(d, null, 2)); return 0; }
        io.out(`${d.name}: ${d.selected?.description ?? ''}`);
        for (const c of d.row.candidates) io.out(`  ${c.effective ? '*' : ' '} ${c.id}  ${short(c.digest)}  rev ${short(c.revision)}${c.dirty ? ' dirty' : ''}${c.linkOf ? ` link of ${c.linkOf}` : ''}${c.valid ? '' : `  INVALID: ${c.errors.join('; ')}`}`);
        io.out(`  lifecycle: ${d.row.lifecycle.status}${d.row.lifecycle.replacement ? ` -> ${d.row.lifecycle.replacement}` : ''}`);
        io.out(`  files: ${d.files.map((f) => f.path).join(', ')}`);
        for (const a of d.agents.filter((x) => x.state !== 'not-assigned' || x.reference)) io.out(`  ${a.agent}: ${a.state}${a.reference ? ' (knowledge reference)' : ''}`);
        for (const h of d.hosts) io.out(`  host ${h.host} ${h.agent}/${h.runtime}: ${h.state} ${short(h.observed)}`);
        return 0;
      }
      case 'matrix': {
        const m = await service.matrix();
        const only = typeof opts['agent'] === 'string' ? opts['agent'] : null;
        if (json) { io.out(JSON.stringify(only ? { ...m, cells: m.cells.filter((c) => c.agent === only) } : m, null, 2)); return 0; }
        io.out(`mode: ${m.mode}`);
        for (const a of m.agents.filter((x) => !only || x.name === only)) {
          io.out(`${a.name} (${a.runtime}, ${a.support}): ${m.cells.filter((c) => c.agent === a.name && c.state === 'assigned').map((c) => c.skill).join(', ') || (m.mode === 'legacy' ? 'every skill (legacy)' : 'none')}`);
        }
        return 0;
      }
      case 'explain': {
        if (!args[0] || !args[1]) break;
        const a = await service.agent(args[0]);
        if (!a) { io.err(`no agent ${args[0]}`); return 1; }
        const c = a.cells.find((x) => x.skill === args[1]);
        io.out(`${args[0]} / ${args[1]}: ${c?.state ?? (a.mode === 'legacy' ? 'legacy' : 'not-assigned')}`);
        for (const r of c?.reasons ?? []) io.out(`  ${r.kind} (${r.level}): ${r.detail}`);
        io.out(`  loaded: ${c?.loaded ? `${c.loaded.detail} at ${c.loaded.at}` : 'no load recorded'}`);
        io.out(`  runtime ${a.agent.runtime}: ${a.agent.support}. ${a.agent.supportNote}`);
        return 0;
      }
      case 'machines': {
        const m = await service.machines();
        if (json) { io.out(JSON.stringify(m, null, 2)); return 0; }
        for (const n of m.notes) io.out(`note: ${n}`);
        for (const h of m.hosts) {
          io.out(`${h.host}: ${h.status}${h.lastAck ? ` (last ack ${h.lastAck})` : ''}`);
          for (const v of h.views) io.out(`  ${v.agent}/${v.runtime}: ${v.status} ${short(v.viewDigest)}${v.error ? ` ${v.error}` : ''}${v.missing.length ? ` missing ${v.missing.map((x) => `${x.skill}[${[...x.bins, ...x.env].join(',')}]`).join(' ')}` : ''}`);
        }
        return 0;
      }
      case 'draft': {
        const [sub, name, path] = args;
        if (sub === 'list') { for (const d of await service.drafts()) io.out(`${d.name}\t${d.validation.valid ? 'valid' : 'invalid'}\t${short(d.digest)}\tbase ${d.base?.id ?? 'new'}`); return 0; }
        if (sub === 'show' && name) { io.out(JSON.stringify(await service.draft(name), null, 2)); return 0; }
        if (sub === 'new' && name) {
          const d = await service.createDraft(name, typeof opts['from'] === 'string' ? opts['from'] : undefined, typeof opts['description'] === 'string' ? opts['description'] : undefined);
          io.out(`draft ${d.name} saved (${d.files.length} files, ${d.validation.valid ? 'valid' : `invalid: ${d.validation.errors.join('; ')}`}). It is not active; preview and propose it to change anything.`);
          return 0;
        }
        if (sub === 'write' && name && path && typeof opts['file'] === 'string') {
          const content = readFileSync(opts['file'], 'utf8');
          const d = await service.writeDraftFile(name, path, content, opts['exec'] === true ? true : undefined);
          io.out(`draft ${name}: wrote ${path}. Digest ${short(d.digest)}; ${d.validation.valid ? 'valid' : `invalid: ${d.validation.errors.join('; ')}`}. Not active.`);
          return 0;
        }
        if (sub === 'rm' && name) { await service.deleteDraft(name); io.out(`draft ${name} deleted`); return 0; }
        break;
      }
      case 'preview':
      case 'propose': {
        if (!args[0] || !args[1]) break;
        const req = changeRequest(args[0], args[1], opts);
        if (cmd === 'preview') {
          const p = await service.preview(req);
          if (json) io.out(JSON.stringify(p, null, 2)); else { printPreview(io, p); io.out('\nThis was a preview. Nothing was saved.'); }
          return p.blocked.length ? 2 : 0;
        }
        const c = await service.propose(req);
        if (json) { io.out(JSON.stringify(c, null, 2)); return 0; }
        printPreview(io, c.preview);
        io.out(`\nExported for review as change ${c.id}. Nothing is active yet. Next: secondbrain skills apply ${c.id}`);
        return 0;
      }
      case 'changes': {
        const list = await service.changes();
        if (json) { io.out(JSON.stringify(list, null, 2)); return 0; }
        if (!list.length) io.out('no proposed changes');
        for (const c of list) io.out(`${c.id}\t${c.status}${c.branch ? `\t${c.branch} @ ${short(c.commit)}` : ''}\t${c.preview.summary}`);
        return 0;
      }
      case 'apply': {
        if (!args[0]) break;
        const r = await service.apply(args[0]);
        io.out(`Committed ${r.worktreeFiles.join(', ')} on branch ${r.branch} (${r.commit.slice(0, 12)}). Your checkout was not changed.`);
        io.out(`Not live yet. Review it the usual way, e.g.: git push -u origin ${r.branch} && gh pr create --head ${r.branch}`);
        io.out('After it is merged, run `secondbrain skills sync` on each machine.');
        return 0;
      }
      case 'pack': {
        if (typeof opts['out'] !== 'string') break;
        const s = await service.current(true);
        const bundle = packBundle(planViews(s.catalog, s.policy, s.roster, { agents, runtime }));
        writeFileSync(opts['out'], JSON.stringify(bundle), { mode: 0o600 });
        io.out(`wrote ${opts['out']}: ${bundle.views.length} views, ${Object.keys(bundle.packages).length} packages, policy ${short(bundle.policyDigest)}. Copy it to the host and run: secondbrain skills sync --bundle <file>`);
        return 0;
      }
      case 'sync': {
        let plan;
        if (typeof opts['bundle'] === 'string') {
          plan = planFromBundle(JSON.parse(readFileSync(opts['bundle'], 'utf8')));
          if (agents) plan.views = plan.views.filter((v) => agents.includes(v.agent));
          if (runtime) plan.views = plan.views.filter((v) => v.runtime === runtime);
        } else {
          const s = await service.current(true);
          plan = planViews(s.catalog, s.policy, s.roster, { agents, runtime });
        }
        if (opts['dry-run']) {
          for (const v of plan.views) io.out(`${v.agent}/${v.runtime}: ${v.skills.map((x) => `${x.name}@${short(x.digest, 8)}`).join(' ') || '(none)'}${v.excluded.length ? `; excluded ${v.excluded.map((x) => x.name).join(', ')}` : ''}`);
          io.out('dry run: nothing deployed');
          return 0;
        }
        const report = syncViews(root, plan, { repair: opts['repair'] === true, env: io.env });
        let failed = 0;
        for (const v of report.views) {
          if (v.status !== 'current') failed++;
          io.out(`${v.agent}/${v.runtime}: ${v.status} ${short(v.viewDigest)} (${v.skills.length} skills)${v.error ? `: ${v.error}` : ''}`);
          for (const m of v.missing) io.out(`  ${m.skill} needs ${[...m.bins.map((b) => `program ${b}`), ...m.env.map((e) => `env ${e}`)].join(', ')} (not installed by sync)`);
        }
        io.out(`managed root: ${root}`);
        if (opts['ack']) { if (!(await ack(io, report, opts['server'], opts['token-file']))) return 3; }
        return failed ? 2 : 0;
      }
      case 'status': {
        const views = inspectRoot(root);
        if (json) { io.out(JSON.stringify({ root, views }, null, 2)); return 0; }
        if (!existsSync(root)) io.out(`no managed root at ${root}`);
        for (const v of views) io.out(`${v.agent}/${v.runtime}: ${v.status} ${short(v.viewDigest)} generated ${v.generatedAt}${v.error ? `: ${v.error}` : ''}`);
        return views.some((v) => v.status !== 'current') ? 2 : 0;
      }
      case 'ack': {
        let last: { policyDigest: string | null } = { policyDigest: null };
        try { last = JSON.parse(readFileSync(join(root, 'state.json'), 'utf8')); } catch { /* never synced */ }
        return (await ack(io, { policyDigest: last.policyDigest, views: inspectRoot(root) }, opts['server'], opts['token-file'])) ? 0 : 3;
      }
      case 'view-path': {
        if (!args[0]) break;
        const rt = runtime ?? 'claude-code';
        const cur = readCurrent(root, args[0], rt);
        if (!cur.manifest) { io.err(`no ${rt} view for ${args[0]} under ${root}; run secondbrain skills sync --agents ${args[0]} --runtime ${rt}`); return 1; }
        io.out(join(root, 'views', args[0], rt));
        return 0;
      }
      case 'help':
      case undefined:
        io.out(USAGE);
        return 0;
    }
    io.err(USAGE);
    return 1;
  } catch (err) {
    if (err instanceof LifecycleError || err instanceof ReconcileError) { io.err(`skills: ${err.message}`); return err instanceof LifecycleError && err.status === 409 ? 2 : 1; }
    if ((err as { name?: string }).name === 'ZodError') { io.err(`skills: ${(err as Error).message}`); return 1; }
    throw err;
  }
}
