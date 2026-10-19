import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { config } from './config.js';
import { pool } from './db.js';
import { HttpError } from './routes/http.js';
import { checkBodyLength, checkImageCount, toPostMedia } from './social/media.js';
import { checkReauthNeeded, runDuePosts } from './social/scheduler.js';
import { cancelPost, listAccounts, listPosts, queuePost } from './social/store.js';
import { hermesTelegram } from './livestream-x.js';
import { linkedinProvider } from './social/providers/linkedin.js';
import type { SocialProvider } from './social/providers/types.js';

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
  accounts                    connected accounts: id, provider, name, token expiry
  posts [--status S]          queued|publishing|posted|failed|canceled, with their images
  queue --body-file F | --body T  [--image PATH --alt "text"]...  [--account ID] [--at ISO]
                              queue a post; each --image needs an --alt, in the same order.
                              --account defaults to the only connected account; --at to now
  cancel <post id>            cancel a post that is still queued`;

function providers(): Record<string, SocialProvider> {
  const p: Record<string, SocialProvider> = {};
  if (config.linkedinClientId && config.linkedinClientSecret) {
    p.linkedin = linkedinProvider({ clientId: config.linkedinClientId, clientSecret: config.linkedinClientSecret });
  }
  return p;
}

async function runOnce(): Promise<number> {
  const now = new Date();
  const { posted, failed } = await runDuePosts(providers(), config.socialTokenEncKey, now);
  if (posted || failed) console.log(`social: posted ${posted}, failed ${failed}`);
  try {
    await checkReauthNeeded(hermesTelegram(), now);
  } catch (err) {
    // A missed ping isn't a posting error; log it and let the next minute retry.
    console.error(`social: reauth check failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return failed ? 2 : 0;
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
      at: { type: 'string' },
    },
    strict: true,
  });

  const body = (values['body-file'] ? readFileSync(values['body-file'], 'utf8') : (values.body ?? '')).trim();
  if (!body) throw new HttpError(400, 'the post needs --body or --body-file');
  checkBodyLength(body);

  const images = values.image ?? [];
  const alts = values.alt ?? [];
  if (images.length !== alts.length) throw new HttpError(400, `${images.length} --image but ${alts.length} --alt; every image needs its alt text`);
  checkImageCount(images.length);
  const media = images.map((path, i) => toPostMedia(path, readFileSync(path), alts[i]!));

  let accountId = values.account ? Number(values.account) : NaN;
  if (!values.account) {
    const accounts = await listAccounts();
    if (accounts.length !== 1) throw new HttpError(400, `${accounts.length} connected accounts; pick one with --account (see \`cli-social accounts\`)`);
    accountId = Number(accounts[0]!.id);
  }
  if (!Number.isInteger(accountId) || accountId <= 0) throw new HttpError(400, `bad --account ${values.account}`);

  const at = values.at && values.at !== 'now' ? new Date(values.at) : new Date();
  if (Number.isNaN(at.getTime())) throw new HttpError(400, `bad --at ${values.at}; use an ISO time like 2026-10-20T09:00:00+09:00`);

  const post = await queuePost(accountId, body, media, at);
  console.log(`queued post ${post.id} for account ${accountId} at ${new Date(post.scheduled_for).toISOString()} (${body.length} characters)`);
  for (const m of post.media) console.log(`  image ${m.position + 1}: ${m.filename}, ${m.contentType}, ${kb(m.size)}, alt "${m.altText}"`);
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
        console.log(`${a.id}  ${a.provider}  ${a.displayName}  token expires ${a.accessTokenExpiresAt.toISOString()}${a.hasRefreshToken ? ' (refreshable)' : ''}`);
      }
      return 0;
    }
    case 'posts': {
      const { values } = parseArgs({ args: rest, options: { status: { type: 'string' } }, strict: true });
      for (const p of await listPosts(values.status)) {
        const where = p.remote_url ? `  ${p.remote_url}` : p.last_error ? `  error: ${p.last_error}` : '';
        console.log(`${p.id}  ${p.status}  ${new Date(p.scheduled_for).toISOString()}  ${p.media.length} image(s)  ${p.body.slice(0, 60).replace(/\n/g, ' ')}${where}`);
      }
      return 0;
    }
    case 'queue':
      return queue(rest);
    case 'cancel': {
      const id = Number(rest[0]);
      if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'cancel <post id>');
      if (!(await cancelPost(id))) throw new HttpError(409, `post ${id} is not queued (already publishing, posted or canceled)`);
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
