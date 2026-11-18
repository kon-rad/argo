import { describe, expect, it, vi } from 'vitest';
import { digest, type PaymentEvidence, type PaymentIntent } from '@secondbrain/desk-contracts/desk';
import { ARC_NATIVE_USDC_INTERFACE, ARC_SYSTEM_EMITTER, ARC_TESTNET_CHAIN_ID, TRANSFER_TOPIC, parseDecimalToAtomic, type ArcReadClient, type ArcReceipt, type ArcTransaction, type ArcTransferLog } from './arc.js';
import { ARC_ERC20_USDC_INTERFACE, ARC_TESTNET_USDC_ADDRESS, ARC_USDC_ERC20_DECIMALS, ArcErc20UsdcSettlement } from './arc-erc20.js';

// Synthetic fixtures only; no wallet keys, signatures or network calls.
const payer = '0x1111111111111111111111111111111111111111';
const recipient = '0x2222222222222222222222222222222222222222';
const other = '0x3333333333333333333333333333333333333333';
const txHash = `0x${'a'.repeat(64)}`;
const topic = (address: string) => `0x${address.slice(2).padStart(64, '0')}`;
const word = (value: bigint) => `0x${value.toString(16).padStart(64, '0')}`;
const intent: PaymentIntent = { jobRef: 'arkiv:arc-testnet/job1', acceptanceRef: 'arkiv:arc-testnet/accept1', chainId: ARC_TESTNET_CHAIN_ID, payer, recipient, asset: 'USDC', amountAtomic: '1250000', transferInterface: ARC_ERC20_USDC_INTERFACE };
const data = `0xa9059cbb${recipient.slice(2).padStart(64, '0')}${word(BigInt(intent.amountAtomic)).slice(2)}`;
const transfer = (overrides: Partial<ArcTransferLog> = {}): ArcTransferLog => ({ address: ARC_TESTNET_USDC_ADDRESS, topics: [TRANSFER_TOPIC, topic(payer), topic(recipient)], data: word(1250000n), logIndex: 4, ...overrides });
const receipt = (overrides: Partial<ArcReceipt> = {}): ArcReceipt => ({ status: 'success', transactionHash: txHash, logs: [transfer()], ...overrides });
const transaction = (overrides: Partial<ArcTransaction> = {}): ArcTransaction => ({ from: payer, to: ARC_TESTNET_USDC_ADDRESS, value: '0x0', input: data, ...overrides });
function reader(overrides: Partial<ArcReadClient> = {}): ArcReadClient { return { chainId: async () => ARC_TESTNET_CHAIN_ID, transaction: async () => transaction(), receipt: async () => receipt(), ...overrides }; }
const service = (client = reader(), reserve = async (_id: string, _assignment: string) => true) => new ArcErc20UsdcSettlement({ usdcAddress: ARC_TESTNET_USDC_ADDRESS, reader: client, reserve });

