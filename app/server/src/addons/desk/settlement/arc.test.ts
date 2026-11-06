import { describe, expect, it } from 'vitest';
import type { PaymentIntent } from '@secondbrain/desk-contracts/desk';
import { ARC_NATIVE_USDC_INTERFACE, ARC_SYSTEM_EMITTER, ARC_TESTNET_CHAIN_ID, ArcNativeUsdcSettlement, TRANSFER_TOPIC, formatAtomicToDecimal, parseDecimalToAtomic, type ArcReadClient } from './arc.js';

const payer = '0x1111111111111111111111111111111111111111';
const recipient = '0x2222222222222222222222222222222222222222';
const other = '0x3333333333333333333333333333333333333333';
const txHash = `0x${'a'.repeat(64)}`;
const topic = (address: string) => `0x${address.slice(2).toLowerCase().padStart(64, '0')}`;
const intent: PaymentIntent = { jobRef: 'arkiv:arc-testnet/job1', acceptanceRef: 'arkiv:arc-testnet/accept1', chainId: ARC_TESTNET_CHAIN_ID, payer, recipient, asset: 'USDC', amountAtomic: '1250000000000000000', transferInterface: ARC_NATIVE_USDC_INTERFACE };

function reader(overrides: Partial<ArcReadClient> = {}): ArcReadClient {
  return {
    chainId: async () => ARC_TESTNET_CHAIN_ID,
    transaction: async () => ({ from: payer, to: recipient, value: intent.amountAtomic, input: '0x' }),
    receipt: async () => ({ status: 'success', transactionHash: txHash, logs: [{ address: ARC_SYSTEM_EMITTER, topics: [TRANSFER_TOPIC, topic(payer), topic(recipient)], data: `0x${BigInt(intent.amountAtomic).toString(16).padStart(64, '0')}`, logIndex: 4 }] }),
    ...overrides,
  };
}

describe('Arc Testnet native USDC settlement', () => {
  it('converts exact decimal strings at 18 digits without floating point', () => {
    expect(parseDecimalToAtomic('1.25')).toBe('1250000000000000000');
    expect(parseDecimalToAtomic('0.000000000000000001')).toBe('1');
    expect(parseDecimalToAtomic('9007199254740993.123456789012345678')).toBe('9007199254740993123456789012345678');
    expect(formatAtomicToDecimal('1250000000000000000')).toBe('1.25');
    expect(() => parseDecimalToAtomic('0.0000000000000000001')).toThrow();
    expect(() => parseDecimalToAtomic('1e-3')).toThrow();
  });

  it('prepares a direct native value transfer and refuses unsupported terms', async () => {
    const service = new ArcNativeUsdcSettlement();
    const result = await service.prepare(intent);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') expect(result.value.transaction).toEqual({ chainId: 5042002, from: payer, to: recipient, value: `0x${BigInt(intent.amountAtomic).toString(16)}`, data: '0x' });
    expect((await service.prepare({ ...intent, transferInterface: 'erc20' })).kind).toBe('invalid-input');
  });

  it('verifies the one authoritative 18-decimal system event and reserves its identity', async () => {
    let reserved = '';
    const service = new ArcNativeUsdcSettlement(reader({
      receipt: async () => ({ status: 'success', transactionHash: txHash, logs: [
        { address: ARC_SYSTEM_EMITTER, topics: [TRANSFER_TOPIC, topic(payer), topic(recipient)], data: `0x${BigInt(intent.amountAtomic).toString(16).padStart(64, '0')}`, logIndex: 4 },
        // The ERC-20 mirror uses 6 decimals and is intentionally not counted.
        { address: '0x3600000000000000000000000000000000000000', topics: [TRANSFER_TOPIC, topic(payer), topic(recipient)], data: `0x${(1250000n).toString(16).padStart(64, '0')}`, logIndex: 5 },
      ] }),
    }), async id => { reserved = id; return true; });
    const result = await service.verify(intent, txHash);
    expect(result.kind).toBe('ok');
    expect(reserved).toBe(`arc:${ARC_TESTNET_CHAIN_ID}:${txHash}:4`);
    if (result.kind === 'ok') expect(result.value.receiptId).toBe(reserved);
  });

  it('fails closed on wrong RPC chain, recipient, failed receipts, duplicate system events and reused receipts', async () => {
    const reserve = async () => true;
    expect((await new ArcNativeUsdcSettlement(reader({ chainId: async () => '1' }), reserve).verify(intent, txHash)).kind).toBe('failed');
    expect((await new ArcNativeUsdcSettlement(reader({ transaction: async () => ({ from: payer, to: other, value: intent.amountAtomic }) }), reserve).verify(intent, txHash)).kind).toBe('failed');
    expect((await new ArcNativeUsdcSettlement(reader({ receipt: async () => ({ status: 'reverted', transactionHash: txHash, logs: [] }) }), reserve).verify(intent, txHash)).kind).toBe('failed');
    expect((await new ArcNativeUsdcSettlement(reader({ receipt: async () => { const r = await reader().receipt(txHash); return r && { ...r, logs: [...r.logs, ...r.logs] }; } }), reserve).verify(intent, txHash)).kind).toBe('failed');
    expect((await new ArcNativeUsdcSettlement(reader(), async () => false).verify(intent, txHash)).kind).toBe('failed');
  });

  it('returns pending for missing chain data and unavailable without RPC or durable reservation', async () => {
    expect((await new ArcNativeUsdcSettlement(reader({ receipt: async () => null }), async () => true).verify(intent, txHash)).kind).toBe('pending');
    expect((await new ArcNativeUsdcSettlement().verify(intent, txHash)).kind).toBe('unavailable');
  });
});
