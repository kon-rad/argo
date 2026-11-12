import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { OperatorJob, ProviderWalletApi, ProviderWalletIntent } from '@secondbrain/desk-contracts/desk';
import { walletTransaction } from '@secondbrain/desk-contracts/desk';
import { ProviderSigning } from '../src/ProviderSigning.js';
import { createHttpDeskOperatorApi } from '../src/api.js';
const owner = `0x${'1'.repeat(40)}`, to = `0x${'2'.repeat(40)}`, hash = `0x${'b'.repeat(64)}`;
const job = { id: 'job-test', revision: 2, execution: 'queued' } as OperatorJob;
const intent: ProviderWalletIntent = { version: 'desk-wallet/v1', intentRef: 'intent-test', action: 'claim', jobRef: job.id, requiredCreator: owner, chainId: '0x1', expiresAt: Math.floor(Date.now()/1000)+900, acceptanceDigest: `sha256:${'a'.repeat(64)}`, executionId: 'run-test', transaction: walletTransaction({ to, data: '0x12345678' }, owner, '1') };
function setup(chain = '0x1') {
  Object.defineProperty(window, 'ethereum', { configurable: true, value: { on: vi.fn(), removeListener: vi.fn(), request: vi.fn(async ({ method }: { method: string }) => method === 'eth_requestAccounts' || method === 'eth_accounts' ? [owner] : method === 'eth_chainId' ? chain : hash) } });
  return { prepareClaim: vi.fn(async () => ({ kind: 'ok', value: intent })), walletIntent: vi.fn(async () => ({ kind: 'ok', value: intent })), submitWallet: vi.fn(async () => ({ kind: 'unavailable', message: 'Server offline' })), reconcileWallet: vi.fn(async () => ({ kind: 'pending', message: 'Not finalized' })) } as unknown as ProviderWalletApi;
}
beforeEach(() => sessionStorage.clear());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe('provider signing recovery UI', () => {
  it('disables signing on wrong chain and displays complete review values', async () => {
    const api = setup('0x2'); render(<ProviderSigning job={job} api={api} changed={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Connect provider wallet' }));
    await screen.findByText(/Connected account:/);
    fireEvent.click(screen.getByRole('button', { name: 'Reload signing review' }));
    await screen.findByText(`Contract destination: ${to}`);
    expect((screen.getByRole('button', { name: 'Sign and submit claim' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(`Execution: ${intent.executionId}`)).toBeTruthy();
  });
  it('recovers a broadcast hash across reload after the server failed, without claiming confirmation', async () => {
    const api = setup(); const first = render(<ProviderSigning job={job} api={api} changed={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Connect provider wallet' })); await screen.findByText(/Connected account:/);
    fireEvent.click(screen.getByRole('button', { name: 'Reload signing review' })); await screen.findByText(`Contract destination: ${to}`);
    fireEvent.click(screen.getByRole('button', { name: 'Sign and submit claim' }));
    await screen.findByText(`Pending transaction hash: ${hash}`); await screen.findByText('unavailable: Server offline');
    first.unmount();
    render(<ProviderSigning job={{ ...job, revision: 3 }} api={api} changed={vi.fn()} />);
    expect(await screen.findByText(`Pending transaction hash: ${hash}`)).toBeTruthy();
    expect(screen.getByText(/browser storage is not confirmation/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry recording submitted hash' }));
    await waitFor(() => expect(api.submitWallet).toHaveBeenLastCalledWith(job.id, 'claim', { intentRef: intent.intentRef, txHash: hash }));
  });
  it('preserves pending API semantics instead of interpreting HTTP 202 as a job', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { code: 'pending', message: 'Awaiting finality' } }), { status: 202 })));
    expect(await createHttpDeskOperatorApi().reconcileWallet(job.id, 'claim')).toEqual({ kind: 'pending', message: 'Awaiting finality' });
  });
});
