import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, type FundOverview, type FundProposal, type FundTransaction, type FundWallet } from '../lib/api.js';
import { ago } from '../lib/time.js';

/**
 * The fund: balances of its wallets, its transaction history and the state of
 * its committee, read-only. Balances come from the chain, trades and votes from
 * the fund's own files in the vault. Nothing here signs or approves anything.
 */

const chip = 'inline-block rounded border px-1.5 py-0.5 text-xs';
const usd = (n: number | null): string => (n == null ? '—' : n.toLocaleString(undefined, { style: 'currency', currency: 'USD' }));
const amount = (n: number): string => (n === 0 ? '0' : n >= 1 ? n.toLocaleString(undefined, { maximumFractionDigits: 2 }) : String(Number(n.toPrecision(3))));
const short = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;

const KIND_LABEL: Record<FundTransaction['kind'], string> = {
  swap: 'Swap', withdraw: 'Withdrawal', 'transfer-in': 'Received', 'transfer-out': 'Sent', failed: 'Failed', refused: 'Refused', expired: 'Expired',
};

function Address({ address, explorer }: { address: string; explorer: string }) {
  return (
    <a className="font-mono text-xs text-[var(--ink-dim)] underline decoration-dotted" href={`${explorer}/address/${address}`} target="_blank" rel="noreferrer" title={address}>
      {short(address)}
    </a>
  );
}

