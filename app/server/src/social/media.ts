import { basename } from 'node:path';
import { HttpError } from '../routes/http.js';
import { toLittleText } from './providers/linkedin.js';
import type { ImageType, PostMedia, VideoType } from './providers/types.js';

/** Our own cap, not LinkedIn's: matches the column CHECK and keeps a post's row small. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** Matches the column CHECK; a reel or Short is well under it. The bytes are dropped once the post is out. */
export const MAX_VIDEO_BYTES = 200 * 1024 * 1024;
/**
 * Our cap; LinkedIn takes up to 20. Four keeps one queue request (base64 adds a
 * third) under the route's 30 MB JSON limit and one post's uploads well inside
 * the timer run's budget.
 */
export const MAX_IMAGES = 4;
export const MAX_BODY = 3000;
/** The longest any network takes (X Premium); each network's own limit is in rules.ts. */
export const MAX_ANY_BODY = 25000;
export const MAX_ALT_TEXT = 1000;

/** The type comes from the file's first bytes, never from its name. */
export function sniffImageType(bytes: Buffer): ImageType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.length >= 6 && (bytes.subarray(0, 6).toString('latin1') === 'GIF87a' || bytes.subarray(0, 6).toString('latin1') === 'GIF89a')) return 'image/gif';
  return null;
}

/** MP4 and QuickTime both start with an `ftyp` box; its brand tells them apart. */
export function sniffVideoType(bytes: Buffer): VideoType | null {
  if (bytes.length < 12 || bytes.subarray(4, 8).toString('latin1') !== 'ftyp') return null;
  return bytes.subarray(8, 12).toString('latin1') === 'qt  ' ? 'video/quicktime' : 'video/mp4';
}

/** Validates one video before it is queued. Networks take no alt text on a video. */
export function toVideoMedia(filename: string, bytes: Buffer): PostMedia {
  const name = basename(filename) || 'video';
  if (bytes.length === 0) throw new HttpError(400, `${name}: empty file`);
  if (bytes.length > MAX_VIDEO_BYTES) throw new HttpError(400, `${name}: ${bytes.length} bytes, over the ${MAX_VIDEO_BYTES}-byte limit`);
  const contentType = sniffVideoType(bytes);
  if (!contentType) throw new HttpError(400, `${name}: not an MP4 or MOV`);
  return { filename: name, contentType, bytes, altText: '' };
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

/** LinkedIn counts the escaped text, so a body near the limit is checked after escaping. */
export function checkBodyLength(body: string): void {
  const sent = toLittleText(body).length;
  if (sent > MAX_BODY) throw new HttpError(400, `the post is ${sent} characters once escaped for LinkedIn (${body.length} as typed); ${MAX_BODY} at most`);
}

export function checkImageCount(n: number): void {
  if (n > MAX_IMAGES) throw new HttpError(400, `${n} images; a post takes at most ${MAX_IMAGES}`);
}
