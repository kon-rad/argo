import { exitFlushed } from './cli-exit.js';
import { z } from 'zod';
import { config } from './config.js';
import { pool, setDatabaseUrl } from './db.js';
import { getAgent, OrgError } from './org.js';
import { factStats, forget, listFacts, recallFacts, recallMemoryFiles, remember, type Fact, type RecallHit } from './org-powers.js';
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
  memory stats [--json]            counts: current and retired facts, by agent and author, open candidates

A memory is a claim with a source, never a status check-in; card status lives on the board.`;

const KNOWN: Record<string, string[]> = {
  recall: ['project', 'limit', 'json'],
  remember: ['source', 'project', 'agent', 'inferred', 'supersedes', 'via', 'json'],
  list: ['subject', 'project', 'author', 'agent', 'all', 'limit', 'json'],
  retire: ['json'],
  stats: ['json'],
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
  const vaultHits = sub === 'recall' && pos[0] ? await recallVault(pos[0], num(opts.limit, 'limit') ?? 8, process.env, settings().memory.exclude) : null;
  if (process.env.ORG_AGENT?.trim() && process.env.SB_ORG_DB_URL) setDatabaseUrl(agentDatabaseUrl(process.env.SB_ORG_DB_URL, identityName()));
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
    case 'stats': {
      const s = await factStats();
      if (json) return (out(JSON.stringify(s, null, 2)), 0);
      out(`${s.current} current facts (${s.retired} retired), ${s.candidates_open} candidate(s) waiting on the /memory page`);
      out(`by author: ${s.by_author.map((a) => `${a.author} ${a.n}`).join(', ') || 'none'}`);
      out(`by agent: ${s.by_agent.map((a) => `${a.agent ?? '(company-wide)'} ${a.n}`).join(', ') || 'none'}`);
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
