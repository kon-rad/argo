import { HttpError } from '../routes/http.js';
import { checkBodyLength } from './media.js';
import type { PostMedia, PostOptions, ProviderName } from './providers/types.js';
import { isVideo } from './providers/types.js';

// What each network accepts, checked when a post is queued so a bad post fails
// in the agent's terminal, not a minute later on the timer, and never quietly
// falls back to Buffer's "notification publishing" (a phone reminder a person
// finishes by hand). Limits are Buffer's and the networks' (Buffer's
// "Character limits" guide and help centre, read 2026-10-20).

export const X_URL_WEIGHT = 23;
export const INSTAGRAM_CAPTION_MAX = 2196;
export const YOUTUBE_TITLE_MAX = 100;
export const YOUTUBE_DESCRIPTION_MAX = 5000;
export const YOUTUBE_SHORT_MAX_SECONDS = 180;
export const REEL_MIN_SECONDS = 5;
export const REEL_MAX_SECONDS = 15 * 60;
/** Instagram's feed accepts images from 4:5 (0.8) to 1.91:1. */
export const INSTAGRAM_MIN_ASPECT = 0.8;
export const INSTAGRAM_MAX_ASPECT = 1.91;

export interface RuleLimits {
  /** X's weighted limit: 280 on a free account, 25,000 on Premium (SOCIAL_X_MAX_CHARS). */
  xMaxChars: number;
}

/** What ffprobe says about a video, when the queueing machine has it. */
export interface VideoProbe {
  width: number;
  height: number;
  seconds: number;
}

/**
 * X's weighted length (twitter-text): a URL counts 23, Latin and common
 * punctuation 1, everything else (CJK, emoji) 2.
 */
export function xWeightedLength(text: string): number {
  let n = 0;
  const rest = text.replace(/https?:\/\/\S+/g, () => {
    n += X_URL_WEIGHT;
    return '';
  });
  for (const ch of rest) {
    const cp = ch.codePointAt(0)!;
    const light = cp <= 0x10ff || (cp >= 0x2000 && cp <= 0x200d) || (cp >= 0x2010 && cp <= 0x201f) || (cp >= 0x2032 && cp <= 0x2037);
    n += light ? 1 : 2;
  }
  return n;
}

/** Instagram counts UTF-16 units and each line break as 2. */
export function instagramLength(text: string): number {
  return text.length + (text.match(/\n/g)?.length ?? 0);
}

/** Width and height from a PNG, GIF or JPEG header; null if it can't tell. */
export function imageSize(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length >= 24 && bytes.readUInt32BE(0) === 0x89504e47) return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  if (bytes.length >= 10 && bytes.subarray(0, 3).toString('latin1') === 'GIF') return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) return null;
      const marker = bytes[i + 1]!;
      const len = bytes.readUInt16BE(i + 2);
      // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC) carry the frame size.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: bytes.readUInt16BE(i + 5), width: bytes.readUInt16BE(i + 7) };
      }
      i += 2 + len;
    }
  }
  return null;
}

function bad(network: string, message: string): never {
  throw new HttpError(400, `${network}: ${message}`);
}

/**
 * Throws a 400 naming the rule the post breaks for this network. `probes` are
 * per media item, in order (undefined for images, or when ffprobe wasn't there).
 */
