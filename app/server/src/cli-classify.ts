import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { classify, ClassifyError, labelDecision, recentDecisions } from './classify/index.js';
import { config } from './config.js';
import { pool } from './db.js';

/**
 * `secondbrain classify`: the classify step from a shell (docs/zen-runtime.md, section 4.2). The
 * dispatcher calls the module directly; this is for scripts, Claude Code and Hermes skills, and the
 * owner's review. Exit 3 means fallthrough: do what you did before the classifier existed.
 */
const USAGE = `secondbrain classify: a calibrated yes/no, pick-one or score about one state, logged

  classify <decision> --state-file <json> [--source <channel|folder/>] [--run <id>] [--agent <name>] [--ref <x>] [--json]
      exit 0: act | skip | escalate (the answer is on stdout)   exit 3: fallthrough (no key, privacy, budget, provider)
  classify recent [--decision <d>] [--limit <n>] [--json]      the latest decisions, for a ten-minute review
  classify label <id> right|wrong                              a person's verdict on one decision

Schemas: <vault>/.agents/classify/<decision>.json, else the engine's defaults (wake-gate, card-tier, run-outcome).
Nothing is sent unless --source matches an entry of secondbrain.json classify.allow.`;

type Args = { pos: string[]; opts: Record<string, string | true> };

export function parseArgs(argv: string[]): Args {
  const pos: string[] = [];
  const opts: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) { pos.push(a); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) opts[key] = true;
    else { opts[key] = next; i++; }
  }
  return { pos, opts };
}

const str = (v: string | true | undefined): string | undefined => (typeof v === 'string' ? v : undefined);

function table(rows: Awaited<ReturnType<typeof recentDecisions>>): string {
  if (!rows.length) return 'no decisions yet';
  const cols = ['id', 'when', 'decision', 'action', 'answer', 'conf', 'agent', 'ref', 'label', 'error'];
  const data = rows.map((r) => [String(r.id), r.created_at.toISOString().slice(0, 16).replace('T', ' '), r.decision, r.action, r.answer ?? '-',
    r.confidence === null ? '-' : r.confidence.toFixed(2), r.agent_name ?? '-', r.ref ?? '-', r.label ?? '', r.error ?? '']);
  const w = cols.map((c, i) => Math.max(c.length, ...data.map((d) => d[i]!.length)));
  const line = (d: string[]) => d.map((x, i) => x.padEnd(w[i]!)).join('  ').trimEnd();
  return [line(cols), ...data.map(line)].join('\n');
}

export async function main(argv: string[], out: (s: string) => void = console.log): Promise<number> {
  const [cmd, ...rest] = argv;
  const { pos, opts } = parseArgs(rest);
  const json = opts.json === true;
  switch (cmd) {
    case undefined:
    case 'help':
    case '--help':
      out(USAGE);
      return 0;
    case 'recent': {
      const rows = await recentDecisions({ decision: str(opts.decision), limit: opts.limit ? Number(opts.limit) : undefined });
      out(json ? JSON.stringify(rows, null, 2) : table(rows));
      return 0;
    }
    case 'label': {
      const [id, label] = pos;
      if (!id || !/^\d+$/.test(id) || (label !== 'right' && label !== 'wrong')) throw new ClassifyError('label <id> right|wrong');
      const ok = await labelDecision(Number(id), label, config.orgOwner);
      if (!ok) throw new ClassifyError(`no decision ${id}`);
      out(`decision ${id} labelled ${label}`);
      return 0;
    }
    default: {
      const file = str(opts['state-file']);
      if (!file) throw new ClassifyError(`classify ${cmd} needs --state-file <json>`);
      let state: unknown;
      try {
        state = JSON.parse(readFileSync(file, 'utf8'));
      } catch (err) {
        throw new ClassifyError(`${file}: ${(err as Error).message}`);
      }
      if (!state || typeof state !== 'object' || Array.isArray(state)) throw new ClassifyError(`${file}: the state must be a JSON object`);
      const r = await classify({
        decision: cmd, state: state as Record<string, unknown>, source: str(opts.source) ?? null,
        runId: str(opts.run) ?? null, agentName: str(opts.agent) ?? null, ref: str(opts.ref) ?? null,
      });
      out(json ? JSON.stringify(r) : `${r.action}${r.answer ? ` ${r.answer}` : ''}${r.confidence !== null ? ` (${r.confidence.toFixed(2)})` : ''}${r.error ? ` ${r.error}` : ''}${r.cached ? ' cached' : ''}`);
      return r.action === 'fallthrough' ? 3 : 0;
    }
  }
}

if (process.argv[1]?.endsWith('cli-classify.js') || process.argv[1]?.endsWith('cli-classify.ts')) {
  let code = 1;
  try {
    code = await main(process.argv.slice(2));
  } catch (err) {
    if (err instanceof ClassifyError) console.error(err.message);
    else if (err instanceof z.ZodError) console.error(err.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('\n'));
    else console.error(err instanceof Error ? err.message : String(err));
  } finally {
    await pool.end();
  }
  process.exit(code);
}
