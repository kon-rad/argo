import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { BASE_USDC, curlGet, curlRpc, curlRpcAny, ethUsdPrice, type HttpGet, type RpcAny, type RpcCall } from './metrics/collect.js';
import { settings } from './settings.js';

/**
 * The fund module: a read-only view of an agentic fund that keeps its state as
 * files in the vault (see the fund's own docs for the layout). Wallet addresses
 * come from `<dir>/state/config.json`, never from this code. Balances are read
 * from the chain; transfers come from the Safe Transaction Service; the fund's
 * own trades, votes and runs come from its files. The page never signs,
 * proposes or approves anything.
 */

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const ETH_DECIMALS = 18;

export interface FundDeps {
  rpc: RpcCall;
  rpcAny: RpcAny;
  get: HttpGet;
  now: () => number;
}

export const defaultFundDeps: FundDeps = { rpc: curlRpc, rpcAny: curlRpcAny, get: curlGet, now: () => Date.now() };

export interface TokenBalance { symbol: string; amount: number; usd: number | null }
export interface Wallet {
  key: 'safe' | 'agent' | 'deck' | 'phone' | 'savings';
  label: string;
  role: string;
  address: string | null;
  balances: TokenBalance[];
  /** Sum of the priced balances; null when nothing could be read. */
  usd: number | null;
  /** True when a held token has no USD price here, so `usd` is a floor. */
  partial: boolean;
  error: string | null;
}
export interface Vote { partner: string; vote: string; reason: string }
export interface Proposal {
  id: string; created: string; kind: string; title: string; status: string; tally: string; meeting: string;
  votes: Vote[]; txHash: string | null; result: string | null;
}
export interface Transaction {
  when: string;
  kind: 'swap' | 'withdraw' | 'transfer-in' | 'transfer-out' | 'failed' | 'refused' | 'expired';
  title: string;
  hash: string | null;
  proposal: string | null;
  /** From the chain: true confirmed, false reverted, null not checked. */
  confirmed: boolean | null;
  gasEth: number | null;
}
export interface FileItem { name: string; path: string; title: string; note: string }
export interface RunItem { skill: string; at: string; failed: boolean; reason: string | null; file: string }
export interface FundOverview {
  configured: boolean;
  dir: string;
  chainId: number | null;
  explorer: string;
  threshold: number | null;
  ethUsd: number | null;
  navUsd: number | null;
  navPartial: boolean;
  wallets: Wallet[];
  pending: Proposal[];
  proposals: Proposal[];
  transactions: Transaction[];
  meetings: FileItem[];
  research: FileItem[];
  reviews: FileItem[];
  harness: { header: string[]; rows: string[][] };
  runs: RunItem[];
  warnings: string[];
  chainErrors: string[];
  asOf: string;
}

function vaultDir(dir: string): string {
  const clean = dir.replace(/^\/+|\/+$/g, '');
  return clean && !clean.split('/').includes('..') ? clean : 'fund';
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

function listFiles(dir: string, ext: string): string[] {
  try {
    return readdirSync(dir).filter((f) => f.endsWith(ext) && !f.startsWith('.')).sort().reverse();
  } catch {
    return [];
  }
}

function tail(path: string, bytes: number): string {
  let fd: number | null = null;
  try {
    const size = statSync(path).size;
    fd = openSync(path, 'r');
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd != null) closeSync(fd);
  }
}

const firstHeading = (text: string, fallback: string): string => /^#\s+(.+)$/m.exec(text)?.[1]?.trim() ?? fallback;