export function checkPost(
  provider: ProviderName,
  body: string,
  media: PostMedia[],
  options: PostOptions,
  limits: RuleLimits,
  probes: (VideoProbe | undefined)[] = [],
): void {
  const videos = media.filter(isVideo);
  const images = media.filter((m) => !isVideo(m));
  if (videos.length > 1) bad(provider, 'one video per post');
  if (videos.length && images.length) bad(provider, 'a post carries images or one video, not both');
  const probe = probes[media.findIndex(isVideo)];

  switch (provider) {
    case 'linkedin':
      if (videos.length) bad('linkedin', 'video is not supported on LinkedIn yet; post images');
      checkBodyLength(body);
      return;

    case 'x': {
      if (options.coverAt !== undefined) bad('x', 'coverAt works on Instagram only');
      const parts = [body, ...(options.thread ?? [])];
      parts.forEach((text, i) => {
        const len = xWeightedLength(text);
        if (!text.trim()) bad('x', `thread post ${i + 1} is empty`);
        if (len > limits.xMaxChars) bad('x', `${i === 0 ? 'the post' : `thread post ${i + 1}`} is ${len} weighted characters; ${limits.xMaxChars} at most (SOCIAL_X_MAX_CHARS)`);
      });
      return;
    }

    case 'instagram': {
      const type = options.instagramType ?? (videos.length ? 'reel' : 'post');
      const len = instagramLength(body);
      if (len > INSTAGRAM_CAPTION_MAX) bad('instagram', `the caption counts ${len} (line breaks count 2); ${INSTAGRAM_CAPTION_MAX} at most`);
      if (!media.length) bad('instagram', 'a post needs an image or a video');
      if (type === 'reel' && !videos.length) bad('instagram', 'a reel needs a video');
      if (options.coverAt !== undefined && !videos.length) bad('instagram', 'coverAt picks a frame of a video; this post has none');
      if (options.coverAt !== undefined && probe && options.coverAt > probe.seconds) {
        bad('instagram', `coverAt is ${options.coverAt} s but the video is ${probe.seconds.toFixed(1)} s`);
      }
      if (probe && type === 'reel' && (probe.seconds < REEL_MIN_SECONDS || probe.seconds > REEL_MAX_SECONDS)) {
        bad('instagram', `the reel is ${probe.seconds.toFixed(1)} s; Instagram auto-publishes ${REEL_MIN_SECONDS} s to ${REEL_MAX_SECONDS / 60} min`);
      }
      if (type !== 'story') {
        for (const m of images) {
          const size = imageSize(m.bytes);
          const aspect = size ? size.width / size.height : null;
          if (aspect !== null && (aspect < INSTAGRAM_MIN_ASPECT - 1e-9 || aspect > INSTAGRAM_MAX_ASPECT + 1e-9)) {
            bad('instagram', `${m.filename} is ${size!.width}x${size!.height} (${aspect.toFixed(3)}); the feed takes ${INSTAGRAM_MIN_ASPECT} to ${INSTAGRAM_MAX_ASPECT} (1080x1350 is the tallest)`);
          }
        }
      }
      return;
    }

    case 'youtube': {
      if (videos.length !== 1 || images.length) bad('youtube', 'a Short is exactly one video');
      if (options.coverAt !== undefined) bad('youtube', 'coverAt works on Instagram only; Buffer cannot set a Short\'s cover');
      const title = options.title?.trim();
      if (!title) bad('youtube', 'a title is required (--option title=...)');
      if (title.length > YOUTUBE_TITLE_MAX) bad('youtube', `the title is ${title.length} characters; ${YOUTUBE_TITLE_MAX} at most`);
      if (body.length > YOUTUBE_DESCRIPTION_MAX) bad('youtube', `the description is ${body.length} characters; ${YOUTUBE_DESCRIPTION_MAX} at most`);
      if (probe) {
        const square = probe.width === probe.height;
        const vertical = probe.width * 16 === probe.height * 9;
        if (!square && !vertical) bad('youtube', `the video is ${probe.width}x${probe.height}; Buffer publishes Shorts only at exactly 9:16 or 1:1`);
        if (probe.seconds > YOUTUBE_SHORT_MAX_SECONDS) bad('youtube', `the video is ${probe.seconds.toFixed(1)} s; Shorts are ${YOUTUBE_SHORT_MAX_SECONDS / 60} min at most (Buffer posts no long-form)`);
      }
      return;
    }

    default:
      bad(provider, 'no posting rules for this network yet');
  }
}
