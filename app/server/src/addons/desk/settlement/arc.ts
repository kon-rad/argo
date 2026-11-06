import type { DeskSettlement, PaymentEvidence, PaymentIntent, Result, VerifiedPayment } from '@secondbrain/desk-contracts/desk';
import { digest } from '@secondbrain/desk-contracts/desk';

/** Arc Testnet's native USDC is transferred as an EVM value (18 decimal places).
 * Verification reads only the EIP-7708 system Transfer stream, never the
 * parallel six-decimal ERC-20 mirror event, so a movement is counted once.
 */
export const ARC_TESTNET_CHAIN_ID = '5042002';
export const ARC_TESTNET_RPC_URL = 'https://rpc.testnet.arc.io';
export const ARC_NATIVE_USDC_INTERFACE = 'arc:testnet:native-usdc:eip-7708:v1';
export const ARC_SYSTEM_EMITTER = '0xfffffffffffffffffffffffffffffffffffffffe';
export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const UINT = /^(0|[1-9][0-9]*)$/;

export function parseDecimalToAtomic(value: string, decimals = 18): string {
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 255 || !/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(value)) throw new Error('Invalid decimal amount');
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > decimals) throw new Error('Amount exceeds asset precision');
  return (BigInt(whole!) * 10n ** BigInt(decimals) + BigInt((fraction + '0'.repeat(decimals)).slice(0, decimals) || '0')).toString();
}

