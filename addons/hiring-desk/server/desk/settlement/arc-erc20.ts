import { digest, type DeskSettlement, type PaymentEvidence, type PaymentIntent, type Result, type VerifiedPayment } from '@secondbrain/desk-contracts/desk';
import { ARC_SYSTEM_EMITTER, ARC_TESTNET_CHAIN_ID, TRANSFER_TOPIC, type ArcReadClient, type ArcTransferLog, type ReserveReceipt } from './arc.js';

export const ARC_ERC20_USDC_INTERFACE = 'arc:testnet:erc20-usdc:transfer:v1';
export const ARC_TESTNET_USDC_ADDRESS = '0x3600000000000000000000000000000000000000';
export const ARC_USDC_ERC20_DECIMALS = 6;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const UINT = /^(0|[1-9][0-9]*)$/;
const WORD = /^0x[0-9a-fA-F]{64}$/;
const UINT256_MAX = (1n << 256n) - 1n;
const NATIVE_SCALE = 10n ** 12n;
const TRANSFER_SELECTOR = '0xa9059cbb';

export interface ArcErc20UsdcOptions {
  /** Explicit server configuration, restricted to the documented Arc USDC predeploy. */
  usdcAddress: string;
  reader?: ArcReadClient;
  /** Atomically reserves for one assignment; a retry by that assignment must return true. */
  reserve?: ReserveReceipt;
}

function validIntent(intent: PaymentIntent): boolean {
  return !!intent && intent.chainId === ARC_TESTNET_CHAIN_ID && intent.asset === 'USDC'
    && intent.transferInterface === ARC_ERC20_USDC_INTERFACE
    && typeof intent.jobRef === 'string' && intent.jobRef.length > 0 && intent.jobRef.length <= 500 && !intent.jobRef.includes('\u0000')
    && typeof intent.acceptanceRef === 'string' && intent.acceptanceRef.length > 0 && intent.acceptanceRef.length <= 500 && !intent.acceptanceRef.includes('\u0000')
    && typeof intent.payer === 'string' && ADDRESS.test(intent.payer) && !/^0x0{40}$/i.test(intent.payer)
    && typeof intent.recipient === 'string' && ADDRESS.test(intent.recipient) && !/^0x0{40}$/i.test(intent.recipient)
    && typeof intent.amountAtomic === 'string' && intent.amountAtomic.length <= 78 && UINT.test(intent.amountAtomic)
    && BigInt(intent.amountAtomic) > 0n && BigInt(intent.amountAtomic) <= UINT256_MAX;
}

function calldata(intent: PaymentIntent): string {
  return `${TRANSFER_SELECTOR}${intent.recipient.slice(2).toLowerCase().padStart(64, '0')}${BigInt(intent.amountAtomic).toString(16).padStart(64, '0')}`;
}

function addressTopic(topic: string | undefined): string | undefined {
  return typeof topic === 'string' && /^0x0{24}[0-9a-fA-F]{40}$/.test(topic) ? `0x${topic.slice(-40).toLowerCase()}` : undefined;
}

function matchingLog(log: ArcTransferLog, intent: PaymentIntent, amount: bigint): boolean {
  return log.topics.length === 3 && addressTopic(log.topics[1]) === intent.payer.toLowerCase()
    && addressTopic(log.topics[2]) === intent.recipient.toLowerCase()
    && WORD.test(log.data) && BigInt(log.data) === amount;
}

function logIndex(value: number | string): string | undefined {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? String(value) : undefined;
  if (typeof value !== 'string' || value.length > 18 || !(/^(0|[1-9][0-9]*)$/.test(value) || /^0x[0-9a-fA-F]+$/.test(value))) return undefined;
  const parsed = BigInt(value);
  return parsed <= BigInt(Number.MAX_SAFE_INTEGER) ? parsed.toString() : undefined;
}

function failed(message: string): Result<never> { return { kind: 'failed', message }; }

/** Client-signed ERC-20 transfer only. This adapter has no signing/submission API. */
export class ArcErc20UsdcSettlement implements DeskSettlement {
  readonly mode = 'live' as const;
  private readonly token: string;

  constructor(private readonly options: ArcErc20UsdcOptions) {
    if (!options || typeof options.usdcAddress !== 'string' || options.usdcAddress.toLowerCase() !== ARC_TESTNET_USDC_ADDRESS) {
      throw new Error('ERC-20 Arc settlement requires the documented Arc Testnet USDC contract.');
    }
    this.token = options.usdcAddress.toLowerCase();
  }

  async prepare(intent: PaymentIntent): Promise<Result<{ chainId: string; transaction: unknown }>> {
    if (!validIntent(intent)) return { kind: 'invalid-input', message: 'Invalid Arc Testnet ERC-20 USDC payment terms.' };
    return { kind: 'ok', value: { chainId: ARC_TESTNET_CHAIN_ID, transaction: {
      chainId: Number(ARC_TESTNET_CHAIN_ID), from: intent.payer, to: this.token, value: '0x0', data: calldata(intent),
    } } };
  }

