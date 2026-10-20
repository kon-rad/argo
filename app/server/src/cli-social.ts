import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { config } from './config.js';
import { pool } from './db.js';
import { HttpError } from './routes/http.js';
import { checkImageCount, toPostMedia, toVideoMedia } from './social/media.js';
import { checkPost, type VideoProbe } from './social/rules.js';
import { BUFFER_PROVIDER_KEY, checkReauthNeeded, pollHandedOff, runDuePosts } from './social/scheduler.js';
import { accountIdForProvider, accountProvider, approvePost, cancelPost, listAccounts, listPosts, queuePost, saveConnectedAccount } from './social/store.js';
import { hermesTelegram } from './livestream-x.js';
import { PostOptionsSchema } from './routes/social.js';
import { bufferProvider } from './social/providers/buffer.js';
import { linkedinProvider } from './social/providers/linkedin.js';
import type { PostMedia, PostOptions, SocialProvider } from './social/providers/types.js';

// `cli-social.js` with no arguments is one pass: publish every due post, then
// check for accounts that need reauthorization within 7 days (itself
// debounced to once/24h). On a server a systemd timer runs it every minute
// (deploy/secondbrain-social.*, social module). Reuses hermesTelegram() from
// the livestream module — same bot, same "please take a manual action" channel.
//
// The other commands are how an agent (or the owner) queues and inspects posts
// without a browser session. Queueing reads the images from local disk and
// stores their bytes in Postgres, so it works from any machine that reaches
// the database; the server's timer publishes them.

const USAGE = `cli-social: the social posting queue (Postgres; the server's timer publishes due posts every minute).

  (no command) | run          one publishing pass (what the timer runs)
  accounts                    connected accounts: id, network, transport, name, token expiry
  connect-buffer              add (or refresh) one account per Instagram, YouTube and X channel
                              connected in the Buffer account of BUFFER_API_KEY
  posts [--status S]          draft|queued|publishing|posted|failed|canceled, with their media
  queue --body-file F | --body T  [--image PATH --alt "text"]... | [--video PATH]
        [--account ID|linkedin|x|instagram|youtube] [--at ISO] [--draft]
        [--option key=value]... [--options-file F.json]
                              queue a post; each --image needs an --alt, in the same order.
                              --account defaults to the only connected account; --at to now.
                              --draft: wait for \`approve\` instead of posting at --at.
                              Options: instagramType=post|reel|story, shareToFeed, firstComment,
                              title (YouTube, required), categoryId, privacy, madeForKids,
                              notifySubscribers, aiGenerated; thread (X) only in --options-file
  approve <post id> [--at ISO] queue a draft (for --at, else its own time or now)
  cancel <post id>            cancel a post that is queued or a draft`;

function providers(): Record<string, SocialProvider> {
  const p: Record<string, SocialProvider> = {};
  if (config.linkedinClientId && config.linkedinClientSecret) {
    p.linkedin = linkedinProvider({ clientId: config.linkedinClientId, clientSecret: config.linkedinClientSecret });
  }
  if (config.bufferApiKey) p[BUFFER_PROVIDER_KEY] = bufferProvider({ apiKey: config.bufferApiKey });
  return p;
}

/** Width, height and length of a video, when ffprobe is installed; undefined otherwise (the checks that need it are skipped). */
function probeVideo(path: string): VideoProbe | undefined {
  try {
    const out = execFileSync(
      'ffprobe',
      ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:format=duration', '-of', 'json', path],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const j = JSON.parse(out) as { streams?: { width?: number; height?: number }[]; format?: { duration?: string } };
    const st = j.streams?.[0];
    const seconds = Number(j.format?.duration);
    if (!st?.width || !st.height || !Number.isFinite(seconds)) return undefined;
    return { width: st.width, height: st.height, seconds };
  } catch {
    return undefined;
  }
}

const BOOLEAN_OPTIONS = new Set(['shareToFeed', 'madeForKids', 'notifySubscribers', 'aiGenerated']);

function parseOptions(pairs: string[], file: string | undefined): PostOptions {
  const raw: Record<string, unknown> = file ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>) : {};
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq < 1) throw new HttpError(400, `bad --option ${pair}; use key=value`);
    const key = pair.slice(0, eq);
    const value = pair.slice(eq + 1);
    if (BOOLEAN_OPTIONS.has(key) && value !== 'true' && value !== 'false') throw new HttpError(400, `--option ${key} takes true or false`);
    raw[key] = BOOLEAN_OPTIONS.has(key) ? value === 'true' : value;
  }
  const parsed = PostOptionsSchema.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, `bad options: ${parsed.error.issues.map((i) => `${i.path.join('.') || i.message}: ${i.message}`).join('; ')}`);
  return parsed.data as PostOptions;
}

