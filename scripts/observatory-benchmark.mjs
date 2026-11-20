#!/usr/bin/env node
// Synthetic CPU replay benchmark. No database, network, browser or model calls.
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { replay } from '../app/shared/dist/observatory.js';
const count = 5000;
const events = Array.from({ length: count }, (_, i) => ({
  version: 1, id: `fixture:${i}`, at: i + 1, observedAt: null, sequence: i, part: 0,
  kind: i % 2 ? 'tool_result' : 'tool_call', session: 'archive:1', execution: 'run:fixture:1',
  source: { table: 'archive_messages', id: String(i), part: '0' }, precision: 'millisecond', confidence: 'recorded',
  actor: { kind: 'agent', sender: null, channel: null, evidence: 'synthetic-only' },
  ...(i % 2 ? { parent: `fixture:${i - 1}`, outcome: 'success' } : { occurrence: `fixture:${i}` }),
}));
const window = { version: 1, from: 0, to: count + 2, boundary: { tickets: {}, tools: {} }, intervals: [], events };
const digest = state => createHash('sha256').update(JSON.stringify(state)).digest('hex');
const cursors = Array.from({ length: 101 }, (_, i) => i * 50);
const forward = new Map(cursors.map(t => [t, digest(replay(window, t))]));
const samples = [];
for (const t of [...cursors].reverse()) {
  const start = performance.now(), state = replay(window, t);
  samples.push(performance.now() - start);
  if (forward.get(t) !== digest(state)) throw new Error(`reverse replay differs at ${t}`);
}
samples.sort((a, b) => a - b);
console.log(JSON.stringify({ scenario: 'synthetic CPU replay only', events: count, samples: samples.length,
  bytes: Buffer.byteLength(JSON.stringify(window)), p95SeekMs: +samples[Math.floor(samples.length * .95)].toFixed(3),
  deterministicSeeks: forward.size, node: process.version, platform: process.platform, arch: process.arch,
  browserMemory: 'not measured', fps: 'not measured', production: 'not audited' }, null, 2));