export function formatAtomicToDecimal(value: string, decimals = 18): string {
  if (!UINT.test(value) || !Number.isSafeInteger(decimals) || decimals < 0 || decimals > 255) throw new Error('Invalid atomic amount');
  const n = BigInt(value), scale = 10n ** BigInt(decimals);
  if (!decimals) return n.toString();
  const whole = (n / scale).toString();
  const fraction = (n % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

export interface ArcTransferLog { address: string; topics: readonly string[]; data: string; logIndex: number | string; }
export interface ArcTransaction { from: string; to: string | null; value: string; input?: string; data?: string; }
export interface ArcReceipt { status: 'success' | 'reverted' | 'pending' | 'unknown'; transactionHash: string; logs: readonly ArcTransferLog[]; }
export interface ArcReadClient {
  chainId(): Promise<string>;
  transaction(hash: string): Promise<ArcTransaction | null>;
  receipt(hash: string): Promise<ArcReceipt | null>;
}
export type ReserveReceipt = (receiptId: string, assignmentKey: string) => Promise<boolean>;

function addressTopic(topic: string): string | undefined {
  if (!/^0x[0-9a-fA-F]{64}$/.test(topic) || !/^0{24}[0-9a-fA-F]{40}$/.test(topic.slice(2))) return undefined;
  return `0x${topic.slice(-40)}`.toLowerCase();
}
function validIntent(intent: PaymentIntent): boolean {
  return intent.chainId === ARC_TESTNET_CHAIN_ID && intent.asset.toUpperCase() === 'USDC' && intent.transferInterface === ARC_NATIVE_USDC_INTERFACE && ADDRESS.test(intent.payer) && ADDRESS.test(intent.recipient) && intent.amountAtomic.length > 0 && UINT.test(intent.amountAtomic) && BigInt(intent.amountAtomic) > 0n;
}
function invalid(message: string): Result<never> { return { kind: 'invalid-input', message }; }

export class ArcNativeUsdcSettlement implements DeskSettlement {
  readonly mode = 'live' as const;
  constructor(private readonly reader?: ArcReadClient, private readonly reserve?: ReserveReceipt) {}

  async prepare(intent: PaymentIntent): Promise<Result<{ chainId: string; transaction: unknown }>> {
    if (!validIntent(intent)) return invalid('Payment terms do not match the supported Arc Testnet native USDC transfer interface.');
    // A native transfer has no calldata and goes directly to the accepted recipient.
    return { kind: 'ok', value: { chainId: ARC_TESTNET_CHAIN_ID, transaction: { chainId: Number(ARC_TESTNET_CHAIN_ID), from: intent.payer, to: intent.recipient, value: `0x${BigInt(intent.amountAtomic).toString(16)}`, data: '0x' } } };
  }

  verify(intent: PaymentIntent, txHash: string): Promise<Result<VerifiedPayment>> { return this.verifyReceipt(intent, txHash); }
  reconcile(intent: PaymentIntent, txHash: string): Promise<Result<VerifiedPayment>> { return this.verifyReceipt(intent, txHash); }

  private async verifyReceipt(intent: PaymentIntent, txHash: string): Promise<Result<VerifiedPayment>> {
    if (!validIntent(intent) || !HASH.test(txHash)) return invalid('Invalid Arc payment intent or transaction hash.');
    if (!this.reader || !this.reserve) return { kind: 'unavailable', message: 'Arc verification requires an injected RPC reader and durable receipt reservation.' };
    try {
      if (await this.reader.chainId() !== ARC_TESTNET_CHAIN_ID) return { kind: 'failed', message: 'RPC is connected to the wrong chain.' };
      const [tx, receipt] = await Promise.all([this.reader.transaction(txHash), this.reader.receipt(txHash)]);
      if (!tx || !receipt) return { kind: 'pending', message: 'Transaction or receipt is not available yet; reconcile before retrying payment.' };
      if (receipt.status === 'pending' || receipt.status === 'unknown') return { kind: 'pending', message: 'Transaction status is not final; reconcile before retrying payment.' };
      if (receipt.transactionHash.toLowerCase() !== txHash.toLowerCase() || receipt.status !== 'success') return { kind: 'failed', message: 'Receipt hash mismatch or transaction failed.' };
      if (tx.to?.toLowerCase() !== intent.recipient.toLowerCase() || tx.from.toLowerCase() !== intent.payer.toLowerCase() || BigInt(tx.value) !== BigInt(intent.amountAtomic) || (tx.input ?? tx.data ?? '0x') !== '0x') return { kind: 'failed', message: 'Transaction is not the exact direct transfer authorized by the accepted terms.' };

      // Only the system emitter's 18-decimal event is authoritative here. The
      // ERC-20 USDC contract also emits a 6-decimal mirror for ERC-20 calls.
      const relevant = receipt.logs.filter(log => log.address.toLowerCase() === ARC_SYSTEM_EMITTER && log.topics[0]?.toLowerCase() === TRANSFER_TOPIC);
      if (relevant.length !== 1) return { kind: 'failed', message: 'Expected exactly one Arc native USDC system Transfer event.' };
      const log = relevant[0]!;
      if (addressTopic(log.topics[1] ?? '') !== intent.payer.toLowerCase() || addressTopic(log.topics[2] ?? '') !== intent.recipient.toLowerCase() || !/^0x[0-9a-fA-F]{64}$/.test(log.data) || BigInt(log.data) !== BigInt(intent.amountAtomic)) return { kind: 'failed', message: 'Arc system Transfer does not match payer, recipient and atomic amount.' };
      if (!/^(0|[1-9][0-9]*)$/.test(String(log.logIndex))) return { kind: 'failed', message: 'Arc Transfer log index is invalid.' };
      const receiptId = `arc:${ARC_TESTNET_CHAIN_ID}:${txHash.toLowerCase()}:${log.logIndex}`;
      const assignmentKey = `${intent.jobRef}\u0000${intent.acceptanceRef}`;
      if (!await this.reserve(receiptId, assignmentKey)) return { kind: 'failed', message: 'Receipt has already been reserved or could not be reserved for this assignment.' };
      const evidence: PaymentEvidence = { version: 'desk/v1', domain: 'desk/v1', chainId: ARC_TESTNET_CHAIN_ID, type: 'payment', jobRef: intent.jobRef, acceptanceRef: intent.acceptanceRef, paymentChainId: ARC_TESTNET_CHAIN_ID, txHash: txHash.toLowerCase(), transferIndex: String(log.logIndex), payer: intent.payer.toLowerCase(), recipient: intent.recipient.toLowerCase(), asset: 'USDC', amountAtomic: intent.amountAtomic, transferInterface: ARC_NATIVE_USDC_INTERFACE };
      return { kind: 'ok', value: { evidenceRef: receiptId, evidenceDigest: await digest('payment-evidence', evidence), receiptId, verified: true } };
    } catch {
      return { kind: 'unavailable', message: 'Arc RPC or durable receipt reservation is unavailable.' };
    }
  }
}