async function resolveAccount(value: string | undefined): Promise<number> {
  if (!value) {
    const accounts = await listAccounts();
    if (accounts.length !== 1) throw new HttpError(400, `${accounts.length} connected accounts; pick one with --account (see \`cli-social accounts\`)`);
    return Number(accounts[0]!.id);
  }
  if (/^\d+$/.test(value)) return Number(value);
  return accountIdForProvider(value);
}

async function connectBuffer(): Promise<number> {
  if (!config.bufferApiKey) throw new HttpError(400, 'BUFFER_API_KEY is not set');
  const buffer = bufferProvider({ apiKey: config.bufferApiKey });
  for (const c of await buffer.listChannels()) {
    const name = c.displayName ?? c.name;
    if (!c.provider) {
      console.log(`skipped  ${c.service}  ${name}  (not relayed through Buffer)`);
      continue;
    }
    if (c.isDisconnected || c.isLocked) {
      console.log(`skipped  ${c.service}  ${name}  (${c.isDisconnected ? 'disconnected' : 'locked'} in Buffer; fix it there)`);
      continue;
    }
    const id = await saveConnectedAccount(
      c.provider,
      {
        providerAccountId: c.id,
        displayName: `${name} (${c.externalLink ?? c.service})`,
        // The key is env, not a row; this placeholder never expires, so no reauth pings.
        tokens: { accessToken: 'buffer', accessTokenExpiresAt: new Date('9999-12-31T00:00:00Z'), refreshToken: null, refreshTokenExpiresAt: null },
      },
      config.socialTokenEncKey,
      'buffer',
    );
    console.log(`account ${id}  ${c.provider}  ${name}  via Buffer`);
  }
  return 0;
}

