import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM, one key for the whole app (SOCIAL_TOKEN_ENC_KEY, 32 bytes as
 * hex). Every other module's secrets are a static env var; this is the first
 * one holding live bearer tokens to real third-party accounts, so those
 * columns are encrypted at rest even though the database itself is already
 * access-controlled. ciphertext format: `<iv-hex>:<tag-hex>:<ciphertext-hex>`.
 */
export class NoEncryptionKeyError extends Error {
  constructor() {
    super('SOCIAL_TOKEN_ENC_KEY is not set; the social module cannot store or read tokens without it');
  }
}

function keyBuffer(hexKey: string | undefined): Buffer {
  if (!hexKey) throw new NoEncryptionKeyError();
  return Buffer.from(hexKey, 'hex');
}

export function encryptToken(plaintext: string, hexKey: string | undefined): string {
  const key = keyBuffer(hexKey);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${ciphertext.toString('hex')}`;
}

export function decryptToken(stored: string, hexKey: string | undefined): string {
  const key = keyBuffer(hexKey);
  const [ivHex, tagHex, dataHex] = stored.split(':');
  if (!ivHex || !tagHex || !dataHex) throw new Error('malformed encrypted token');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
}
