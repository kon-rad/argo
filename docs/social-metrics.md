# Social metrics

Status: **pilot** - collectors, storage and the report are built and tested against fake API answers; no live account has been checked through this code yet.

## Facebook Unified token-contract foundation

The server contains a pure validator for a future Facebook Unified Login integration. It is foundation code only: no route, configuration, token storage, session, onboarding flow or collector calls it yet. The existing Instagram Login setup and collector below are unchanged.

The validator accepts two distinct contracts and never treats either as a legacy Instagram token:

| Debug token type | Required permissions | Asset proof | Lifetime |
|---|---|---|---|
| `USER` | `instagram_basic`, `instagram_manage_insights`, `pages_show_list`, `pages_read_engagement` | Must be proved separately by the future account lookup before storage | `expires_at` must be finite, positive and in the future. A nonzero `data_access_expires_at` is an additional upper bound; zero means no separate data-access bound |
| `SYSTEM_USER` | `instagram_basic`, `instagram_manage_insights` | Every required permission must have a `granular_scopes` entry whose `target_ids` contains the intended asset | Every nonzero token or data-access expiry is enforced. Both zero means the debug response declares no time limit |

Both contracts must be valid and belong to the configured app. Invalid responses, absent permissions, cross-account asset grants, expired or nonfinite limits, and `PAGE`, `APP` or unknown token types are refused. Shared API error redaction also removes `code` and `input_token` query values, including repeated appearances of those values.

These rules are conservative local fixture behavior. Meta documentation was inaccessible during the preserved implementation run, and no live authorization or credential was used, so live Meta compatibility is not verified. A later storage and collector slice, then an auth and connect slice, must verify the current Meta response shapes before activation.

Daily follower counts and per-post views, likes and comments for the social accounts you own, written to your own Postgres by the `map` module's daily `metrics` timer. Nothing is collected until you list your accounts in `secondbrain.json`, and nothing here needs a paid service.

| Platform | How | Account numbers | Per post | Credential |
|---|---|---|---|---|
| YouTube | Data API v3 | subscribers (rounded by YouTube above 1,000), channel views, video count | views, likes, comments for every upload in `postDays` | `YOUTUBE_API_KEY` |
| Instagram | Instagram API with Instagram Login (Professional account) | followers, media count | insights: views, reach, likes, comments, shares, saves | a long-lived token, stored encrypted and refreshed by the timer |
| X | fxtwitter (public, unofficial) | followers | views, likes, replies, reposts, bookmarks for **known post ids only** | none |
| LinkedIn | by hand | followers | whatever you enter | none |

Account numbers go into `metric_samples` (the table the brain map reads) as `<key>.followers` (YouTube: `<key>.subscribers`), plus `<key>.views` and `<key>.videos` for YouTube and `<key>.posts` for Instagram. Per-post numbers go into `social_post_stats`, one row per post per UTC day.

## Configure your accounts

Add a `socialMetrics` block to `secondbrain.json`. Every list is empty by default. List every account you own; each one runs, fails and reports on its own.

```json
"socialMetrics": {
  "staleHours": 36,
  "postDays": 90,
  "maxPosts": 500,
  "youtube": [
    { "channelId": "UCxxxxxxxxxxxxxxxxxxxxxx", "key": "yt.example", "label": "YouTube @example" }
  ],
  "instagram": [
    { "username": "example.studio", "label": "Instagram @example.studio" }
  ],
  "x": [
    { "handle": "example", "postIdsFile": "Areas/social/x-post-ids.txt" }
  ],
  "linkedin": [
    { "account": "me", "label": "LinkedIn" }
  ]
}
```

| Field | Default | Meaning |
|---|---|---|
| `staleHours` | 36 | A reading older than this is **stale**: the report flags it and leaves it out of totals. Per account too (`staleHours` on the account); LinkedIn accounts default to 192 (8 days) because they are entered weekly |
| `postDays` | 90 | Per-post numbers are read for posts published in this many days |
| `maxPosts` | 500 | At most this many posts per account per run |
| `instagramApiVersion` | `v23.0` | Graph API version in Instagram calls |
| `key` (any account) | `yt.<channel id>`, `ig.<username>`, `x.<handle>`, `li.<account>`, lower-cased | The `metric_samples` prefix |
| `posts` (YouTube, Instagram, X) | true | Also collect per-post numbers |
| `followers` (X) | true | Also read the follower count |
| `tokenEnv` (Instagram) | none | Name of an env var holding a long-lived token, used once to seed the encrypted store |
| `postIdsFile` (X) | none | Vault-relative text file of X post ids or URLs, one per line, `#` for comments |

