import { exitFlushed } from './cli-exit.js';
import { z } from 'zod';
import { config } from './config.js';
import { pool, setDatabaseUrl } from './db.js';
import { getAgent, createTask, OrgError } from './org.js';
import { factById, factStats, forget, listFacts, recallFacts, recallMemoryFiles, remember, type Fact, type RecallHit } from './org-powers.js';
import { runCapture } from './memory-capture.js';
import { recallVault } from './recall.js';
import { settings } from './settings.js';
import { agentDatabaseUrl, identityName, parseArgs } from './cli-org.js';

/**
 * `secondbrain memory` (docs/memory.md, engine core v2 phase 6): the one door onto the shared memory.
 *
 * One store, `memory_facts`: a claim with a source, written by `remember`, read by `recall`, retired by `retire`. The
 * `agent` column tags a claim as one bot's own memory (the persona rows import here); a claim with no agent is
 * company-wide and any agent may recall it. Facts finished sessions proposed are decided on the /memory page, not here.
 */

const USAGE = `secondbrain memory: the shared memory every runtime recalls (a claim with a source, or it is not a fact).

  memory recall "<query>" [--project p] [--limit N] [--json]    the facts, the memory files, then the vault (keyword + vector)
  memory remember "<subject>" "<claim>" --source <path|#msg|t_card|url>
      [--project p] [--agent a] [--inferred] [--supersedes id] [--via runtime@host]   a sourced claim; --agent tags it as one bot's
  memory list [--subject s] [--project p] [--author a] [--agent a] [--all] [--limit N] [--json]    the current facts (--all includes retired)
  memory retire <id> "<why>"       close a claim that no longer holds (never a hard delete)
  memory propose <fact-id> [--dry-run]   open one improve card on the owner's backlog from a fact (a lesson that keeps
                                    recurring); a person applies it, never a bot
  memory stats [--json]            counts: current and retired facts, by agent and author, open candidates
  memory capture [--dry-run] [--agent a] [--limit N] [--all] [--force] [--json]
                                    the capture loop (memory.capture in secondbrain.json): read the finished wakes
                                    and write the durable lessons as facts. --all ignores the age window, --force the
                                    cadence

A memory is a claim with a source, never a status check-in; card status lives on the board.`;

const KNOWN: Record<string, string[]> = {
  recall: ['project', 'limit', 'json'],
  remember: ['source', 'project', 'agent', 'inferred', 'supersedes', 'via', 'json'],
  list: ['subject', 'project', 'author', 'agent', 'all', 'limit', 'json'],
  retire: ['json'],
  propose: ['dry-run', 'json'],
  stats: ['json'],
  capture: ['dry-run', 'agent', 'limit', 'all', 'force', 'json'],
  help: [],
};

function str(v: string | true | undefined): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function num(v: string | true | undefined, flag: string): number | undefined {
  if (v === undefined || v === true) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n)) throw new OrgError(`--${flag} takes a whole number, not "${v}"`);
  return n;
}

/** An unknown flag is a hard error (never a silent drop): the caller's typo must not become a missing filter. */
function checkFlags(cmd: string, opts: Record<string, string | true>): void {
  const known = KNOWN[cmd] ?? [];
  for (const k of Object.keys(opts)) if (!known.includes(k)) throw new OrgError(`memory ${cmd}: unknown flag --${k} (${known.map((x) => `--${x}`).join(', ') || 'no flags'})`);
}

function when(d: Date): string {
  return d.toISOString().slice(0, 16).replace('T', ' ');
}

function formatFact(f: Fact): string {
  const agent = f.agent ? ` [${f.agent}'s]` : '';
  return `#${f.id}${agent} ${f.subject}: ${f.claim}  [${f.confidence}, ${f.source}, ${f.author}${f.via ? ` via ${f.via}` : ''}, ${when(new Date(f.valid_from))}${f.valid_to ? `, closed ${when(new Date(f.valid_to))}${f.retired_why ? `: ${f.retired_why}` : ''}` : ''}]`;
}

