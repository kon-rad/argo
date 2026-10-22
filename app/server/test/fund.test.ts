import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { buildOverview, meetingOutcome, readRuns, type FundDeps } from '../src/fund.js';
import { BASE_USDC } from '../src/metrics/collect.js';
import { resetSettings } from '../src/settings.js';

// Fake addresses and hashes only (RFC-style placeholders), as the engine's public-repo rule requires.
const A = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const SAFE = A(1), AGENT = A(2), DECK = A(3), PHONE = A(4), WETH = A(5);
const H1 = `0x${'a'.repeat(64)}`, H2 = `0x${'b'.repeat(64)}`, H3 = `0x${'c'.repeat(64)}`;

let vault = '';

function write(rel: string, text: string) {
  const full = join(vault, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, text);
}

function seed(config: Record<string, unknown> | null) {
  vault = mkdtempSync(join(tmpdir(), 'sb-fund-'));
  writeFileSync(join(vault, 'secondbrain.json'), JSON.stringify({ fund: { dir: 'areas/fund' } }));
  process.env.SECONDBRAIN_SETTINGS = join(vault, 'secondbrain.json');
  resetSettings();
  if (config) write('areas/fund/state/config.json', JSON.stringify(config));
}

const hex = (n: bigint) => `0x${n.toString(16)}`;
// Balances by address: ETH wei, USDC micro-units, WETH wei.
function fakeDeps(over: Partial<FundDeps> = {}, balances: Record<string, [bigint, bigint, bigint]> = {}): FundDeps {
  return {
    now: () => Date.parse('2026-10-22T12:00:00Z'),
    rpc: async (method, params) => {
      if (method === 'eth_getBalance') return hex(balances[(params[0] as string).toLowerCase()]?.[0] ?? 0n);
      const call = params[0] as { to: string; data: string };
      if (call.data === '0x313ce567') return hex(call.to.toLowerCase() === BASE_USDC.toLowerCase() ? 6n : 18n);
      const holder = `0x${call.data.slice(-40)}`;
      const row = balances[holder] ?? [0n, 0n, 0n];
      return hex(call.to.toLowerCase() === BASE_USDC.toLowerCase() ? row[1] : row[2]);
    },
    rpcAny: async (_m, params) => (params[0] === H1 ? { status: '0x1', gasUsed: '0x5208', effectiveGasPrice: hex(1_000_000_000n) } : null),
    get: async (url) => {
      if (url.includes('coinbase')) return { status: 200, body: JSON.stringify({ data: { amount: '2000' } }) };
      if (url.includes('/transfers/')) {
        return {
          status: 200,
          body: JSON.stringify({
            results: [
              { type: 'ERC20_TRANSFER', executionDate: '2026-10-20T00:00:00Z', transactionHash: H2, to: SAFE, from: PHONE, value: '100000000', tokenInfo: { symbol: 'USDC', decimals: 6 } },
              { type: 'ERC20_TRANSFER', executionDate: '2026-10-21T00:00:00Z', transactionHash: H1, to: A(9), from: SAFE, value: '30000000', tokenInfo: { symbol: 'USDC', decimals: 6 } },
            ],
          }),
        };
      }
      return { status: 404, body: '' };
    },
    ...over,
  };
}

const CONFIG = { chain_id: 8453, safe: SAFE, threshold: 2, owners: { agent: AGENT, deck: DECK, phone: PHONE }, savings: PHONE, tokens: { WETH } };

