-- Up Migration

-- Images on social posts. The bytes live in Postgres, not on disk, so a post
-- can be queued from any machine that reaches the database (the droplet, or a
-- laptop over Tailscale) and the scheduler on the server always has the file.
-- Sized for a handful of posts a day: 5 MB per image, a few images per post.
-- Replaces social_posts.media_paths, which publish() never supported.

CREATE TABLE social_post_media (
  id            bigserial PRIMARY KEY,
  post_id       bigint NOT NULL REFERENCES social_posts(id) ON DELETE CASCADE,
  position      int NOT NULL CHECK (position >= 0),
  filename      text NOT NULL,
  content_type  text NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/gif')),
  bytes         bytea NOT NULL CHECK (octet_length(bytes) BETWEEN 1 AND 5242880),
  alt_text      text NOT NULL CHECK (length(alt_text) BETWEEN 1 AND 1000),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (post_id, position)
);

ALTER TABLE social_posts DROP COLUMN media_paths;

-- When a publish attempt began: a row left in 'publishing' (the run was killed
-- mid-upload) is moved to 'failed' after 15 minutes, never back to 'queued',
-- because LinkedIn may already have the post.
ALTER TABLE social_posts ADD COLUMN publishing_started_at timestamptz;

-- Down Migration

ALTER TABLE social_posts DROP COLUMN publishing_started_at;
ALTER TABLE social_posts ADD COLUMN media_paths text[] NOT NULL DEFAULT '{}';
DROP TABLE social_post_media;
