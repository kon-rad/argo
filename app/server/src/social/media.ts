import { basename } from 'node:path';
import { HttpError } from '../routes/http.js';
import type { PostMedia } from './providers/types.js';

/** Our own cap, not LinkedIn's: matches the column CHECK and keeps a post's row small. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** LinkedIn's multi-image posts take up to 20. */
export const MAX_IMAGES = 20;
export const MAX_ALT_TEXT = 1000;

/** The type comes from the file's first bytes, never from its name. */
export function sniffImageType(bytes: Buffer): PostMedia['contentType'] | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.length >= 6 && (bytes.subarray(0, 6).toString('latin1') === 'GIF87a' || bytes.subarray(0, 6).toString('latin1') === 'GIF89a')) return 'image/gif';
  return null;
}

/** Validates one image before it is queued; throws a 400 naming the file and the rule it broke. */
export function toPostMedia(filename: string, bytes: Buffer, altText: string): PostMedia {
  const name = basename(filename) || 'image';
  if (bytes.length === 0) throw new HttpError(400, `${name}: empty file`);
  if (bytes.length > MAX_IMAGE_BYTES) throw new HttpError(400, `${name}: ${bytes.length} bytes, over the ${MAX_IMAGE_BYTES}-byte limit`);
  const contentType = sniffImageType(bytes);
  if (!contentType) throw new HttpError(400, `${name}: not a JPEG, PNG or GIF`);
  const alt = altText.trim();
  if (!alt) throw new HttpError(400, `${name}: alt text is required`);
  if (alt.length > MAX_ALT_TEXT) throw new HttpError(400, `${name}: alt text is ${alt.length} characters, over ${MAX_ALT_TEXT}`);
  return { filename: name, contentType, bytes, altText: alt };
}

export function checkImageCount(n: number): void {
  if (n > MAX_IMAGES) throw new HttpError(400, `${n} images; a post takes at most ${MAX_IMAGES}`);
}
