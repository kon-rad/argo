import { useEffect, useRef, useState } from 'react';
import { chainHex } from '@secondbrain/desk-contracts/desk';
import type { OperatorJob, ProviderWalletApi, ProviderWalletIntent, Result } from '@secondbrain/desk-contracts/desk';
import { ProviderBrowserWallet, type Eip1193 } from './wallet.js';
const button = 'rounded border border-[var(--rule)] px-3 py-1.5 text-sm disabled:opacity-50';
export function ProviderSigning({ job, api, changed }: { job: OperatorJob; api: ProviderWalletApi; changed(job: OperatorJob): void }) {
  const [intent, setIntent] = useState<ProviderWalletIntent | null>(null);
  const [message, setMessage] = useState('Provider wallet disconnected');
  const [account, setAccount] = useState('');
  const [chain, setChain] = useState('');
  const [pendingRef, setPendingRef] = useState('');
  const [busy, setBusy] = useState(false);
  const [txHash, setTxHash] = useState('');
  const wallet = useRef<ProviderBrowserWallet | null>(null);
  const action = job.execution === 'approved' || job.execution === 'queued' ? 'claim' : 'delivery';
  const intentRef = useRef<ProviderWalletIntent | null>(null); intentRef.current = intent;
  useEffect(() => {
    const provider = (window as Window & { ethereum?: Eip1193 }).ethereum;
    if (!provider) { setMessage('Injected provider wallet unavailable'); return; }
    const adapter = new ProviderBrowserWallet(provider, () => { setIntent(null); setAccount(''); setChain(''); setMessage('Wallet changed. Reconnect and reload the signing review.'); });
    wallet.current = adapter;
    return () => { adapter.dispose(); wallet.current = null; };
  }, []);
  const storageKey = `desk-wallet-pending:${job.id}:${action}`;
  useEffect(() => {
    setIntent(null); setTxHash(''); setPendingRef('');
    try {
      const hint = JSON.parse(sessionStorage.getItem(storageKey) ?? 'null') as { intentRef?: string; txHash?: string } | null;
      if (hint?.intentRef && /^0x[0-9a-fA-F]{64}$/.test(hint.txHash ?? '')) { setPendingRef(hint.intentRef); setTxHash(hint.txHash!); setMessage('Recovered pending transaction hint. Reconcile with the server; browser storage is not confirmation.'); }
    } catch { /* Storage unavailable or invalid: server resume remains available. */ }
  }, [job.id, action, storageKey]);
  useEffect(() => { setIntent(null); }, [job.revision]);
  const run = async (operation: () => Promise<void>) => {
    setBusy(true);
    try { await operation(); } catch (e) { setMessage(e instanceof Error ? e.message : 'Wallet request failed'); } finally { setBusy(false); }
  };
  const unwrap = <T,>(result: Result<T>): T => { if (result.kind !== 'ok') throw new Error(`${result.kind}: ${result.message}`); return result.value; };
  const load = async () => {
    const result = unwrap(await api.walletIntent(job.id, action)); setIntent(result); setMessage('Review all values before signing.');
  };
  const prepare = async () => {
    if (action !== 'claim') return load();
    const result = unwrap(await api.prepareClaim(job.id, { expectedRevision: job.revision, idempotencyKey: `wallet-claim:${job.id}:${job.approval?.idempotencyKey}` }));
    setIntent(result); setMessage('Signing publishes the provider claim and permits worker start after independent confirmation.');
  };
  const sign = async () => {
    if (!intent || !wallet.current) throw new Error('Connect and review the provider wallet first');
    const reviewed = intent;
    // Re-fetch authoritative binding immediately before asking the wallet.
    const current = unwrap(await api.walletIntent(job.id, action));
    if (JSON.stringify(current) !== JSON.stringify(reviewed) || intentRef.current !== reviewed) { setIntent(null); throw new Error('Signing terms changed. Reload and review again.'); }
    const hash = await wallet.current.signAndSubmit(reviewed); setTxHash(hash); setPendingRef(reviewed.intentRef);
    try { sessionStorage.setItem(storageKey, JSON.stringify({ intentRef: reviewed.intentRef, txHash: hash })); } catch { /* Nonsecret hint only; hash remains visible for recovery. */ }
    // Keep the hash visible if the server is unavailable after the wallet broadcasts.
    setMessage('Submitted to wallet network. Server reconciliation is pending.');
    unwrap(await api.submitWallet(job.id, action, { intentRef: reviewed.intentRef, txHash: hash }));
  };
  return <section className="rounded border border-[var(--rule)] p-3 space-y-2" aria-label="Provider wallet signing">
    <h3 className="font-semibold">Provider wallet signing</h3>
    <p role="status" className="text-sm">{message}</p>
    {account && <p className="break-all text-xs">Connected account: {account} · chain: {chain || 'unavailable'}</p>}
    <div className="flex flex-wrap gap-2">
      <button className={button} disabled={busy} onClick={() => void run(async () => { if (!wallet.current) throw new Error('Injected wallet unavailable'); setAccount(await wallet.current.connect()); setChain(await wallet.current.chain()); setMessage('Provider wallet connected.'); })}>Connect provider wallet</button>
      <button className={button} disabled={busy} onClick={() => void run(prepare)}>{action === 'claim' ? 'Prepare provider claim' : 'Load approved delivery intent'}</button>
      <button className={button} disabled={busy} onClick={() => void run(load)}>Reload signing review</button>
      <button className={button} disabled={busy} onClick={() => void run(async () => { const result = unwrap(await api.reconcileWallet(job.id, action)); changed(result); sessionStorage.removeItem(storageKey); setTxHash(''); setPendingRef(''); setMessage('Independent reconciliation completed.'); })}>Reconcile {action}</button>
    </div>
    {intent && <div className="space-y-1 break-all text-xs">
      <p>Action: publish provider {intent.action}</p><p>Signer: {intent.requiredCreator}</p><p>Chain ID: {intent.chainId}</p><p>Contract destination: {intent.transaction.to}</p>
      <p>Native value (base units): {BigInt(intent.transaction.value).toString()}</p><p>Method selector: {intent.transaction.data.slice(0, 10)}</p>
      <details><summary>Exact calldata</summary><p>{intent.transaction.data}</p></details>
      <p>Job: {intent.jobRef}</p><p>Execution: {intent.executionId}</p><p>Acceptance digest: {intent.acceptanceDigest}</p><p>Expires: {new Date(intent.expiresAt * 1000).toISOString()}</p>
      {intent.action === 'delivery' && <><p>Artifact hash: {intent.artifactHash}</p><p>Media type: {intent.mediaType}</p><p>Approved public destination: {intent.publicDestination}</p></>}
      <button className={button} disabled={busy || !account} onClick={() => void run(async () => { if (!wallet.current) throw new Error('Wallet unavailable'); await wallet.current.ensureChain(intent.chainId); setIntent(null); setMessage('Network switch requested. Reload and review the intent before signing.'); })}>Switch to reviewed network</button>
      <button className={button} disabled={busy || !!txHash || !account || account.toLowerCase() !== intent.requiredCreator.toLowerCase() || chain !== chainHex(intent.chainId)} onClick={() => void run(sign)}>Sign and submit {intent.action}</button>
    </div>}
    {txHash && <p className="break-all text-xs">Pending transaction hash: {txHash}</p>}
    {txHash && pendingRef && <button className={button} disabled={busy} onClick={() => void run(async () => { unwrap(await api.submitWallet(job.id, action, { intentRef: pendingRef, txHash })); setMessage('Submission recorded; reconcile to check finality.'); })}>Retry recording submitted hash</button>}
  </section>;
}
