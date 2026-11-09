-- Up Migration

-- Social metrics (docs/social-metrics.md). Account-level numbers (followers,
-- subscribers, channel views) keep going into metric_samples under their
-- existing keys, so the brain map needs no change. Per-post numbers get one
-- row per post per UTC day: the collector upserts, so a second run on the same
-- day replaces that day's row instead of adding one.

CREATE TABLE social_post_stats (
  platform        text        NOT NULL CHECK (platform IN ('youtube', 'instagram', 'x', 'linkedin')),
  account         text        NOT NULL,          -- channel id, username or handle as configured
  external_id     text        NOT NULL,          -- video id, IG media id, X status id, LinkedIn activity id
  day             date        NOT NULL,          -- UTC day of the reading
  url             text,
  posted_at       timestamptz,
  kind            text,                          -- video, reel, image, carousel, post
  -- NULL = the platform did not say (hidden, unsupported, or the call failed); never a stand-in 0.
  views           bigint,
  likes           bigint,
  comments        bigint,
  shares          bigint,
  saves           bigint,
  reach           bigint,
  -- Set when the post is one the social module published (matched by id or URL).
  social_post_id  bigint      REFERENCES social_posts(id) ON DELETE SET NULL,
  source          text        NOT NULL,          -- youtube-data-api, instagram-graph, fxtwitter, manual
  raw             jsonb,
  sampled_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (platform, external_id, day)
);
CREATE INDEX social_post_stats_account_idx ON social_post_stats (platform, account, day DESC);
CREATE INDEX social_post_stats_post_idx ON social_post_stats (social_post_id) WHERE social_post_id IS NOT NULL;

-- The last run of each social collector, so a report can say which numbers
-- are stale and why. last_ok_at survives a failure: the last good reading
-- stays visible with its age.
CREATE TABLE social_metric_status (
  collector       text        PRIMARY KEY,       -- '<platform>:<metric key prefix>'
  platform        text        NOT NULL,
  account         text        NOT NULL,
  last_run_at     timestamptz NOT NULL,
  last_ok_at      timestamptz,
  last_error      text,                          -- redacted; never holds a token or key
  last_error_at   timestamptz,
  posts_written   integer
);

-- Long-lived tokens the collectors refresh themselves (Instagram API with
-- Instagram Login). Ciphertext from social/crypto.ts (SOCIAL_TOKEN_ENC_KEY),
-- never a plaintext token. Separate from social_accounts so a metrics token
-- never shows up as an account the publisher could post to.
CREATE TABLE social_metric_tokens (
  platform        text        NOT NULL CHECK (platform IN ('instagram')),
  account         text        NOT NULL,          -- lower-case username
  access_token    text        NOT NULL,
  expires_at      timestamptz,                   -- NULL until the first refresh tells us
  refreshed_at    timestamptz NOT NULL DEFAULT now(),
  last_error      text,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (platform, account)
);

-- Down Migration

DROP TABLE social_metric_tokens;
DROP TABLE social_metric_status;
DROP TABLE social_post_stats;
