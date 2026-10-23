# Social post stats

Per-post daily numbers (views, likes, comments, shares, saves, reach) for YouTube, Instagram and X, plus API-based account totals. Runs inside the existing daily `cli-metrics collect` (the `secondbrain-metrics` timer). USD 0 a month. The options research and cost comparison live in the owner's vault.

## What it writes

- `social_post_stats` (migration `1756000014500`): one row per `(platform, external_id, UTC day)`, the latest numbers seen that day. A number the platform did not give is `null`, never 0, and a later null never overwrites a known value. `social_post_id` links the row to the `social_posts` row whose `remote_url` equals the stat's URL (posts we published through Buffer).
- `metric_samples`: account totals, as before, through new collect types `youtube-api` (`channelId`) and `instagram-api`.
- `metrics_tokens`: the refreshed Instagram token, encrypted with `SOCIAL_TOKEN_ENC_KEY`.

## Setup (the owner)

Server env file (see the deployment doc), never in notes:

- `YOUTUBE_API_KEY`: Google Cloud project, YouTube Data API v3 enabled, key restricted to that API.
- `INSTAGRAM_ACCESS_TOKEN`: long-lived token for the professional account, from a Meta app with the Instagram API with Instagram Login (scopes `instagram_business_basic`, `instagram_business_manage_insights`). It only seeds the first refresh; after that the app keeps the refreshed token itself and renews it when under 15 days remain.

`secondbrain.json` in the vault:

```json
"postStats": {
  "youtube":   { "channelIds": ["UC..."], "handles": ["yourchannel"] },
  "instagram": true,
  "x":         { "handles": ["youraccount"] }
}
```

Replace an Instagram follower metric that uses the page parser (`"collect": { "type": "instagram" }`, which Instagram's login wall and rate limits break) with `"collect": { "type": "instagram-api" }`; YouTube subscribers can move from the page parser to `{ "type": "youtube-api", "channelId": "UC..." }`.

A network without its key or config is skipped with a reason in the `collect` output; a failing one writes nothing and makes the run exit 2. Error text is scrubbed of keys and tokens.

## Limits

- X: fxtwitter has no stable list endpoint we could confirm, so only posts we published (a `social_posts` row with an x.com status URL, last 30 days) are read. Posts made outside the app are not.
- YouTube: the newest 200 uploads per channel. Subscriber counts above 1,000 are rounded by YouTube.
- Instagram insights ask for `views, reach, saved, shares`; a media type that refuses them keeps the likes and comments from the media list and nulls for the rest.
- LinkedIn: no API; not collected.
- Tests use fixture feeds shaped like the documented responses. No real key has touched the code yet, so field names are unconfirmed against live responses until the first real run.
