# Social metrics

Status: **pilot** - collectors, storage and the report are built and tested against fake API answers; no live account has been checked through this code yet.

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

## Unified Login

**Experimental, fixture contract only.** This implementation accepts two token types, chosen by the Meta login configuration:

| Configuration token type | `debug_token` `type` | Stored `token_kind` | How the selected asset is proved | Expiry |
|---|---|---|---|---|
| User access token | `USER` | `facebook-user` | `/me/accounts?fields=id,instagram_business_account` lists the asset through a managed Page | Required; the earlier of `expires_at` and `data_access_expires_at` |
| System-user access token (business integration) | `SYSTEM_USER` | `facebook-system-user` | Both `instagram_basic` and `instagram_manage_insights` in `granular_scopes` list the asset ID in `target_ids`. A grant without `target_ids` is refused | `0` means never (stored as no expiry); any non-zero limit is enforced |

`PAGE`, `APP` and unknown token types are refused. The response shapes above come from Meta's Graph API `debug_token` reference as the maintainers know it; they were **not** re-fetched or exercised against a live authorization when this was written, and the fixtures are fake. Do not assume a configuration ID alone makes an app compatible. On the first live connect, a mismatch fails closed with the generic error and stores nothing; see Recovery.

1. Enable `social` in `MODULES` for onboarding. Enable `map` for the existing daily metrics timer. Both remain optional. Onboarding requires `DEPLOYMENT=server` and a real password/TOTP session; unauthenticated local mode cannot initiate a connection.
2. Set `PUBLIC_ORIGIN` to your exact public HTTPS origin, without a path or trailing slash. Put `FACEBOOK_APP_ID`, `FACEBOOK_APP_SECRET`, `FACEBOOK_LOGIN_CONFIG_ID` and `SOCIAL_TOKEN_ENC_KEY` in the private env file. The configuration ID is sent as `config_id`, not as the app ID. All Facebook settings default to unset.
3. In Meta register the exact redirect `https://brain.example.com/socials/ig/auth/callback`, substituting your configured `PUBLIC_ORIGIN`. This flow ignores `SOCIAL_REDIRECT_BASE_URL`: the same `PUBLIC_ORIGIN` plus fixed callback path is used for both authorization and server-side exchange. Request Host headers never supply the redirect.
4. Configure each intended account in the private `secondbrain.json`:

   ```json
   "socialMetrics": {
     "instagram": [
       { "username": "example.one", "login": "unified", "assetId": "101" },
       { "username": "example.two", "login": "unified", "assetId": "102" }
     ]
   }
   ```

   These IDs are fake. `assetId` is the Instagram Professional account ID, not a Page ID, app ID or username. Account lists default to empty. Existing entries without `login` retain Instagram Login behavior. Restart the server after changing settings.
5. Log in to the app, then open the real connect page at `https://brain.example.com/socials/ig/auth` on your origin. Select one account. The page calls authenticated, same-origin `POST /api/social/instagram/connect` with `{"account":"example.one"}` and navigates to its returned URL. It starts at `https://www.facebook.com/dialog/oauth` with `client_id`, `config_id`, `override_default_response_type=true`, `response_type=code`, `display=popup`, the exact `redirect_uri`, `prompt=login` and a new random `state`. Never paste a literal `<STATE>` into a login URL.
6. Authorize the selected asset in Meta. Connect each intended account separately. An attempt is valid for ten minutes, is bound to the initiating live authenticated session and a scoped HttpOnly, Secure, SameSite=Lax callback cookie, and is consumed once before exchange, including provider-denial returns. The main login cookie remains SameSite=Strict. Starting another attempt in the same browser replaces its callback cookie; finish one at a time. Logging out revokes pending attempts. The callback mounts ahead of SPA fallback and redirects to a clean static completion page. Click Continue there to restore the Strict session cookie on a fresh same-origin navigation.

The server exchanges the code at Facebook Graph `/oauth/access_token`, then uses `/debug_token` (app token in a bearer header) to require a valid app-matching token of a supported type. A `USER` token must expire and carry `instagram_basic`, `instagram_manage_insights`, `pages_show_list` and `pages_read_engagement`, and `/me/accounts?fields=id,instagram_business_account` must show the configured asset through a managed Page. A `SYSTEM_USER` token must carry `instagram_basic` and `instagram_manage_insights` with the configured asset ID in both grants' `target_ids`. In both cases a direct asset lookup must match both its ID and configured username before storage. Unselected or unowned assets are refused, and no other credentials are stored from the response. Each account has its own encrypted row and asset association in `social_metric_tokens`; publishing credentials in `social_accounts` remain separate.

For this supported fixture contract, collection uses `graph.facebook.com/<instagramApiVersion>/<assetId>` for `id,username,followers_count,media_count`, `/<assetId>/media` for posts, and `/<mediaId>/insights` for metrics. Profile/media objects, `data` arrays and insights `values[].value` are the expected shapes. The collector also accepts the existing `total_value.value` insight shape. Facebook tokens use bearer headers. Foreign pagination URLs are refused. This contract needs confirmation against current Meta documentation and a live authorization; it is not a claim of live compatibility.

**Token behavior and recovery.** Unified credentials are typed `facebook-user` or `facebook-system-user` and never go through Instagram's `ig_refresh_token` endpoint. A `facebook-user` credential expires at the earlier token/data-access expiry and is not extended. A `facebook-system-user` credential with `expires_at` 0 has no stored expiry, so it keeps working until it is revoked, the app loses the permission, or the owner removes the asset from the integration; collection then reports the Graph error. Reconnect from the page on expiry, revocation or changed asset selection. If connect fails with the generic error, check in order: the configuration's token type is one of the two above, `instagram_manage_insights` is selected in the configuration, the intended Instagram account was ticked in the dialog, and `assetId`/`username` match that account. `tokenEnv` and the legacy token-seeding CLI are not supported for Unified accounts. Changing the account back to `instagram` fails closed while a Unified token remains stored; explicitly reseed a verified Instagram Login token to switch back. Preserve `SOCIAL_TOKEN_ENC_KEY`; after losing it, restore it or authorize each account again with the replacement key.

**Logging.** Callback errors are generic and never include provider error descriptions, codes or tokens. The shipped Caddy template excludes `/socials/ig/auth/callback` from access logs using `log_skip`. Before live use, apply the reviewed proxy configuration and ensure every other ingress, CDN and tracing layer also omits callback query strings. No production configuration is changed by this feature.

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
| `social_metric_tokens` | Tokens as ciphertext with explicit `token_kind`, per-account `asset_id`, expiry, last refresh and last refresh error |
| `instagram_login_states` | Hashed single-use OAuth state and callback binding, initiating auth session, intended account/asset and exact redirect; expires in ten minutes |

## Not covered

- YouTube watch time and exact subscriber gains (the YouTube Analytics API needs OAuth by the channel owner).
- Instagram personal (non-Professional) accounts, and Stories after they expire.
- X through the official API (paid), and any X post the collector is not given.
- LinkedIn through any API.
