import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { buildPush } from '../src/usage/push.js';
import { runUpload } from '../src/usage/upload.js';

it('larger-than64MiB complete Codex prefixes progress with stable IDs/totals, bounded upload and metadata replay', async () => {
  const { parseCodex } = await import('../src/usage/codex.js');
  const { splitJsonLines } = await import('../src/usage/lines.js');
  const { utimesSync, rmSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'large-prefix-'));
  try {
    const path = join(dir, 'large.jsonl');
    const at = '2020-01-01T00:00:00Z';
    const meta = { type: 'session_meta', timestamp: at, payload: { id: 'large-source', model: 'fixture', source: 'exec' } };
    const usage = { type: 'event_msg', timestamp: at, payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 80, output_tokens: 20 } } } };
    const filler = { type: 'response_item', timestamp: at, payload: { type: 'function_call_output', call_id: 'tool-one', output: 'x'.repeat(65 * 1024 * 1024) } };
    writeFileSync(path, [meta, filler, usage].map(x => JSON.stringify(x)).join('\n') + '\n');
    const input = { claudeProjectsDir: join(dir, 'absent'), codexSessionsDir: dir, planLog: null, maxBytes: 100 };
    const first = buildPush(input, { files: {} });
    expect(first.bytes).toBeGreaterThan(64 * 1024 * 1024);
    expect(first.next.files[path]!.offset).toBe(first.bytes);
    const parsed = parseCodex(splitJsonLines(Buffer.from(JSON.parse(first.lines[0]!).text)).records, 'test-box');
    expect(parsed.session).toMatchObject({ externalId: 'large-source', inputTokens: 80, outputTokens: 20 });
    expect(parsed.calls).toHaveLength(1);
    const uploaded = await runUpload(process.execPath, ['-e', `
      let bytes=0,max=0;process.stdin.on('data',b=>{bytes+=b.length;max=Math.max(max,b.length)});
      process.stdin.on('end',()=>process.stdout.write(JSON.stringify({v:2,lines:1,accepted:[1],rejected:[],bytes,max})));
    `], first.lines, 5000);
    expect(uploaded.ok).toBe(true);
    expect(JSON.parse(uploaded.stdout).bytes).toBe(Buffer.byteLength(first.lines[0]!) + 1);
    expect(JSON.parse(uploaded.stdout).max).toBeLessThanOrEqual(256 * 1024);
    utimesSync(path, new Date(), new Date());
    const replay = buildPush(input, first.next);
    expect(replay.lines).toEqual([]);
    expect(replay.next.files[path]!.fingerprint).toBe(first.next.files[path]!.fingerprint);
    const retry = buildPush(input, { files: {} });
    const again = parseCodex(splitJsonLines(Buffer.from(JSON.parse(retry.lines[0]!).text)).records, 'test-box');
    expect(again.calls.map(c => [c.callId, c.inputTokens, c.outputTokens])).toEqual(parsed.calls.map(c => [c.callId, c.inputTokens, c.outputTokens]));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 30_000);