/** The first non-empty line after "## <n>. Outcome" in a meeting's minutes, markdown stripped. */
export function meetingOutcome(text: string): string {
  const lines = text.split('\n');
  const i = lines.findIndex((l) => /^##\s+(?:\d+\.\s*)?Outcome/i.test(l));
  if (i < 0) return '';
  const line = lines.slice(i + 1).find((l) => l.trim());
  return (line ?? '').replace(/\*\*|`/g, '').trim().slice(0, 280);
}

function fileItems(root: string, dir: string, sub: string, note: (text: string) => string, limit: number): FileItem[] {
  const base = join(root, dir, sub);
  return listFiles(base, '.md').slice(0, limit).map((name) => {
    const text = readFileSync(join(base, name), 'utf8');
    return { name, path: `${dir}/${sub}/${name}`, title: firstHeading(text, name.replace(/\.md$/, '')), note: note(text) };
  });
}

function proposalTitle(p: Record<string, unknown>): string {
  const i = (p.intent ?? {}) as Record<string, string>;
  if (p.kind === 'withdraw') return `Move ${i.amount ?? '?'} ${i.token ?? '?'} to savings`;
  return `Sell ${i.amount ?? '?'} ${i.sell ?? '?'} for ${i.buy ?? '?'}`;
}

export function readProposals(root: string, dir: string): Proposal[] {
  const base = join(root, dir, 'state', 'proposals');
  return listFiles(base, '.json').map((f) => {
    const p = readJson<Record<string, unknown>>(join(base, f)) ?? {};
    const votes = Array.isArray(p.votes) ? (p.votes as Record<string, unknown>[]) : [];
    const tx = typeof p.tx_hash === 'string' && HASH.test(p.tx_hash) ? p.tx_hash : null;
    return {
      id: String(p.id ?? f.replace(/\.json$/, '')),
      created: String(p.created ?? ''),
      kind: String(p.kind ?? 'swap'),
      title: proposalTitle(p),
      status: String(p.status ?? 'unknown'),
      tally: String(p.tally ?? ''),
      meeting: String(p.meeting ?? ''),
      votes: votes.map((v) => ({ partner: String(v.partner ?? ''), vote: String(v.vote ?? ''), reason: String(v.reason ?? '') })),
      txHash: tx,
      result: typeof p.result === 'string' ? p.result.slice(0, 280) : p.result ? JSON.stringify(p.result).slice(0, 280) : null,
    };
  });
}

/** Skill name and time from `state/runs/<skill>-<YYYYMMDD>-<HHMM>.jsonl`; whether the run died on an error. */
export function readRuns(root: string, dir: string): RunItem[] {
  const base = join(root, dir, 'state', 'runs');
  const latest = new Map<string, RunItem>();
  for (const f of listFiles(base, '.jsonl')) {
    const m = /^(.+)-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})\.jsonl$/.exec(f);
    if (!m || latest.has(m[1]!)) continue;
    const t = tail(join(base, f), 6000);
    const limit = /usage[ _]limit|weekly limit|rate limit|limit reached|"api_error_status"\s*:\s*429/i.test(t);
    const failed = limit || /"is_error"\s*:\s*true/.test(t);
    latest.set(m[1]!, {
      skill: m[1]!, at: `${m[2]}-${m[3]}-${m[4]}T${m[5]}:${m[6]}:00Z`, failed,
      reason: limit ? 'usage limit' : failed ? 'run reported an error' : null, file: `${dir}/state/runs/${f}`,
    });
  }
  return [...latest.values()].sort((a, b) => a.skill.localeCompare(b.skill));
}

export function readLedger(root: string, dir: string): { header: string[]; rows: string[][] } {
  try {
    const lines = readFileSync(join(root, dir, 'state', 'harness', 'ledger.tsv'), 'utf8').split('\n').filter(Boolean);
    const [head, ...rows] = lines;
    return { header: (head ?? '').split('\t'), rows: rows.slice(-10).reverse().map((r) => r.split('\t')) };
  } catch {
    return { header: [], rows: [] };
  }
}

interface FundConfig {
  chain_id?: number;
  safe?: string;
  threshold?: number;
  owners?: { agent?: string; deck?: string; phone?: string };
  savings?: string;
  tokens?: Record<string, string>;
}

const addr = (v: unknown): string | null => (typeof v === 'string' && ADDR.test(v) ? v : null);

export function walletsFromConfig(cfg: FundConfig): Omit<Wallet, 'balances' | 'usd' | 'partial' | 'error'>[] {
  return [
    { key: 'safe', label: 'Fund Safe', role: 'Holds the fund. Any two owners must sign to move it.', address: addr(cfg.safe) },
    { key: 'agent', label: 'Agent', role: 'Owner on the server. Proposes, signs as one owner, pays gas.', address: addr(cfg.owners?.agent) },
    { key: 'deck', label: 'Deck', role: 'Owner on the hardware approve key. Signs what you approve.', address: addr(cfg.owners?.deck) },
    { key: 'phone', label: 'Phone', role: 'Owner on your phone. Backup approval and recovery.', address: addr(cfg.owners?.phone) },
    { key: 'savings', label: 'Savings', role: 'Receives profit withdrawals; no other destination is allowed.', address: addr(cfg.savings) },
  ];
}

const pad = (a: string) => a.slice(2).toLowerCase().padStart(64, '0');

async function tokenBalance(rpc: RpcCall, token: string, holder: string): Promise<{ raw: bigint; decimals: number }> {
  const raw = BigInt(await rpc('eth_call', [{ to: token, data: `0x70a08231${pad(holder)}` }, 'latest']));
  const decimals = Number(BigInt(await rpc('eth_call', [{ to: token, data: '0x313ce567' }, 'latest'])));
  return { raw, decimals };
}

async function readWallet(
  base: Omit<Wallet, 'balances' | 'usd' | 'partial' | 'error'>,
  tokens: Record<string, string>,
  ethUsd: number | null,
  rpc: RpcCall,
): Promise<Wallet> {
  if (!base.address) return { ...base, balances: [], usd: null, partial: false, error: base.key === 'safe' ? 'not created yet' : 'address not set' };
  try {
    const eth = Number(BigInt(await rpc('eth_getBalance', [base.address, 'latest']))) / 10 ** ETH_DECIMALS;
    const balances: TokenBalance[] = [{ symbol: 'ETH', amount: eth, usd: ethUsd == null ? null : eth * ethUsd }];
    const usdc = await tokenBalance(rpc, BASE_USDC, base.address);
    balances.push({ symbol: 'USDC', amount: Number(usdc.raw) / 10 ** usdc.decimals, usd: Number(usdc.raw) / 10 ** usdc.decimals });
    for (const [symbol, token] of Object.entries(tokens)) {
      if (!ADDR.test(token) || token.toLowerCase() === BASE_USDC.toLowerCase()) continue;
      const t = await tokenBalance(rpc, token, base.address);
      balances.push({ symbol, amount: Number(t.raw) / 10 ** t.decimals, usd: symbol.toUpperCase() === 'WETH' && ethUsd != null ? (Number(t.raw) / 10 ** t.decimals) * ethUsd : null });
    }
    const shown = balances.filter((b) => b.amount > 0 || b.symbol === 'ETH' || b.symbol === 'USDC');
    const priced = shown.filter((b) => b.usd != null);
    const usd = priced.reduce((s, b) => s + (b.usd as number), 0);
    return { ...base, balances: shown, usd: Math.round(usd * 100) / 100, partial: shown.some((b) => b.usd == null && b.amount > 0), error: null };
  } catch (err) {
    return { ...base, balances: [], usd: null, partial: false, error: (err as Error).message.split('\n')[0]!.slice(0, 120) };
  }
}

interface SafeTransfer {
  type?: string; executionDate?: string; transactionHash?: string; to?: string; from?: string; value?: string;
  tokenInfo?: { symbol?: string; decimals?: number } | null;
}

async function safeTransfers(safe: string, service: string, get: HttpGet): Promise<SafeTransfer[]> {
  const r = await get(`${service.replace(/\/+$/, '')}/api/v1/safes/${safe}/transfers/?limit=50`);
  if (r.status !== 200) throw new Error(`safe tx service: HTTP ${r.status}`);
  const j = JSON.parse(r.body) as { results?: SafeTransfer[] };
  return j.results ?? [];
}

const fmt = (n: number): string => String(Number(n.toPrecision(6)));

function transferTx(t: SafeTransfer, safe: string): Transaction | null {
  if (!t.executionDate || !t.transactionHash) return null;
  const decimals = t.type === 'ETHER_TRANSFER' ? ETH_DECIMALS : (t.tokenInfo?.decimals ?? null);
  const symbol = t.type === 'ETHER_TRANSFER' ? 'ETH' : (t.tokenInfo?.symbol ?? 'token');
  if (decimals == null || t.value == null) return null;
  const amount = Number(t.value) / 10 ** decimals;
  const incoming = (t.to ?? '').toLowerCase() === safe.toLowerCase();
  return {
    when: t.executionDate, kind: incoming ? 'transfer-in' : 'transfer-out',
    title: `${incoming ? 'Received' : 'Sent'} ${fmt(amount)} ${symbol}`, hash: t.transactionHash, proposal: null, confirmed: true, gasEth: null,
  };
}

async function receipt(rpcAny: RpcAny, hash: string): Promise<{ confirmed: boolean | null; gasEth: number | null }> {
  try {
    const r = (await rpcAny('eth_getTransactionReceipt', [hash])) as { status?: string; gasUsed?: string; effectiveGasPrice?: string } | null;
    if (!r) return { confirmed: null, gasEth: null };
    const gas = r.gasUsed && r.effectiveGasPrice ? Number(BigInt(r.gasUsed) * BigInt(r.effectiveGasPrice)) / 1e18 : null;
    return { confirmed: r.status === '0x1', gasEth: gas };
  } catch {
    return { confirmed: null, gasEth: null };
  }
}

export async function buildOverview(vaultRoot: string, deps: FundDeps = defaultFundDeps): Promise<FundOverview> {
  const cfgS = settings(vaultRoot).fund;
  const dir = vaultDir(cfgS.dir);
  const cfg = readJson<FundConfig>(join(vaultRoot, dir, 'state', 'config.json'));
  const asOf = new Date(deps.now()).toISOString();
  const chainErrors: string[] = [];
  const warnings: string[] = [];

  const proposals = readProposals(vaultRoot, dir);
  const meetings = fileItems(vaultRoot, dir, 'meetings', meetingOutcome, 8);
  const research = fileItems(vaultRoot, dir, 'research', () => '', 6);
  const reviews = fileItems(vaultRoot, dir, 'reviews', () => '', 4);
  const runs = readRuns(vaultRoot, dir);
  const harness = readLedger(vaultRoot, dir);

  const empty: FundOverview = {
    configured: false, dir, chainId: null, explorer: cfgS.explorer, threshold: null, ethUsd: null, navUsd: null, navPartial: false,
    wallets: [], pending: [], proposals, transactions: [], meetings, research, reviews, harness, runs, warnings, chainErrors, asOf,
  };
  if (!cfg) return empty;

  let ethUsd: number | null = null;
  try {
    ethUsd = await ethUsdPrice(deps.get);
  } catch (err) {
    chainErrors.push((err as Error).message.split('\n')[0]!.slice(0, 120));
  }

  const cache = new Map<string, Promise<Wallet>>();
  const wallets = await Promise.all(
    walletsFromConfig(cfg).map(async (w) => {
      const key = w.address?.toLowerCase() ?? w.key;
      const cached = cache.get(key) ?? readWallet(w, cfg.tokens ?? {}, ethUsd, deps.rpc);
      cache.set(key, cached);
      return { ...(await cached), key: w.key, label: w.label, role: w.role };
    }),
  );
  for (const w of wallets) if (w.error && w.address) chainErrors.push(`${w.label}: ${w.error}`);

  const safe = wallets.find((w) => w.key === 'safe')!;
  if (!safe.address) warnings.push('The Safe has not been created yet, so the fund holds nothing.');
  else if (safe.usd === 0) warnings.push('The Safe is created but holds no ETH or USDC.');
  const agent = wallets.find((w) => w.key === 'agent');
  const agentEth = agent?.balances.find((b) => b.symbol === 'ETH')?.amount;
  if (agent?.address && agentEth != null && agentEth < 0.0003) warnings.push('The agent wallet is low on ETH for gas.');
  for (const r of runs) {
    if (r.failed) warnings.push(`${r.skill}: last run (${r.at.slice(0, 10)}) failed (${r.reason}).`);
    else if (r.skill === 'fund-committee' && deps.now() - Date.parse(r.at) > 36 * 3600_000) warnings.push('The committee has not run in over 36 hours.');
  }

  // Transactions: the fund's own record, each executed hash checked on the chain, plus the Safe's transfers.
  const txs: Transaction[] = [];
  const own = new Set<string>();
  const done = proposals.filter((p) => p.txHash && ['executed', 'failed'].includes(p.status)).slice(0, 20);
  const receipts = await Promise.all(done.map((p) => receipt(deps.rpcAny, p.txHash!)));
  done.forEach((p, i) => {
    own.add(p.txHash!.toLowerCase());
    txs.push({
      when: p.created, kind: p.status === 'failed' ? 'failed' : p.kind === 'withdraw' ? 'withdraw' : 'swap',
      title: p.title, hash: p.txHash, proposal: p.id, confirmed: receipts[i]!.confirmed, gasEth: receipts[i]!.gasEth,
    });
  });
  for (const p of proposals.filter((x) => ['refused', 'expired'].includes(x.status))) {
    txs.push({ when: p.created, kind: p.status as 'refused' | 'expired', title: p.title, hash: null, proposal: p.id, confirmed: null, gasEth: null });
  }
  if (safe.address) {
    try {
      for (const t of await safeTransfers(safe.address, cfgS.txService, deps.get)) {
        const tx = transferTx(t, safe.address);
        if (tx && !own.has(tx.hash!.toLowerCase())) txs.push(tx);
      }
    } catch (err) {
      chainErrors.push((err as Error).message.split('\n')[0]!.slice(0, 120));
    }
  }
  txs.sort((a, b) => Date.parse(b.when) - Date.parse(a.when));

  return {
    ...empty,
    configured: true,
    chainId: typeof cfg.chain_id === 'number' ? cfg.chain_id : null,
    threshold: typeof cfg.threshold === 'number' ? cfg.threshold : null,
    ethUsd,
    navUsd: safe.usd,
    navPartial: safe.partial,
    wallets,
    pending: proposals.filter((p) => ['proposed', 'prepared'].includes(p.status)),
    transactions: txs.slice(0, 60),
  };
}