async function main(argv: string[], out: (s: string) => void = console.log): Promise<number> {
  const [cmd, ...rest] = argv;
  const sub = cmd && KNOWN[cmd] ? cmd : cmd === undefined || cmd === 'help' || cmd === '--help' ? 'help' : null;
  if (sub === null) throw new OrgError(`memory: no "${cmd}" verb; run \`secondbrain memory help\``);
  const { pos, opts } = parseArgs(sub === 'help' ? [] : rest);
  checkFlags(sub, opts);
  const json = opts.json === true;

  if (sub === 'help') {
    out(USAGE);
    return 0;
  }

  // The vault arm runs on the app's own connection (sb_org has no grant on the index), before any switch to a bot's.
  // The capture loop also stays on the app's own connection: it writes as the table owner, and memory_facts' write
  // policy would refuse an agent identity.
  const vaultHits = sub === 'recall' && pos[0] ? await recallVault(pos[0], num(opts.limit, 'limit') ?? 8, process.env, settings().memory.exclude) : null;
  if (sub !== 'capture' && process.env.ORG_AGENT?.trim() && process.env.SB_ORG_DB_URL) setDatabaseUrl(agentDatabaseUrl(process.env.SB_ORG_DB_URL, identityName()));
  const me = async (): Promise<{ name: string }> => (process.env.ORG_AGENT?.trim() ? await getAgent(identityName()) : { name: config.orgOwner });

  switch (sub) {
    case 'recall': {
      const [q] = pos;
      if (!q) throw new OrgError('recall "<query>" [--project p] [--limit N]');
      const limit = num(opts.limit, 'limit') ?? 8;
      const hits: RecallHit[] = [
        ...(await recallFacts(q, { project: str(opts.project), limit })),
        ...recallMemoryFiles(config.vaultRoot, q, Math.ceil(limit / 2)),
        ...(vaultHits ?? []),
      ];
      if (json) return (out(JSON.stringify(hits, null, 2)), 0);
      if (!hits.length) return (out('nothing found; try other words, or it is not written down yet'), 0);
      for (const h of hits) out(`[${h.source}] ${h.ref}${h.title && h.source !== 'memory' ? `  ${h.title}` : ''}\n  ${h.text.replace(/\s+/g, ' ').slice(0, 400)}`);
      return 0;
    }
    case 'remember': {
      const [subject, claim] = pos;
      const source = str(opts.source);
      if (!subject || !claim || !source) throw new OrgError('remember "<subject>" "<claim>" --source <path|#msg|t_card|url> [--project p] [--agent a] [--inferred] [--supersedes id]');
      const f = await remember(await me(), {
        subject, claim, source, project: str(opts.project), agent: str(opts.agent), inferred: opts.inferred === true,
        supersedes: num(opts.supersedes, 'supersedes'), via: str(opts.via) ?? process.env.ORG_VIA,
      });
      out(json ? JSON.stringify(f) : `fact #${f.id} saved${f.agent ? ` (${f.agent}'s memory)` : ''}${f.supersedes ? ` (closes #${f.supersedes})` : ''}`);
      return 0;
    }
    case 'list': {
      const fs = await listFacts({
        subject: str(opts.subject), project: str(opts.project), author: str(opts.author), agent: str(opts.agent),
        all: opts.all === true, limit: num(opts.limit, 'limit'),
      });
      if (json) return (out(JSON.stringify(fs, null, 2)), 0);
      out(fs.length ? fs.map(formatFact).join('\n') : 'no facts');
      return 0;
    }
    case 'retire': {
      const id = num(pos[0], 'id');
      if (id === undefined || !pos[1]) throw new OrgError('retire <id> "<why>"');
      await forget(await me(), id, pos[1]);
      out(`fact #${id} closed`);
      return 0;
    }
    case 'propose': {
      const id = num(pos[0], 'id');
      if (id === undefined) throw new OrgError('propose <fact-id> [--dry-run]');
      const f = await factById(id);
      if (!f) throw new OrgError(`no fact #${id}`);
      if (f.valid_to) throw new OrgError(`fact #${id} is retired; nothing to propose`);
      const title = `self-improvement: ${f.agent ?? 'company-wide'}, ${f.subject}`.slice(0, 200);
      if (opts['dry-run'] === true) {
        out(json ? JSON.stringify({ fact_id: id, title, card: null }) : `would open a card: ${title}`);
        return 0;
      }
      const caller = await getAgent((await me()).name);
      const body = [
        `Self-improvement proposal for ${caller.name}, from fact #${f.id}: ${f.subject}`,
        '',
        `**Claim:** ${f.claim}`,
        `**Source:** ${f.source}${f.agent ? ` (${f.agent}'s memory)` : ''}`,
        '',
        'A person applies this: edit the prompt, the skill file or the config the claim is about, then close the card. A bot never applies a change to itself.',
      ].join('\n');
      const card = await createTask(caller, { assignee: null, title, body, kind: 'improve', priority: 3 });
      out(json ? JSON.stringify({ fact_id: id, title, card: card.task_id }) : `card ${card.task_id} for the owner: ${title}`);
      return 0;
    }
    case 'stats': {
      const s = await factStats();
      if (json) return (out(JSON.stringify(s, null, 2)), 0);
      out(`${s.current} current facts (${s.retired} retired), ${s.candidates_open} candidate(s) waiting on the /memory page`);
      out(`by author: ${s.by_author.map((a) => `${a.author} ${a.n}`).join(', ') || 'none'}`);
      out(`by agent: ${s.by_agent.map((a) => `${a.agent ?? '(company-wide)'} ${a.n}`).join(', ') || 'none'}`);
      return 0;
    }
    case 'capture': {
      const r = await runCapture({
        dryRun: opts['dry-run'] === true,
        agent: str(opts.agent),
        all: opts.all === true,
        force: opts.force === true,
        limit: num(opts.limit, 'limit'),
        log: json ? undefined : (m) => out(m),
      });
      if (json) return (out(JSON.stringify(r, null, 2)), 0);
      out(`capture: ${r.considered} wake(s) read, ${r.processed} answered, ${r.facts} fact(s) ${opts['dry-run'] === true ? 'would be ' : ''}written, ${r.skipped} skipped, ${r.failed} failed`);
      return 0;
    }
    default:
      out(USAGE);
      return 1;
  }
}

export { main };

if (process.argv[1]?.endsWith('cli-memory.js') || process.argv[1]?.endsWith('cli-memory.ts')) {
  let code = 1;
  try {
    code = await main(process.argv.slice(2));
  } catch (err) {
    if (err instanceof OrgError) console.error(err.message);
    else if (err instanceof z.ZodError) console.error(err.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('\n'));
    else console.error(err instanceof Error ? err.message : String(err));
  } finally {
    await pool.end();
  }
  await exitFlushed(code);
}
