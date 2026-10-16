import { pool } from './db.js';
import { collect, latestCredits, PROVIDERS, readKeys, saveReading, type Provider } from './credits.js';

// `secondbrain credits sync|set|show`: prepaid API balances into provider_credit_snapshots.
//   sync                       OpenRouter + fal from their APIs (the droplet's credits-sync timer runs this)
//   set <provider> <balance>   a reading typed in by hand; Gemini has no balance API
//        [--currency USD] [--note "..."]
//   show                       the latest reading per provider
// Keys: the environment first, then only OPENROUTER_API_KEY / FAL_BILLING_KEY from $CREDITS_KEYS_FILE.
const [cmd = 'show', ...rest] = process.argv.slice(2);

function flag(name: string): string | undefined {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
}

const money = (v: number | null, cur: string): string => (v === null ? '-' : `${v.toFixed(2)} ${cur}`);

let code = 0;
try {
  if (cmd === 'sync') {
    const readings = await collect(readKeys(process.env, process.env.CREDITS_KEYS_FILE));
    for (const r of readings) {
      const stored = await saveReading(r);
      console.log(`credits ${r.provider}: ${r.status === 'ok' ? money(r.balance, r.currency) : `${r.status} (${r.error})`}` +
        `${stored ? '' : ' (unchanged, not stored)'}`);
      if (r.status === 'error') code = 2;
    }
  } else if (cmd === 'set') {
    const [provider, amount] = rest;
    const balance = Number(amount);
    if (!PROVIDERS.includes(provider as Provider) || amount === undefined || !Number.isFinite(balance) || balance < 0) {
      throw new Error(`usage: credits set <${PROVIDERS.join('|')}> <balance> [--currency USD] [--note "..."]`);
    }
    await saveReading({
      provider: provider as Provider, origin: 'manual', status: 'ok', balance, totalCredits: null, totalUsage: null,
      currency: (flag('currency') ?? 'USD').toUpperCase(), error: null, note: flag('note') ?? null,
    });
    console.log(`credits ${provider}: ${money(balance, (flag('currency') ?? 'USD').toUpperCase())} recorded by hand`);
  } else if (cmd === 'show') {
    for (const c of await latestCredits()) {
      const r = c.last_ok;
      const tail = c.latest && c.latest.status !== 'ok' ? `  [latest: ${c.latest.status}: ${c.latest.error}]` : '';
      console.log(`${c.provider.padEnd(10)} ${r ? `${money(r.balance, r.currency)}  as of ${r.observed_at.toISOString()} (${r.origin})` : 'no reading'}${tail}`);
    }
  } else {
    throw new Error(`unknown credits command: ${cmd} (sync, set, show)`);
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  code = 1;
} finally {
  await pool.end();
}
process.exit(code);