  verify(intent: PaymentIntent, txHash: string): Promise<Result<VerifiedPayment>> { return this.verifyReceipt(intent, txHash); }
  reconcile(intent: PaymentIntent, txHash: string): Promise<Result<VerifiedPayment>> { return this.verifyReceipt(intent, txHash); }

  private async verifyReceipt(intent: PaymentIntent, txHash: string): Promise<Result<VerifiedPayment>> {
    if (!validIntent(intent) || typeof txHash !== 'string' || !HASH.test(txHash)) return { kind: 'invalid-input', message: 'Invalid Arc ERC-20 payment intent or transaction hash.' };
    const { reader, reserve } = this.options;
    if (!reader || !reserve) return { kind: 'unavailable', message: 'ERC-20 verification requires an independent RPC reader and durable receipt reservation.' };
    try {
      if (await reader.chainId() !== ARC_TESTNET_CHAIN_ID) return failed('RPC is connected to the wrong chain.');
      const [tx, receipt] = await Promise.all([reader.transaction(txHash), reader.receipt(txHash)]);
      if (!tx || !receipt) return { kind: 'pending', message: 'Transaction or receipt is not available yet; reconcile before sending another payment.' };
      if (receipt.transactionHash.toLowerCase() !== txHash.toLowerCase()) return failed('Receipt transaction hash does not match.');
      if (receipt.status === 'pending' || receipt.status === 'unknown') return { kind: 'pending', message: 'Transaction receipt is not final; reconcile before sending another payment.' };
      if (receipt.status !== 'success') return failed('Transaction reverted or failed.');
      const expectedData = calldata(intent);
      if (tx.to?.toLowerCase() !== this.token || tx.from.toLowerCase() !== intent.payer.toLowerCase()
        || !/^(0|0x0+)$/i.test(tx.value)
        || (tx.input ?? tx.data)?.toLowerCase() !== expectedData
        || (tx.input !== undefined && tx.data !== undefined && tx.input.toLowerCase() !== tx.data.toLowerCase())) {
        return failed('Transaction is not the exact zero-value ERC-20 transfer authorized by the accepted terms.');
      }
      const transfers = receipt.logs.filter(log => log.address.toLowerCase() === this.token && log.topics[0]?.toLowerCase() === TRANSFER_TOPIC);
      if (transfers.length !== 1) return failed('Expected exactly one USDC token-contract Transfer event.');
      const selected = transfers[0]!;
      if (!matchingLog(selected, intent, BigInt(intent.amountAtomic))) return failed('USDC Transfer does not match the accepted payer, recipient and six-decimal amount.');
      const selectedIndex = logIndex(selected.logIndex);
      if (selectedIndex === undefined) return failed('USDC Transfer log index is invalid.');
      // An ERC-20 call may also emit the native EIP-7708 view. Verify its
      // 18-decimal units but allocate only the selected six-decimal token log.
      const mirrors = receipt.logs.filter(log => log.address.toLowerCase() === ARC_SYSTEM_EMITTER && log.topics[0]?.toLowerCase() === TRANSFER_TOPIC);
      if (mirrors.length > 1 || (mirrors.length === 1 && (!matchingLog(mirrors[0]!, intent, BigInt(intent.amountAtomic) * NATIVE_SCALE)
        || logIndex(mirrors[0]!.logIndex) === undefined || logIndex(mirrors[0]!.logIndex) === selectedIndex))) {
        return failed('Native USDC mirror does not match the selected ERC-20 payment.');
      }
      const receiptId = `arc:${ARC_TESTNET_CHAIN_ID}:${txHash.toLowerCase()}:${selectedIndex}`;
      const assignmentKey = `${intent.jobRef}\u0000${intent.acceptanceRef}`;
      if (!await reserve(receiptId, assignmentKey)) return failed('Receipt is already allocated to another assignment or could not be durably reserved.');
      const evidence: PaymentEvidence = {
        version: 'desk/v1', domain: 'desk/v1', chainId: ARC_TESTNET_CHAIN_ID, type: 'payment',
        jobRef: intent.jobRef, acceptanceRef: intent.acceptanceRef, paymentChainId: ARC_TESTNET_CHAIN_ID,
        txHash: txHash.toLowerCase(), transferIndex: selectedIndex, payer: intent.payer.toLowerCase(), recipient: intent.recipient.toLowerCase(),
        asset: 'USDC', amountAtomic: intent.amountAtomic, transferInterface: ARC_ERC20_USDC_INTERFACE,
      };
      return { kind: 'ok', value: { evidenceRef: receiptId, evidenceDigest: await digest('payment-evidence', evidence), receiptId, verified: true } };
    } catch {
      return { kind: 'unavailable', message: 'Arc RPC or durable receipt reservation is unavailable.' };
    }
  }
}