function WalletCard({ w, explorer }: { w: FundWallet; explorer: string }) {
  return (
    <div className="rounded border border-[var(--rule)] p-3" data-testid={`wallet-${w.key}`}>
      <div className="flex items-baseline gap-2">
        <h3 className="text-sm font-semibold">{w.label}</h3>
        {w.address && <Address address={w.address} explorer={explorer} />}
        <span className="ml-auto text-sm tabular-nums">{usd(w.usd)}</span>
      </div>
      <p className="mt-1 text-xs text-[var(--ink-dim)]">{w.role}</p>
      {w.error ? (
        <p className="mt-2 text-xs text-[var(--ink-faint)]">{w.error}</p>
      ) : (
        <ul className="mt-2 space-y-0.5 text-sm">
          {w.balances.map((b) => (
            <li key={b.symbol} className="flex justify-between tabular-nums">
              <span>{b.symbol}</span>
              <span>
                {amount(b.amount)}
                {b.usd == null && b.amount > 0 && <span className="ml-1 text-xs text-[var(--ink-faint)]">unpriced</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Pending({ items }: { items: FundProposal[] }) {
  const [open, setOpen] = useState<string | null>(null);
  if (items.length === 0) return <p className="text-sm text-[var(--ink-dim)]">Nothing is waiting for approval.</p>;
  return (
    <ul className="space-y-2">
      {items.map((p) => (
        <li key={p.id} className="rounded border border-[var(--rule)] p-3">
          <button type="button" className="flex w-full items-baseline gap-2 text-left" onClick={() => setOpen(open === p.id ? null : p.id)}>
            <span className="text-sm font-medium">{p.title}</span>
            <span className={`${chip} border-[var(--accent)]`}>{p.status}</span>
            <span className="text-xs text-[var(--ink-dim)]">{p.tally}</span>
            <span className="ml-auto text-xs text-[var(--ink-faint)]">{ago(p.created)}</span>
          </button>
          {open === p.id && (
            <ul className="mt-2 space-y-1 text-sm">
              {p.votes.length === 0 && <li className="text-[var(--ink-dim)]">No committee vote on this one.</li>}
              {p.votes.map((v) => (
                <li key={v.partner}>
                  <b>{v.partner}</b> <span className={`${chip} border-[var(--rule)]`}>{v.vote}</span> <span className="text-[var(--ink-dim)]">{v.reason}</span>
                </li>
              ))}
              <li className="pt-1 text-xs text-[var(--ink-faint)]">Approve on the fund's device or wallet. This page cannot.</li>
            </ul>
          )}
        </li>
      ))}
    </ul>
  );
}

function Transactions({ txs, explorer }: { txs: FundTransaction[]; explorer: string }) {
  if (txs.length === 0) return <p className="text-sm text-[var(--ink-dim)]">No transactions yet.</p>;
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-[var(--rule)] text-left text-xs text-[var(--ink-dim)]">
          <th className="py-1 pr-3 font-normal">When</th>
          <th className="py-1 pr-3 font-normal">Type</th>
          <th className="py-1 pr-3 font-normal">What</th>
          <th className="py-1 pr-3 font-normal">On chain</th>
          <th className="py-1 font-normal">Tx</th>
        </tr>
      </thead>
      <tbody>
        {txs.map((t) => (
          <tr key={`${t.hash ?? t.proposal}-${t.kind}-${t.when}`} className="border-b border-[var(--rule)] align-top">
            <td className="py-1 pr-3 whitespace-nowrap text-[var(--ink-dim)]">{new Date(t.when).toLocaleDateString([], { month: 'short', day: 'numeric' })}</td>
            <td className="py-1 pr-3 whitespace-nowrap">{KIND_LABEL[t.kind]}</td>
            <td className="py-1 pr-3">{t.title}{t.gasEth != null && <span className="ml-2 text-xs text-[var(--ink-faint)]">gas {Number(t.gasEth.toPrecision(2))} ETH</span>}</td>
            <td className="py-1 pr-3 whitespace-nowrap">{t.confirmed == null ? '—' : t.confirmed ? 'confirmed' : 'reverted'}</td>
            <td className="py-1 font-mono text-xs">
              {t.hash ? <a href={`${explorer}/tx/${t.hash}`} target="_blank" rel="noreferrer" className="underline decoration-dotted">{short(t.hash)}</a> : '—'}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-8">
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-[var(--ink-dim)]">{title}</h2>
      {children}
    </section>
  );
}

function Body({ d }: { d: FundOverview }) {
  if (!d.configured) {
    return (
      <p className="mt-6 text-sm text-[var(--ink-dim)]">
        No fund is set up here. Put the fund's state in <code>{d.dir}/state/config.json</code> (or set <code>fund.dir</code> in <code>secondbrain.json</code>).
      </p>
    );
  }
  return (
    <>
      {d.warnings.length > 0 && (
        <ul className="mt-4 space-y-1 rounded border border-[var(--accent)] p-3 text-sm" role="alert">
          {d.warnings.map((w) => <li key={w}>{w}</li>)}
        </ul>
      )}
      <Section title="Wallets">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {d.wallets.map((w) => <WalletCard key={w.key} w={w} explorer={d.explorer} />)}
        </div>
        {d.chainErrors.length > 0 && <p className="mt-2 text-xs text-[var(--ink-faint)]">Chain reads that failed: {d.chainErrors.join('; ')}</p>}
      </Section>
      <Section title="Waiting for approval"><Pending items={d.pending} /></Section>
      <Section title="Transactions"><Transactions txs={d.transactions} explorer={d.explorer} /></Section>
      <Section title="Committee">
        {d.meetings.length === 0 ? <p className="text-sm text-[var(--ink-dim)]">No meetings yet.</p> : (
          <ul className="space-y-1.5 text-sm">
            {d.meetings.map((m) => (
              <li key={m.path}>
                <Link to={`/file/${m.path}`} className="underline decoration-dotted">{m.name.replace(/\.md$/, '')}</Link>
                <span className="ml-2 text-[var(--ink-dim)]">{m.note}</span>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-sm">
          {d.research.map((r) => <Link key={r.path} to={`/file/${r.path}`} className="text-[var(--ink-dim)] underline decoration-dotted">{r.title}</Link>)}
          {d.reviews.map((r) => <Link key={r.path} to={`/file/${r.path}`} className="text-[var(--ink-dim)] underline decoration-dotted">{r.title}</Link>)}
        </div>
      </Section>
      <Section title="Health">
        {d.runs.length === 0 ? <p className="text-sm text-[var(--ink-dim)]">No scheduled runs recorded.</p> : (
          <table className="text-sm">
            <tbody>
              {d.runs.map((r) => (
                <tr key={r.skill}>
                  <td className="py-0.5 pr-4">{r.skill}</td>
                  <td className="py-0.5 pr-4 text-[var(--ink-dim)]">{ago(r.at)}</td>
                  <td className="py-0.5">{r.failed ? `failed: ${r.reason}` : 'ok'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {d.harness.rows.length > 0 && (
          <table className="mt-4 text-xs">
            <thead><tr>{d.harness.header.map((h) => <th key={h} className="pr-4 text-left font-normal text-[var(--ink-dim)]">{h}</th>)}</tr></thead>
            <tbody>{d.harness.rows.map((row, i) => <tr key={i}>{row.map((c, j) => <td key={j} className="pr-4">{c}</td>)}</tr>)}</tbody>
          </table>
        )}
      </Section>
    </>
  );
}

export default function Fund() {
  const q = useQuery({ queryKey: ['fund'], queryFn: () => api.fund(), refetchInterval: 60_000 });
  const d = q.data;
  return (
    <div className="mx-auto max-w-5xl overflow-y-auto px-6 py-6" style={{ height: '100%' }}>
      <div className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-lg font-semibold tracking-tight">Fund</h1>
        {d?.configured && (
          <span className="text-sm text-[var(--ink-dim)]">
            Base{d.threshold != null && ` · ${d.threshold} signatures needed`}
            {d.ethUsd != null && ` · ETH ${usd(d.ethUsd)}`}
          </span>
        )}
        <Link to="/org" className="text-sm text-[var(--ink-dim)] underline decoration-dotted">The team</Link>
        <button
          type="button"
          onClick={() => void q.refetch()}
          className="ml-auto rounded border border-[var(--rule)] px-3 py-1 text-sm hover:bg-[var(--paper-sunk)]"
        >
          {q.isFetching ? 'Reading…' : 'Refresh'}
        </button>
      </div>
      {d?.configured && (
        <p className="mt-3">
          <span className="text-3xl font-semibold tabular-nums" data-testid="nav">{usd(d.navUsd)}</span>
          <span className="ml-2 text-sm text-[var(--ink-dim)]">in the Safe{d.navPartial && ' (some tokens unpriced)'} · read {ago(d.asOf)}</span>
        </p>
      )}
      {q.isError && <p className="mt-4 text-sm" role="alert">Could not load the fund: {(q.error as Error).message}</p>}
      {q.isLoading && <p className="mt-4 text-sm text-[var(--ink-dim)]">Reading the chain…</p>}
      {d && <Body d={d} />}
    </div>
  );
}