**Keeping old history.** To keep an existing metric's history, set `key` so `<key>.followers` (or `.subscribers`) is the key you already use, for example `"key": "yt.example"` to keep writing `yt.example.subscribers`. When an API collector writes a key, `metrics collect` skips the old page scraper for that key (it says so in its output), so no key gets two sources. You can leave the `metrics[]` entry in place for the brain map.

**Correcting a handle.** If an account was tracked under the wrong handle, change `username` (or `handle`) and leave `key` unset: the new handle gets a new key and the old key's readings stay as they were. The Instagram collector also checks that its token belongs to the configured username and writes nothing if it does not, so one account's numbers never land under another's key.

## YouTube setup

1. In a Google Cloud project, enable **YouTube Data API v3** and create an **API key**. Restrict it to that API.
2. Put it in the server's env file as `YOUTUBE_API_KEY` (or your vault's `.env` on a laptop).
3. Find each channel's id (`UC` and 22 characters; on the channel page, Share channel, Copy channel ID) and add it under `socialMetrics.youtube`.

Each run makes one `channels.list` call for up to 50 channels, then for each channel pages through its uploads playlist (`playlistItems.list`, 50 per page, newest first, stopping at `postDays` or `maxPosts`) and reads video statistics in batches of 50 (`videos.list`). Every call costs 1 unit of the free 10,000 a day. The key is sent in a header, never in a URL. A hidden subscriber count, hidden likes or disabled comments are stored as empty (NULL), never as 0.

## Instagram setup

The account must be a **Professional** account (Business or Creator; switching is free in the Instagram app).

1. Create a Meta app with the **Instagram** product, "API setup with Instagram login". Standard Access is enough for accounts you own or manage; no App Review.
2. Add the account as an Instagram tester of the app and accept the invite in the Instagram app.
3. Generate a token for the account with the scopes **`instagram_business_basic`** and **`instagram_business_manage_insights`**, and exchange it for a **long-lived** token (60 days).
4. Set `SOCIAL_TOKEN_ENC_KEY` (64 hex characters; `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`) if the social module has not already.
5. Store the token, piped on stdin so it stays out of shell history and process lists:

   ```bash
   secondbrain metrics social token instagram example.studio < token.txt
   ```

   It checks with Instagram that the token belongs to that username, then stores it encrypted in `social_metric_tokens`. Delete `token.txt` afterwards.

Alternatively name an env var in the account's `tokenEnv`; on the first run the collector copies that token into the encrypted store, and from then on the store wins. (A server env file generated by `secondbrain apply` only carries the keys the manifests list, so prefer the command above there.)

**Refresh and persistence.** A long-lived token can be refreshed once it is 24 hours old and lasts 60 days from each refresh. The timer refreshes it when its expiry is unknown, when the last refresh was 7 days ago, or daily in its last 14 days, and stores the new token encrypted with its new expiry. A failed refresh is recorded on the token row (`last_error`, redacted) and shown as a warning; collection carries on with the current token until it expires.

**Recovery.** If the token has expired, or was revoked, the collector reports `expired` or the API's error with the steps above. Generate a new long-lived token and run the `token` command again; it replaces the stored one. If `SOCIAL_TOKEN_ENC_KEY` is lost or changed, stored tokens can't be decrypted: set the key again and re-run the `token` command. Without `SOCIAL_TOKEN_ENC_KEY` at all, an env token from `tokenEnv` is used as is, with a warning, and stops working 60 days after it was issued.

Per post, the collector reads `/me/media` (paged) and each post's insights. When insights fail for some posts (an unsupported metric for that media type, say), those posts keep the likes and comments from the media fields and leave views, reach, shares and saves empty; when they fail for every post, the account reports an error (usually the token lacks `instagram_business_manage_insights`).

## X

