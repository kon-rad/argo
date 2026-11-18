import { describe, it, expect, vi } from 'vitest';
import { ProviderBrowserWallet, type Eip1193 } from '../src/wallet.js';
import { validateWalletIntent, walletTransaction, type ProviderWalletIntent } from '@secondbrain/desk-contracts/desk';
const owner = `0x${'1'.repeat(40)}`, other = `0x${'2'.repeat(40)}`, hash = `0x${'a'.repeat(64)}`;
const make = (): ProviderWalletIntent => ({ version: 'desk-wallet/v1', intentRef: 'intent-1', action: 'claim', jobRef: 'job-1', requiredCreator: owner, chainId: '0x1', expiresAt: Math.floor(Date.now()/1000)+900, acceptanceDigest: `sha256:${'a'.repeat(64)}`, executionId: 'run-1', transaction: walletTransaction({ to: other, data: '0x12345678', value: '900719925474099312345' }, owner, '1') });
function setup(account = owner, chain = '0x1') {
  const listeners = new Map<string, () => void>();
  const request = vi.fn(async ({ method }: { method: string }) => {
    if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [account];
    if (method === 'eth_chainId') return chain;
    if (method === 'eth_sendTransaction') return hash;
    return null;
  });
  const provider: Eip1193 = { request, on: (event, fn) => { listeners.set(event, fn); }, removeListener: (event) => { listeners.delete(event); } };
  return { wallet: new ProviderBrowserWallet(provider), request, listeners };
}
describe('provider browser signing boundary', () => {
  it('requests account access only from explicit connect', async () => {
    const { wallet, request } = setup(); expect(request).not.toHaveBeenCalled();
    expect(await wallet.connect()).toBe(owner);
    expect(request).toHaveBeenCalledWith({ method: 'eth_requestAccounts' });
  });
  it('preserves exact integer quantities and returns only a pending transaction hash', async () => {
    const { wallet, request } = setup(); const intent = make();
    expect(await wallet.signAndSubmit(intent)).toBe(hash);
    expect(request).toHaveBeenCalledWith({ method: 'eth_sendTransaction', params: [intent.transaction] });
    expect(BigInt(intent.transaction.value)).toBe(900719925474099312345n);
  });
  it.each([[other, '0x1'], [owner, '0x2']])('cannot submit with wrong wallet or network', async (account, chain) => {
    const { wallet, request } = setup(account, chain);
    await expect(wallet.signAndSubmit(make())).rejects.toThrow();
    expect(request.mock.calls.some(([v]) => v.method === 'eth_sendTransaction')).toBe(false);
  });
  it('rejects expired and malformed delivery bindings before contacting a wallet', async () => {
    const { wallet, request } = setup();
    await expect(wallet.signAndSubmit({ ...make(), expiresAt: 1 })).rejects.toThrow('Stale');
    expect(() => validateWalletIntent({ ...make(), action: 'delivery' })).toThrow('Missing approved');
    expect(request).not.toHaveBeenCalled();
  });
  it('invalidates an in-flight review when account or chain changes', async () => {
    for (const event of ['accountsChanged', 'chainChanged']) {
      const { wallet, request, listeners } = setup();
      request.mockImplementationOnce(async () => { listeners.get(event)!(); return [owner]; });
      await expect(wallet.signAndSubmit(make())).rejects.toThrow('Wallet changed');
      expect(request.mock.calls.some(([v]) => v.method === 'eth_sendTransaction')).toBe(false);
    }
  });
  it('propagates rejection and outage without inventing confirmation', async () => {
    const { wallet, request } = setup();
    request.mockRejectedValueOnce(new Error('User rejected request'));
    await expect(wallet.signAndSubmit(make())).rejects.toThrow('User rejected');
    request.mockRejectedValueOnce(new Error('RPC unavailable'));
    await expect(wallet.signAndSubmit(make())).rejects.toThrow('RPC unavailable');
  });
  it('retains a broadcast hash even if wallet changes while signature is pending', async () => {
    const { wallet, request, listeners } = setup();
    request.mockImplementation(async ({ method }) => {
      if (method === 'eth_accounts') return [owner]; if (method === 'eth_chainId') return '0x1';
      listeners.get('accountsChanged')!(); return hash;
    });
    expect(await wallet.signAndSubmit(make())).toBe(hash);
  });
  it('rejects a wallet response which is not a transaction hash', async () => {
    const { wallet, request } = setup(); request.mockImplementation(async ({ method }) => method === 'eth_accounts' ? [owner] : method === 'eth_chainId' ? '0x1' : 'confirmed');
    await expect(wallet.signAndSubmit(make())).rejects.toThrow('invalid transaction hash');
  });
  it('unsubscribes wallet events on disposal', () => {
    const { wallet, listeners } = setup(); wallet.dispose(); expect(listeners.size).toBe(0);
  });
  it('rejects mismatched from/chain and malformed integer/data values', () => {
    for (const patch of [{ from: other }, { chainId: '2' }, { value: '0.1' }, { data: '0x123' }, { to: 'bad' }]) expect(() => walletTransaction({ to: other, data: '0x12345678', ...patch }, owner, '1')).toThrow();
  });
});
it('blocks duplicate signing while in flight and after a successful broadcast', async () => {
  const { wallet, request } = setup(); const intent = make();
  let resume!: (value: string[]) => void;
  request.mockImplementationOnce(() => new Promise(resolve => { resume = resolve; }));
  const first = wallet.signAndSubmit(intent);
  await expect(wallet.signAndSubmit(intent)).rejects.toThrow('already pending');
  resume([owner]); expect(await first).toBe(hash);
  await expect(wallet.signAndSubmit(intent)).rejects.toThrow('already pending');
  expect(request.mock.calls.filter(([v]) => v.method === 'eth_sendTransaction')).toHaveLength(1);
});