describe('fund overview', () => {
  beforeEach(() => seed(CONFIG));

  it('is unconfigured without a state/config.json', async () => {
    seed(null);
    const o = await buildOverview(vault, fakeDeps());
    expect(o.configured).toBe(false);
    expect(o.wallets).toEqual([]);
  });

  it('reads each wallet from the chain and values the Safe', async () => {
    const o = await buildOverview(vault, fakeDeps({}, {
      [SAFE]: [10n ** 18n / 100n, 70_000_000n, 5n * 10n ** 15n], // 0.01 ETH, 70 USDC, 0.005 WETH
      [AGENT]: [10n ** 15n, 0n, 0n],
    }));
    expect(o.configured).toBe(true);
    expect(o.chainId).toBe(8453);
    expect(o.threshold).toBe(2);
    const safe = o.wallets.find((w) => w.key === 'safe')!;
    // 0.01 ETH * 2000 + 70 USDC + 0.005 WETH * 2000 = 20 + 70 + 10
    expect(safe.usd).toBe(100);
    expect(o.navUsd).toBe(100);
    expect(safe.balances.map((b) => b.symbol)).toEqual(['ETH', 'USDC', 'WETH']);
    expect(o.wallets.find((w) => w.key === 'agent')!.usd).toBe(2);
    // the savings address equals the phone: both rows exist, one chain read each
    expect(o.wallets.find((w) => w.key === 'savings')!.address).toBe(PHONE);
  });

  it('never invents a number: a failed read is an error, not zero', async () => {
    const o = await buildOverview(vault, fakeDeps({ rpc: async () => { throw new Error('rpc: boom'); } }));
    const safe = o.wallets.find((w) => w.key === 'safe')!;
    expect(safe.usd).toBeNull();
    expect(safe.error).toMatch(/boom/);
    expect(o.chainErrors.join(' ')).toMatch(/Fund Safe/);
  });

  it('says so when the Safe does not exist', async () => {
    seed({ ...CONFIG, safe: '' });
    const o = await buildOverview(vault, fakeDeps());
    const safe = o.wallets.find((w) => w.key === 'safe')!;
    expect(safe.address).toBeNull();
    expect(safe.error).toBe('not created yet');
    expect(o.warnings.join(' ')).toMatch(/not been created/);
  });

  it('warns when the agent is low on gas', async () => {
    const o = await buildOverview(vault, fakeDeps({}, { [AGENT]: [10n ** 13n, 0n, 0n] }));
    expect(o.warnings.join(' ')).toMatch(/low on ETH/);
  });

  it('lists proposals, checks executed hashes on the chain and folds in Safe transfers', async () => {
    write('areas/fund/state/proposals/2026-10-21-1.json', JSON.stringify({
      id: '2026-10-21-1', created: '2026-10-21T00:10:00Z', kind: 'swap', meeting: '2026-10-21', status: 'executed', tx_hash: H1,
      intent: { sell: 'USDC', buy: 'WETH', amount: '30' }, tally: '3–0',
      votes: [{ partner: 'A', vote: 'yes', reason: 'ok' }, { partner: 'B', vote: 'yes', reason: 'ok' }, { partner: 'C', vote: 'yes', reason: 'ok' }],
    }));
    write('areas/fund/state/proposals/2026-10-22-1.json', JSON.stringify({
      id: '2026-10-22-1', created: '2026-10-22T00:10:00Z', kind: 'withdraw', status: 'proposed', tx_hash: null,
      intent: { kind: 'withdraw', token: 'USDC', amount: 'all' }, votes: [], tally: 'requested by owner',
    }));
    write('areas/fund/state/proposals/2026-10-20-1.json', JSON.stringify({
      id: '2026-10-20-1', created: '2026-10-20T00:10:00Z', kind: 'swap', status: 'refused', tx_hash: 'not-a-hash',
      intent: { sell: 'USDC', buy: 'AERO', amount: '5' }, votes: [],
    }));
    const o = await buildOverview(vault, fakeDeps({}, { [SAFE]: [0n, 70_000_000n, 0n] }));
    expect(o.pending.map((p) => p.id)).toEqual(['2026-10-22-1']);
    expect(o.pending[0]!.title).toBe('Move all USDC to savings');
    const swap = o.transactions.find((t) => t.proposal === '2026-10-21-1')!;
    expect(swap).toMatchObject({ kind: 'swap', title: 'Sell 30 USDC for WETH', hash: H1, confirmed: true });
    expect(swap.gasEth).toBeCloseTo(0.000021, 6);
    // the transfer that belongs to the swap is not listed twice; the deposit is
    expect(o.transactions.filter((t) => t.hash === H1)).toHaveLength(1);
    expect(o.transactions.find((t) => t.hash === H2)).toMatchObject({ kind: 'transfer-in', title: 'Received 100 USDC' });
    expect(o.transactions.find((t) => t.proposal === '2026-10-20-1')).toMatchObject({ kind: 'refused', hash: null });
    // newest first
    const times = o.transactions.map((t) => Date.parse(t.when));
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it('keeps going when the Safe service is down', async () => {
    const base = fakeDeps();
    const o = await buildOverview(vault, fakeDeps({ get: async (url) => (url.includes('/transfers/') ? { status: 503, body: '' } : base.get(url)) }));
    expect(o.configured).toBe(true);
    expect(o.chainErrors.join(' ')).toMatch(/HTTP 503/);
  });

  it('reads meetings, reviews, the harness ledger and the last run per job', async () => {
    write('areas/fund/meetings/2026-10-21.md', '# Meeting 2026-10-21\n\n## 6. Outcome\n\n**Hold: no motion tabled.** Nothing waits.\n');
    write('areas/fund/reviews/2026-W43.md', '# Weekly review\n');
    write('areas/fund/state/harness/ledger.tsv', 'date\truns_ok\n2026-10-19\t3/3\n2026-10-22\t2/3\n');
    write('areas/fund/state/runs/fund-committee-20261020-0000.jsonl', '{"type":"result","is_error":false}\n');
    write('areas/fund/state/runs/fund-committee-20261021-0000.jsonl', '{"type":"result","is_error":true,"result":"Claude usage limit reached"}\n');
    write('areas/fund/state/runs/fund-research-20261021-2300.jsonl', '{"type":"result","is_error":false}\n');
    const o = await buildOverview(vault, fakeDeps());
    expect(o.meetings[0]).toMatchObject({ name: '2026-10-21.md', note: 'Hold: no motion tabled. Nothing waits.' });
    expect(o.reviews).toHaveLength(1);
    expect(o.harness.header).toEqual(['date', 'runs_ok']);
    expect(o.harness.rows[0]).toEqual(['2026-10-22', '2/3']);
    const runs = Object.fromEntries(readRuns(vault, 'areas/fund').map((r) => [r.skill, r]));
    expect(runs['fund-committee']).toMatchObject({ failed: true, reason: 'usage limit' });
    expect(runs['fund-research']!.failed).toBe(false);
    expect(o.warnings.join(' ')).toMatch(/fund-committee: last run failed \(usage limit\)/);
  });

  it('a settings dir that climbs out of the vault is ignored', async () => {
    writeFileSync(join(vault, 'secondbrain.json'), JSON.stringify({ fund: { dir: '../elsewhere' } }));
    resetSettings();
    const o = await buildOverview(vault, fakeDeps());
    expect(o.dir).toBe('fund');
  });
});

describe('meetingOutcome', () => {
  it('returns the first line under the Outcome heading, markdown stripped', () => {
    expect(meetingOutcome('## 5. Votes\nx\n## 6. Outcome\n\n**Hold** and `more`\n')).toBe('Hold and more');
    expect(meetingOutcome('# no outcome here')).toBe('');
  });
});

describe('GET /api/fund', () => {
  beforeEach(() => seed(CONFIG));

  it('is read-only and serves the overview with a short cache', async () => {
    let calls = 0;
    const deps = fakeDeps({ rpc: async (m, p) => { calls++; return fakeDeps().rpc(m, p); } });
    const app = createApp({ vaultRoot: vault, modules: new Set(['fund']), fund: deps });
    const first = await request(app).get('/api/fund');
    expect(first.status).toBe(200);
    expect(first.body.configured).toBe(true);
    const n = calls;
    await request(app).get('/api/fund');
    expect(calls).toBe(n);
    await request(app).get('/api/fund?refresh=1');
    expect(calls).toBeGreaterThan(n);
    expect((await request(app).post('/api/fund')).status).toBe(404);
  });

  it('is not mounted when the module is off', async () => {
    const res = await request(createApp({ vaultRoot: vault, modules: new Set() })).get('/api/fund');
    expect(res.status).toBe(404);
  });
});
