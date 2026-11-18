import type { Mutation, OperatorJob, ReleaseRequest, Result } from './types.js';
export interface WalletTransaction { from: string; to: string; chainId: string; data: string; value: string }
export interface ProviderWalletIntent {
  version: 'desk-wallet/v1'; intentRef: string; action: 'claim' | 'delivery'; jobRef: string;
  requiredCreator: string; chainId: string; expiresAt: number; acceptanceDigest: string;
  executionId: string; transaction: WalletTransaction;
  artifactHash?: string; mediaType?: string; publicDestination?: string;
}
export interface WalletSubmission { intentRef: string; txHash: string }
export interface ProviderWalletApi {
  prepareClaim(id: string, request: Mutation): Promise<Result<ProviderWalletIntent>>;
  prepareDelivery(id: string, request: ReleaseRequest): Promise<Result<ProviderWalletIntent>>;
  walletIntent(id: string, action: 'claim' | 'delivery'): Promise<Result<ProviderWalletIntent>>;
  submitWallet(id: string, action: 'claim' | 'delivery', request: WalletSubmission): Promise<Result<{ status: 'pending'; txHash: string }>>;
  reconcileWallet(id: string, action: 'claim' | 'delivery'): Promise<Result<OperatorJob>>;
}
export const walletAddress = (v: unknown): v is string => typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v);
export const walletHash = (v: unknown): v is string => typeof v === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v);
export function chainHex(value: string): string {
  if (!/^(0x[0-9a-fA-F]+|[1-9][0-9]*)$/.test(value)) throw new Error('Unsupported EVM chain ID');
  const n = BigInt(value); if (n <= 0n) throw new Error('Invalid chain ID'); return `0x${n.toString(16)}`;
}
/** Strict allowlist: server-only metadata and wallet-controlled gas fields never enter calldata. */
export function walletTransaction(value: unknown, creator: string, chain: string): WalletTransaction {
  if (!value || typeof value !== 'object') throw new Error('Unsigned EVM transaction unavailable');
  const tx = value as Record<string, unknown>;
  if (!walletAddress(creator) || !walletAddress(tx.to) || typeof tx.data !== 'string' || !/^0x(?:[0-9a-fA-F]{2})+$/.test(tx.data)) throw new Error('Invalid unsigned transaction');
  const chainId = chainHex(chain);
  if (tx.from !== undefined && (typeof tx.from !== 'string' || tx.from.toLowerCase() !== creator.toLowerCase())) throw new Error('Transaction creator mismatch');
  if (tx.chainId !== undefined && (typeof tx.chainId !== 'string' || chainHex(tx.chainId) !== chainId)) throw new Error('Transaction chain mismatch');
  const amount = tx.value ?? '0x0';
  if (typeof amount !== 'string' || !/^(0x[0-9a-fA-F]+|0|[1-9][0-9]*)$/.test(amount)) throw new Error('Invalid integer value');
  return { from: creator, to: tx.to, chainId, data: tx.data, value: `0x${BigInt(amount).toString(16)}` };
}
export function validateWalletIntent(intent: ProviderWalletIntent, now = Math.floor(Date.now() / 1000)): void {
  if (!intent || intent.version !== 'desk-wallet/v1' || !['claim', 'delivery'].includes(intent.action) || !intent.intentRef || !intent.jobRef || !intent.executionId || !/^sha256:[0-9a-f]{64}$/.test(intent.acceptanceDigest) || !Number.isSafeInteger(intent.expiresAt) || intent.expiresAt <= now) throw new Error('Stale or invalid signing intent');
  const tx = walletTransaction(intent.transaction, intent.requiredCreator, intent.chainId);
  if (Object.keys(intent.transaction).length !== 5 || (Object.keys(tx) as (keyof WalletTransaction)[]).some(key => tx[key] !== intent.transaction[key])) throw new Error('Noncanonical signing transaction');
  if (intent.action === 'delivery' && (!/^sha256:[0-9a-f]{64}$/.test(intent.artifactHash ?? '') || !intent.mediaType || !intent.publicDestination)) throw new Error('Missing approved delivery binding');
}
