-- Up Migration

-- Per-post checkpoint readings (docs/social-metrics.md, "Checkpoints"): one
-- row per post, checkpoint and metric, taken once each post is 24 hours,
-- 72 hours and 7 days old, so a retro can rank posts at the same age. The
-- daily per-post rows in social_post_stats stay as they are; this table is
-- the fixed-age view on top of them, read straight from the platform's API.
--
-- value NULL means the platform did not say. With error set, the read failed
-- or was refused (no token, missing scope, quota); the hourly run retries a
-- failed checkpoint until the post reaches the next one. Never a stand-in 0.

CREATE TABLE social_post_metrics (
  id              bigserial   PRIMARY KEY,
  -- The piece of content this post carries (a vault draft path or a future
  -- media_pieces id). Free text, no foreign key: nothing in the engine owns
  -- pieces yet. Filled by whoever links posts to pieces; the collector leaves it.
  piece_id        text,
  -- The social module's post, when it published this one (matched by id or URL).
  social_post_id  bigint      REFERENCES social_posts(id) ON DELETE SET NULL,
  platform        text        NOT NULL CHECK (platform IN ('youtube', 'instagram', 'x', 'linkedin')),
  account         text,                          -- as in social_post_stats; NULL when not a configured account
  remote_id       text        NOT NULL,          -- video id, IG media id
  checkpoint      text        NOT NULL CHECK (checkpoint IN ('24h', '72h', '7d')),
  metric          text        NOT NULL,          -- views, likes, comments, shares, saves, reach
  value           bigint,
  posted_at       timestamptz NOT NULL,
  sampled_at      timestamptz NOT NULL,
  source          text        NOT NULL,          -- youtube-data-api, instagram-graph
  error           text,                          -- redacted; never holds a token or key
  UNIQUE (platform, remote_id, checkpoint, metric)
);
CREATE INDEX social_post_metrics_post_idx ON social_post_metrics (social_post_id) WHERE social_post_id IS NOT NULL;
CREATE INDEX social_post_metrics_piece_idx ON social_post_metrics (piece_id) WHERE piece_id IS NOT NULL;
CREATE INDEX social_post_metrics_posted_idx ON social_post_metrics (posted_at DESC);

-- Down Migration

DROP TABLE social_post_metrics;
