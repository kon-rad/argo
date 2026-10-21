-- Up Migration

-- Per-post daily stats for the networks we post on: one row per post per UTC
-- day holding the latest numbers seen that day. Written by `cli-metrics collect`
-- (YouTube Data API, Instagram API with Instagram Login, fxtwitter). Account
-- totals (followers, subscribers) stay in metric_samples. See
-- docs/social-post-stats.md.
CREATE TABLE social_post_stats (
  platform        text        NOT NULL CHECK (platform IN ('youtube', 'instagram', 'x', 'linkedin')),
  account         text        NOT NULL,          -- handle or channel id
  external_id     text        NOT NULL,          -- video id, IG media id, tweet id
  day             date        NOT NULL,          -- UTC
  url             text,
  posted_at       timestamptz,
  kind            text,                          -- short, video, reel, post
  views           bigint,                        -- null = the platform didn't say; never 0 by default
  likes           bigint,
  comments        bigint,
  shares          bigint,
  saves           bigint,
  reach           bigint,
  watch_seconds   bigint,
  social_post_id  bigint REFERENCES social_posts(id) ON DELETE SET NULL,  -- set when we published it
  source          text        NOT NULL,          -- youtube-data-api, instagram-api, fxtwitter, manual
  raw             jsonb,
  sampled_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (platform, external_id, day)
);
CREATE INDEX social_post_stats_day_idx ON social_post_stats (day DESC);
CREATE INDEX social_post_stats_post_idx ON social_post_stats (social_post_id) WHERE social_post_id IS NOT NULL;

-- A token the app refreshes itself (Instagram's 60-day token). Encrypted with
-- SOCIAL_TOKEN_ENC_KEY; env only seeds the first value.
CREATE TABLE metrics_tokens (
  name        text PRIMARY KEY,
  token       text        NOT NULL,
  expires_at  timestamptz NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Down Migration

DROP TABLE metrics_tokens;
DROP TABLE social_post_stats;