fxtwitter (`api.fxtwitter.com`) is free and needs no key, but it is unofficial and can stop working without notice. It answers a profile and a single post by id. **It has no timeline**, so the collector never discovers posts on its own. It reads only:

- posts the `social` module published to X (their URL in `social_posts.remote_url`), and
- the ids or URLs in the account's `postIdsFile`, for posts made anywhere else. Add a line per post you want tracked, for example `https://x.com/example/status/1234567890123456789`.

Posts older than `postDays` are skipped by the time encoded in their id. A post by another account is skipped with a warning. Views that X hides come back empty, not 0. Replies are stored as `comments`, reposts as `shares`, bookmarks as `saves`; quotes are kept in `raw`.

## LinkedIn, by hand

LinkedIn's member post analytics API is offered to approved partners only, so nothing here calls LinkedIn and nothing claims automatic LinkedIn numbers. Read the numbers off LinkedIn (weekly is enough) and record them:

```bash
secondbrain metrics social linkedin me --followers 512 --date 2026-11-07
secondbrain metrics social linkedin me --post https://www.linkedin.com/feed/update/urn:li:activity:7000000000000000001/ \
  --views 900 --likes 12 --comments 3 --date 2026-11-07
```

The account must be listed under `socialMetrics.linkedin`. Entries are stored with source `manual`; a follower reading is stale after 8 days unless the account sets `staleHours`. Leave out a number you don't have: it stays empty, not 0.

## The daily timer

`secondbrain-metrics.timer` (daily at about 00:30 UTC, installed when the `map` module is on) runs `secondbrain metrics collect`: first the page collectors in `metrics[]` (minus keys an API collector now writes), then every social account. Per account:

- A missing credential (no `YOUTUBE_API_KEY`, no Instagram token) is that account's error, with what to do about it. Other accounts still run.
- An API failure is that account's error. What was read before it failed is kept (for example YouTube channel numbers when the uploads call hit the quota).
- Nothing is ever deleted, and a second run on the same day replaces that day's post rows except that an empty number never overwrites a good one. So a failed day leaves the last good reading in place, with its age.
- The run is recorded in `social_metric_status` (last run, last success, last error). Errors and warnings are redacted: no key or token is ever printed, logged or stored.

The command exits 2 when any source failed (the unit treats that as success, so one broken account doesn't mark the timer failed), and prints one line per account, which `journalctl -u secondbrain-metrics` shows. `secondbrain metrics collect --dry-run` reads everything and writes nothing.

## The report

```bash
secondbrain metrics social              # last 7 days
secondbrain metrics social --days 30 --top 20
secondbrain metrics social --json
```

It lists each account's follower (or subscriber) count with its change over the window, the time of its last reading and its age, and `STALE` or `MISSING` with the collector's last error. The total adds only current accounts; if any is stale or missing it says `incomplete` and names what it left out. Top posts are ranked by views gained in the window. The report prints its definitions:

- **followers**: the platform's own count at the last reading; YouTube rounds above 1,000.
- **delta**: the last reading minus the last reading at or before the window start. `from <date>` means the first reading came later, so the change covers less than the window.
- **stale**: the last reading is older than the account's `staleHours`. Stale and missing accounts are never added to the total.
- **views gained**: a post's latest views in the window minus its views on the last day at or before the window start; a post published inside the window counts from 0. Posts with no earlier reading, or no views at all, are counted under the list, never ranked as 0.

## Tables

| Table | What |
|---|---|
| `metric_samples` | Account numbers, one row per reading (unchanged; shared with the brain map) |
| `social_post_stats` | One row per `(platform, external_id, day)`: `account`, `url`, `posted_at`, `kind`, `views`, `likes`, `comments`, `shares`, `saves`, `reach` (NULL = not reported), `social_post_id` (set when the post was published by the `social` module, matched by id or URL), `source`, `raw`, `sampled_at` |
| `social_metric_status` | Per collector: last run, last success, last redacted error, posts written |
| `social_metric_tokens` | Instagram tokens as ciphertext, with expiry, last refresh and last refresh error |

## Not covered

- YouTube watch time and exact subscriber gains (the YouTube Analytics API needs OAuth by the channel owner).
- Instagram personal (non-Professional) accounts, and Stories after they expire.
- X through the official API (paid), and any X post the collector is not given.
- LinkedIn through any API.