async function runOnce(): Promise<number> {
  const now = new Date();
  const p = providers();
  const notify = hermesTelegram();
  const { posted, failed, handedOff } = await runDuePosts(p, config.socialTokenEncKey, now, undefined, undefined, { mediaBaseUrl: config.socialMediaBaseUrl });
  if (posted || failed || handedOff) console.log(`social: posted ${posted}, handed to Buffer ${handedOff}, failed ${failed}`);
  const polled = await pollHandedOff(p, config.socialTokenEncKey, notify, now);
  if (polled.posted || polled.failed) console.log(`social: Buffer confirmed ${polled.posted}, failed ${polled.failed}`);
  try {
    await checkReauthNeeded(notify, now);
  } catch (err) {
    // A missed ping isn't a posting error; log it and let the next minute retry.
    console.error(`social: reauth check failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return failed || polled.failed ? 2 : 0;
}

function kb(bytes: number): string {
  return `${Math.round(bytes / 1024)} KB`;
}

async function queue(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      account: { type: 'string' },
      body: { type: 'string' },
      'body-file': { type: 'string' },
      image: { type: 'string', multiple: true },
      alt: { type: 'string', multiple: true },
      video: { type: 'string' },
      at: { type: 'string' },
      draft: { type: 'boolean' },
      option: { type: 'string', multiple: true },
      'options-file': { type: 'string' },
    },
    strict: true,
  });

  const body = (values['body-file'] ? readFileSync(values['body-file'], 'utf8') : (values.body ?? '')).trim();
  if (!body) throw new HttpError(400, 'the post needs --body or --body-file');

  const images = values.image ?? [];
  const alts = values.alt ?? [];
  if (images.length !== alts.length) throw new HttpError(400, `${images.length} --image but ${alts.length} --alt; every image needs its alt text`);
  if (values.video && images.length) throw new HttpError(400, 'a post carries images or one --video, not both');
  checkImageCount(images.length);
  const media: PostMedia[] = images.map((path, i) => toPostMedia(path, readFileSync(path), alts[i]!));
  const probes: (VideoProbe | undefined)[] = media.map(() => undefined);
  if (values.video) {
    media.push(toVideoMedia(values.video, readFileSync(values.video)));
    const probe = probeVideo(values.video);
    if (!probe) console.error('note: ffprobe not found or unreadable video; the size and length checks were skipped');
    probes.push(probe);
  }
  const options = parseOptions(values.option ?? [], values['options-file']);

  const accountId = await resolveAccount(values.account);
  if (!Number.isInteger(accountId) || accountId <= 0) throw new HttpError(400, `bad --account ${values.account}`);
  const account = await accountProvider(accountId);
  if (!account) throw new HttpError(404, `no connected account ${accountId}`);
  checkPost(account.provider, body, media, options, { xMaxChars: config.socialXMaxChars }, probes);

  const at = values.at && values.at !== 'now' ? new Date(values.at) : new Date();
  if (Number.isNaN(at.getTime())) throw new HttpError(400, `bad --at ${values.at}; use an ISO time like 2026-10-20T09:00:00+09:00`);

  const post = await queuePost(accountId, body, media, at, options, values.draft ? 'draft' : 'queued');
  const verb = values.draft ? 'drafted' : 'queued';
  console.log(`${verb} post ${post.id} for ${account.provider} account ${accountId} at ${new Date(post.scheduled_for).toISOString()} (${body.length} characters)`);
  for (const m of post.media) console.log(`  media ${m.position + 1}: ${m.filename}, ${m.contentType}, ${kb(m.size)}${m.altText ? `, alt "${m.altText}"` : ''}`);
  if (values.draft) console.log(`  approve with: cli-social approve ${post.id} [--at ISO]`);
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case undefined:
    case 'run':
      return runOnce();
    case 'accounts': {
      for (const a of await listAccounts()) {
        const expiry = a.transport === 'buffer' ? 'via Buffer' : `token expires ${a.accessTokenExpiresAt.toISOString()}${a.hasRefreshToken ? ' (refreshable)' : ''}`;
        console.log(`${a.id}  ${a.provider}  ${a.displayName}  ${expiry}`);
      }
      return 0;
    }
    case 'posts': {
      const { values } = parseArgs({ args: rest, options: { status: { type: 'string' } }, strict: true });
      for (const p of await listPosts(values.status)) {
        const where = p.remote_url ? `  ${p.remote_url}` : p.last_error ? `  error: ${p.last_error}` : '';
        console.log(`${p.id}  ${p.status}  account ${p.account_id}  ${new Date(p.scheduled_for).toISOString()}  ${p.media.length} media  ${p.body.slice(0, 60).replace(/\n/g, ' ')}${where}`);
      }
      return 0;
    }
    case 'queue':
      return queue(rest);
    case 'connect-buffer':
      return connectBuffer();
    case 'approve': {
      const { values, positionals } = parseArgs({ args: rest, options: { at: { type: 'string' } }, allowPositionals: true, strict: true });
      const id = Number(positionals[0]);
      if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'approve <post id> [--at ISO]');
      const at = values.at ? new Date(values.at) : undefined;
      if (at && Number.isNaN(at.getTime())) throw new HttpError(400, `bad --at ${values.at}`);
      const post = await approvePost(id, new Date(), at);
      if (!post) throw new HttpError(409, `post ${id} is not a draft`);
      console.log(`approved post ${id}: queued for ${new Date(post.scheduled_for).toISOString()}`);
      return 0;
    }
    case 'cancel': {
      const id = Number(rest[0]);
      if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'cancel <post id>');
      if (!(await cancelPost(id))) throw new HttpError(409, `post ${id} is not queued or a draft (already publishing, posted or canceled)`);
      console.log(`canceled post ${id}`);
      return 0;
    }
    default:
      console.log(USAGE);
      return cmd === 'help' || cmd === '--help' ? 0 : 1;
  }
}

let code = 1;
try {
  code = await main(process.argv.slice(2));
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  // A failed publishing pass is 1, as before; a bad queue/cancel request is 1 too.
  code = 1;
} finally {
  await pool.end();
}
process.exit(code);
