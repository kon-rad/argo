import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { canonicalEnvelope, signEngineRequest, verifySignedEnvelope } from './envelope.js';
const fixture = JSON.parse(readFileSync(new URL('./fixtures/engine-envelope.json', import.meta.url), 'utf8'));
describe('market envelope', () => {
    it('matches the Bun signer exact interop fixture', () => {
        const input = fixture.input ?? fixture.request ?? fixture;
        expect(canonicalEnvelope(input)).toBe(fixture.canonical);
        expect(signEngineRequest(input, fixture.secret)).toBe(fixture.signature);
        expect(verifySignedEnvelope(input, fixture.signature, fixture.secret, input.timestamp)).toBe(true);
    });
    it('binds every authoritative field and rejects stale/future/bad secrets', () => {
        const input = { method: 'POST', path: '/api/desk/market/jobs', body: '{"title":"test"}', wallet: '0x' + 'a'.repeat(40), timestamp: 100000 };
        const secret = 'synthetic-test-secret-32-characters';
        const signature = signEngineRequest(input, secret);
        for (const patch of [{ method: 'GET' }, { path: '/api/desk/market/jobs/other' }, { body: '{}' }, { wallet: '0x' + 'b'.repeat(40) }, { timestamp: 100001 }])
            expect(verifySignedEnvelope({ ...input, ...patch }, signature, secret, input.timestamp)).toBe(false);
        expect(verifySignedEnvelope(input, signature, secret, 160001)).toBe(false);
        expect(verifySignedEnvelope(input, signature, 'short', input.timestamp)).toBe(false);
    });
});
