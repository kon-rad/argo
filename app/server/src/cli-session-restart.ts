#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { config } from './config.js';
import { pool, query } from './db.js';
import { portableSession } from './archive/portable.js';
import { launchSpec, type RestartHarness } from './archive/restart.js';

const USAGE = `secondbrain session-restart <host> <session-id> --source <archive-source>
  --harness claude-code|codex|hermes|zen-agent --provider <name> --model <id>
  [--persona <roster-name>] [--request <new instruction>] [--dry-run]
  [--api http://127.0.0.1:5123 --token-env KNOWLEDGE_TOKEN]

Runs a new session on this machine from the archived conversation. The source is unchanged.
The machine needs the chosen harness, model credentials and access to the archive database.`;

async function main(): Promise<number> {
  const { values: v, positionals: p } = parseArgs({
    args: process.argv.slice(2), allowPositionals: true,
    options: {
      source: { type: 'string' }, harness: { type: 'string' }, provider: { type: 'string' },
      model: { type: 'string' }, persona: { type: 'string' }, request: { type: 'string' },
      'request-file': { type: 'string' }, 'dry-run': { type: 'boolean' }, help: { type: 'boolean' },
      api: { type: 'string' }, 'token-env': { type: 'string' },
    },
  });
  if (v.help) { console.log(USAGE); return 0; }
  const [host, externalId] = p;
  if (!host || !externalId || p.length !== 2 || !v.source || !v.harness || !v.provider || !v.model) {
    throw new Error(USAGE);
  }
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(host)) throw new Error('invalid host');
  let request = v['request-file'] ? readFileSync(v['request-file'], 'utf8') : v.request ?? '';
  if (!request && process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    request = await rl.question('New request for the restarted session: ');
    rl.close();
  }
  let session: ReturnType<typeof portableSession>;
  if (v.api) {
    const base = new URL(v.api);
    if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)) {
      throw new Error('--api must be a loopback HTTP endpoint; use an SSH tunnel for another machine');
    }
    const tokenName = v['token-env'] ?? 'KNOWLEDGE_TOKEN';
    if (!/^[A-Z][A-Z0-9_]*$/.test(tokenName)) throw new Error('invalid token variable name');
    const token = process.env[tokenName];
    if (!token) throw new Error(`${tokenName} is not set`);
    const url = new URL(`/api/usage/agent-sessions/${encodeURIComponent(host)}/${encodeURIComponent(externalId)}/portable`, base);
    url.searchParams.set('source', v.source);
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, redirect: 'error' });
    if (!response.ok) throw new Error(`archive API returned HTTP ${response.status}`);
    session = await response.json() as ReturnType<typeof portableSession>;
  } else {
    const found = await query<{ id: number; harness: string }>(
      `SELECT id, harness FROM archive_sessions WHERE host=$1 AND external_id=$2 AND source=$3`, [host, externalId, v.source]);
    const s = found.rows[0];
    if (!s) throw new Error('no such session in the archive');
    const { rows } = await query<{ id: number; role: string; kind: string; ts: Date | null; raw: unknown; text: string }>(
      `SELECT id, role, kind, ts, raw, coalesce(content_text, '') AS text
       FROM archive_messages WHERE session_id=$1 ORDER BY seq LIMIT 50001`, [s.id]);
    if (rows.length > 50000 || rows.reduce((n, row) => n + row.text.length, 0) > 2_000_000) {
      throw new Error('portable transcript limit exceeded (50,000 records or 2 million characters)');
    }
    session = portableSession({ host, harness: s.harness, external_id: externalId, archive_id: s.id }, rows);
  }
  const spec = launchSpec(session, {
    harness: v.harness as RestartHarness, provider: v.provider, model: v.model,
    persona: v.persona ?? null, request, vaultRoot: config.vaultRoot,
  });
  if (v['dry-run']) {
    console.log(JSON.stringify({ source: session.source, turns: session.turns.length, omitted: session.omitted,
      command: spec.command, args: spec.args, prompt_characters: spec.input.length }));
    return 0;
  }
  console.error(`Restarting archive ${session.source.archive_id} on ${spec.command} (${v.provider}/${v.model}); ${session.turns.length} turns.`);
  return await new Promise<number>((resolve, reject) => {
    const child = spawn(spec.command, spec.args, { cwd: config.vaultRoot, stdio: ['pipe', 'inherit', 'inherit'] });
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
    child.stdin.end(spec.input);
  });
}

try { process.exitCode = await main(); }
catch (err) { console.error((err as Error).message); process.exitCode = 1; }
finally { await pool.end(); }
