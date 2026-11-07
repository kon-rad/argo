import { chainHex, validateWalletIntent, walletAddress, walletHash, type ProviderWalletIntent } from '@secondbrain/desk-contracts/desk';
export interface Eip1193 {
  request(input: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: 'accountsChanged' | 'chainChanged', listener: () => void): void;
  removeListener?(event: 'accountsChanged' | 'chainChanged', listener: () => void): void;
}
export class ProviderBrowserWallet {
  private epoch = 0;
  private inFlight = false;
  private submitted = new Set<string>();
  private changed = () => { this.epoch++; this.onChange(); };
  constructor(private readonly provider: Eip1193, private readonly onChange = () => {}) {
    provider.on?.('accountsChanged', this.changed); provider.on?.('chainChanged', this.changed);
  }
  dispose() { this.provider.removeListener?.('accountsChanged', this.changed); this.provider.removeListener?.('chainChanged', this.changed); }
  async connect(): Promise<string> {
    const accounts = await this.provider.request({ method: 'eth_requestAccounts' });
    if (!Array.isArray(accounts) || !walletAddress(accounts[0])) throw new Error('Provider wallet unavailable');
    return accounts[0];
  }
  async chain(): Promise<string> {
    const chain = await this.provider.request({ method: 'eth_chainId' });
    if (typeof chain !== 'string') throw new Error('Wallet network unavailable'); return chainHex(chain);
  }
  async ensureChain(chainId: string) {
    await this.provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: chainHex(chainId) }] });
  }
  async signAndSubmit(intent: ProviderWalletIntent): Promise<string> {
    if (this.inFlight || this.submitted.has(intent.intentRef)) throw new Error('Signing already pending; reconcile before retrying');
    this.inFlight = true;
    try { const hash = await this.submitReviewed(intent); this.submitted.add(intent.intentRef); return hash; }
    finally { this.inFlight = false; }
  }
  private async submitReviewed(intent: ProviderWalletIntent): Promise<string> {
    intent = structuredClone(intent);
    validateWalletIntent(intent);
    const epoch = this.epoch;
    const accounts = await this.provider.request({ method: 'eth_accounts' });
    const chain = await this.provider.request({ method: 'eth_chainId' });
    if (epoch !== this.epoch) throw new Error('Wallet changed; review a fresh intent');
    if (!Array.isArray(accounts) || typeof accounts[0] !== 'string' || accounts[0].toLowerCase() !== intent.requiredCreator.toLowerCase()) throw new Error('Connect the expected provider account');
    if (typeof chain !== 'string' || chainHex(chain) !== chainHex(intent.chainId)) throw new Error('Switch to the reviewed network');
    validateWalletIntent(intent);
    // The transaction is a local immutable snapshot. No await occurs between final validation and submission.
    const tx = structuredClone(intent.transaction);
    const result = await this.provider.request({ method: 'eth_sendTransaction', params: [tx] });
    // A wallet change after broadcast cannot undo the transaction: return its hash for server recovery.
    if (!walletHash(result)) throw new Error('Wallet returned an invalid transaction hash');
    return result;
  }
}
