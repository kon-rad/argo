import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
export const CYBA_ENVELOPE_VERSION = 'cybazaar-envelope/v1';
export interface CybaEnvelopeInput {
    method: string;
    path: string;
    body: string;
    wallet: string;
    timestamp: number;
}
export function canonicalEnvelope(input: CybaEnvelopeInput): string {
    return JSON.stringify([CYBA_ENVELOPE_VERSION, input.method.toUpperCase(), input.path, createHash('sha256').update(input.body).digest('hex'), input.wallet.toLowerCase(), String(input.timestamp)]);
}
export function signEngineRequest(input: CybaEnvelopeInput, secret: string): string {
    return createHmac('sha256', secret).update(canonicalEnvelope(input)).digest('hex');
}
export function verifySignedEnvelope(input: CybaEnvelopeInput, signature: string, secret: string, now = Date.now()): boolean {
    if (Buffer.byteLength(secret) < 32 || !/^0x[0-9a-fA-F]{40}$/.test(input.wallet) || !Number.isSafeInteger(input.timestamp) || Math.abs(now - input.timestamp) > 60000 || !/^[0-9a-f]{64}$/.test(signature) || !input.path.startsWith('/api/desk/market/') || /[\r\n]/.test(input.path))
        return false;
    const expected = signEngineRequest(input, secret);
    return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'));
}