describe('Arc Testnet ERC-20 USDC settlement', () => {
  it('converts six-decimal amounts exactly and rejects excess precision', () => {
    expect(ARC_USDC_ERC20_DECIMALS).toBe(6);
    expect(parseDecimalToAtomic('1.25', 6)).toBe(intent.amountAtomic);
    expect(parseDecimalToAtomic('0.000001', 6)).toBe('1');
    expect(parseDecimalToAtomic('9007199254740993.123456', 6)).toBe('9007199254740993123456');
    expect(() => parseDecimalToAtomic('0.0000001', 6)).toThrow();
  });
  it('prepares canonical calldata to configured token with zero native value and no RPC call', async () => {
    const client = reader({ transaction: vi.fn(), receipt: vi.fn(), chainId: vi.fn() });
    expect(await service(client).prepare(intent)).toEqual({ kind: 'ok', value: { chainId: ARC_TESTNET_CHAIN_ID, transaction: { chainId: 5042002, from: payer, to: ARC_TESTNET_USDC_ADDRESS, value: '0x0', data } } });
    expect(client.chainId).not.toHaveBeenCalled(); expect(client.transaction).not.toHaveBeenCalled(); expect(client.receipt).not.toHaveBeenCalled();
  });
  it('requires the documented token address as explicit configuration', () => {
    expect(() => new ArcErc20UsdcSettlement({ usdcAddress: other })).toThrow();
    expect(() => new ArcErc20UsdcSettlement({ usdcAddress: '' })).toThrow();
  });
  it.each([
    { chainId: '1' }, { asset: 'ETH' }, { transferInterface: ARC_NATIVE_USDC_INTERFACE },
    { payer: 'invalid' }, { recipient: 'invalid' }, { recipient: `0x${'0'.repeat(40)}` },
    { amountAtomic: '0' }, { amountAtomic: '-1' }, { amountAtomic: '1.25' }, { amountAtomic: '01' },
    { amountAtomic: (1n << 256n).toString() }, { amountAtomic: '1'.repeat(1000) }, { jobRef: '' }, { jobRef: 'a\u0000b' }, { acceptanceRef: '' },
  ])('rejects invalid or native intent %j', async override => {
    expect((await service().prepare({ ...intent, ...override })).kind).toBe('invalid-input');
    expect((await service().verify({ ...intent, ...override }, txHash)).kind).toBe('invalid-input');
  });
  it('independently verifies token Transfer and binds evidence to canonical receipt identity', async () => {
    const reserve = vi.fn(async () => true), receiptId = `arc:5042002:${txHash}:4`;
    const evidence: PaymentEvidence = { version: 'desk/v1', domain: 'desk/v1', chainId: ARC_TESTNET_CHAIN_ID, type: 'payment', jobRef: intent.jobRef, acceptanceRef: intent.acceptanceRef, paymentChainId: ARC_TESTNET_CHAIN_ID, txHash, transferIndex: '4', payer, recipient, asset: 'USDC', amountAtomic: intent.amountAtomic, transferInterface: ARC_ERC20_USDC_INTERFACE };
    expect(await service(reader(), reserve).verify(intent, txHash.toUpperCase().replace('0X', '0x'))).toEqual({ kind: 'ok', value: { evidenceRef: receiptId, evidenceDigest: await digest('payment-evidence', evidence), receiptId, verified: true } });
    expect(reserve).toHaveBeenCalledExactlyOnceWith(receiptId, `${intent.jobRef}\u0000${intent.acceptanceRef}`);
  });
  it('normalizes RPC hex log indices before reserving', async () => {
    const reserve = vi.fn(async () => true);
    expect((await service(reader({ receipt: async () => receipt({ logs: [transfer({ logIndex: '0x04' })] }) }), reserve).verify(intent, txHash)).kind).toBe('ok');
    expect(reserve).toHaveBeenCalledWith(`arc:5042002:${txHash}:4`, expect.any(String));
  });
  it('cross-checks optional 18-decimal native mirror without allocating a second payment', async () => {
    const reserve = vi.fn(async () => true), mirror = transfer({ address: ARC_SYSTEM_EMITTER, data: word(1250000n * 10n ** 12n), logIndex: 3 });
    expect((await service(reader({ receipt: async () => receipt({ logs: [mirror, transfer()] }) }), reserve).verify(intent, txHash)).kind).toBe('ok');
    expect(reserve).toHaveBeenCalledExactlyOnceWith(`arc:5042002:${txHash}:4`, expect.any(String));
  });
  it.each([{ data: word(1250000n) }, { topics: [TRANSFER_TOPIC, topic(other), topic(recipient)] }, { topics: [TRANSFER_TOPIC, topic(payer), topic(other)] }, { logIndex: 4 }])('rejects inconsistent native mirror %j', async overrides => {
    const mirror = transfer({ address: ARC_SYSTEM_EMITTER, data: word(1250000n * 10n ** 12n), logIndex: 3, ...overrides }), reserve = vi.fn(async () => true);
    expect((await service(reader({ receipt: async () => receipt({ logs: [mirror, transfer()] }) }), reserve).verify(intent, txHash)).kind).toBe('failed'); expect(reserve).not.toHaveBeenCalled();
  });
  it('rejects ambiguous native mirrors', async () => {
    const mirror = transfer({ address: ARC_SYSTEM_EMITTER, data: word(1250000n * 10n ** 12n), logIndex: 3 });
    expect((await service(reader({ receipt: async () => receipt({ logs: [mirror, mirror, transfer()] }) })).verify(intent, txHash)).kind).toBe('failed');
  });
  it('rejects wrong RPC chain before inspecting a transaction or reserving', async () => {
    const client = reader({ chainId: async () => '1', transaction: vi.fn(), receipt: vi.fn() }), reserve = vi.fn(async () => true);
    expect((await service(client, reserve).verify(intent, txHash)).kind).toBe('failed'); expect(client.transaction).not.toHaveBeenCalled(); expect(reserve).not.toHaveBeenCalled();
  });
  it.each([
    { to: other }, { to: recipient }, { from: other }, { value: '0x1' }, { value: intent.amountAtomic },
    { input: '0x' }, { input: data.replace('0xa9059cbb', '0x095ea7b3') }, { input: `${data}00` }, { input: data.slice(0, -1) },
    { input: data.replace(recipient.slice(2), other.slice(2)) }, { input: `${data.slice(0, -64)}${word(1250001n).slice(2)}` }, { data: '0x' },
  ])('rejects wrong transaction contract, payer, native value or calldata %j', async overrides => {
    const reserve = vi.fn(async () => true);
    expect((await service(reader({ transaction: async () => transaction(overrides) }), reserve).verify(intent, txHash)).kind).toBe('failed'); expect(reserve).not.toHaveBeenCalled();
  });
  it.each([
    { address: other }, { topics: [TRANSFER_TOPIC, topic(other), topic(recipient)] }, { topics: [TRANSFER_TOPIC, topic(payer), topic(other)] }, { data: word(1250001n) },
    { topics: [TRANSFER_TOPIC, topic(payer), topic(recipient), topic(other)] }, { data: '0x1' }, { logIndex: -1 }, { logIndex: '1.5' }, { logIndex: Number.MAX_SAFE_INTEGER + 1 },
  ])('rejects wrong or malformed Transfer %j', async overrides => {
    const reserve = vi.fn(async () => true);
    expect((await service(reader({ receipt: async () => receipt({ logs: [transfer(overrides)] }) }), reserve).verify(intent, txHash)).kind).toBe('failed'); expect(reserve).not.toHaveBeenCalled();
  });
  it('rejects missing or ambiguous token Transfer logs', async () => {
    for (const logs of [[], [transfer(), transfer({ logIndex: 5 })]]) expect((await service(reader({ receipt: async () => receipt({ logs }) })).verify(intent, txHash)).kind).toBe('failed');
  });
  it('rejects reverted receipts and hash mismatch without reservation', async () => {
    const reserve = vi.fn(async () => true);
    expect((await service(reader({ receipt: async () => receipt({ status: 'reverted' }) }), reserve).verify(intent, txHash)).kind).toBe('failed');
    expect((await service(reader({ receipt: async () => receipt({ transactionHash: `0x${'b'.repeat(64)}` }) }), reserve).verify(intent, txHash)).kind).toBe('failed'); expect(reserve).not.toHaveBeenCalled();
  });
  it('returns pending for missing transaction, missing receipt and non-final receipt', async () => {
    const reserve = vi.fn(async () => true);
    for (const client of [reader({ transaction: async () => null }), reader({ receipt: async () => null }), reader({ receipt: async () => receipt({ status: 'pending' }) }), reader({ receipt: async () => receipt({ status: 'unknown' }) })]) expect((await service(client, reserve).verify(intent, txHash)).kind).toBe('pending');
    expect(reserve).not.toHaveBeenCalled();
  });
  it('cannot confirm a submitted hash without independent RPC and durable reservation', async () => {
    expect((await new ArcErc20UsdcSettlement({ usdcAddress: ARC_TESTNET_USDC_ADDRESS }).verify(intent, txHash)).kind).toBe('unavailable');
    expect((await new ArcErc20UsdcSettlement({ usdcAddress: ARC_TESTNET_USDC_ADDRESS, reader: reader() }).verify(intent, txHash)).kind).toBe('unavailable');
    expect((await service(reader({ receipt: async () => { throw new Error('RPC unavailable'); } })).verify(intent, txHash)).kind).toBe('unavailable');
    expect((await service(reader(), async () => { throw new Error('database unavailable'); }).verify(intent, txHash)).kind).toBe('unavailable');
    expect((await service().verify(intent, '0xabc')).kind).toBe('invalid-input');
  });
  it('rejects failed reservation and cross-job replay while allowing same-job verification retry', async () => {
    expect((await service(reader(), async () => false).verify(intent, txHash)).kind).toBe('failed');
    const allocation = new Map<string, string>();
    const adapter = service(reader(), async (id, assignment) => { const previous = allocation.get(id); if (previous !== undefined) return previous === assignment; allocation.set(id, assignment); return true; });
    expect((await adapter.verify(intent, txHash)).kind).toBe('ok'); expect((await adapter.verify(intent, txHash)).kind).toBe('ok');
    expect((await adapter.verify({ ...intent, jobRef: 'arkiv:arc-testnet/job2', acceptanceRef: 'arkiv:arc-testnet/accept2' }, txHash)).kind).toBe('failed'); expect(allocation.size).toBe(1);
  });
  it('reconciles only by independent reads, without a submission operation', async () => {
    const client = reader({ transaction: vi.fn(async () => transaction()), receipt: vi.fn(async () => receipt()) }), adapter = service(client);
    expect(await adapter.reconcile(intent, txHash)).toEqual(await adapter.verify(intent, txHash));
    expect(client.transaction).toHaveBeenCalledTimes(2); expect(client.receipt).toHaveBeenCalledTimes(2); expect(Object.keys(client).sort()).toEqual(['chainId', 'receipt', 'transaction']);
  });
});
