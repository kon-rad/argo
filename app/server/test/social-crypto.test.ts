import { describe, expect, it } from 'vitest';
import { decryptToken, encryptToken, NoEncryptionKeyError } from '../src/social/crypto.js';

const KEY = '0'.repeat(63) + '1'; // 64 hex chars = 32 bytes

describe('social token encryption', () => {
  it('round-trips a token', () => {
    const stored = encryptToken('AQX-some-real-looking-token', KEY);
    expect(stored.split(':')).toHaveLength(3);
    expect(decryptToken(stored, KEY)).toBe('AQX-some-real-looking-token');
  });

  it('produces different ciphertext each time (random IV)', () => {
    expect(encryptToken('same input', KEY)).not.toBe(encryptToken('same input', KEY));
  });

  it('refuses to encrypt or decrypt without a key', () => {
    expect(() => encryptToken('x', undefined)).toThrow(NoEncryptionKeyError);
    expect(() => decryptToken('a:b:c', undefined)).toThrow(NoEncryptionKeyError);
  });

  it('a tampered ciphertext fails authentication rather than decrypting silently', () => {
    const stored = encryptToken('secret', KEY);
    const [iv, tag, data] = stored.split(':');
    const tampered = `${iv}:${tag}:${data!.slice(0, -2)}00`;
    expect(() => decryptToken(tampered, KEY)).toThrow();
  });
});
