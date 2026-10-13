import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/**
 * scrypt from node:crypto rather than an argon2 native module: it is memory-hard,
 * OWASP-listed, and needs no compiler on the server. N=2^17, r=8 costs 128 MiB
 * and roughly a quarter second per guess — irrelevant for one login, ruinous
 * for an offline attack on a leaked hash.
 *
 * Format: scrypt$<logN>$<r>$<p>$<salt b64>$<hash b64>, so the cost can be
 * raised later without invalidating the stored hash.
 */
const LOG_N = 17;
const R = 8;
const P = 1;
const KEY_LEN = 32;

function derive(password: string, salt: Buffer, logN: number, r: number, p: number): Promise<Buffer> {
  const N = 2 ** logN;
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFKC'), salt, KEY_LEN, { N, r, p, maxmem: 256 * N * r }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, LOG_N, R, P);
  return ['scrypt', LOG_N, R, P, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, logN, r, p, salt, hash] = parts as [string, string, string, string, string, string];
  const expected = Buffer.from(hash, 'base64');
  const key = await derive(password, Buffer.from(salt, 'base64'), Number(logN), Number(r), Number(p));
  return key.length === expected.length && timingSafeEqual(key, expected);
}
