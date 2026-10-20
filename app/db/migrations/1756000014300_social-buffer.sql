-- Up Migration

-- Buffer as a relay for the social module: Instagram, YouTube Shorts and X go
-- out through the owner's Buffer account (its GraphQL API, a personal key in
-- env), LinkedIn stays direct. See Projects/secondbrain-app/social-buffer-plan.md
-- in the vault.

-- How an account publishes. 'direct': its own provider's API (LinkedIn).
-- 'buffer': provider is still the real network, provider_account_id is the
-- Buffer channel id, and the tokens columns hold a placeholder (the key is env).
ALTER TABLE social_accounts
  ADD COLUMN transport text NOT NULL DEFAULT 'direct' CHECK (transport IN ('direct', 'buffer'));

-- 'draft': written by an agent, waiting for the owner's approval; the timer
-- never publishes it. `cli-social approve` moves it to 'queued'.
ALTER TABLE social_posts DROP CONSTRAINT social_posts_status_check;
ALTER TABLE social_posts ADD CONSTRAINT social_posts_status_check
  CHECK (status IN ('draft', 'queued', 'publishing', 'posted', 'failed', 'canceled'));

-- Per-network settings: Instagram post type, YouTube title and category, the
-- rest of an X thread. Validated by the app per network, not here.
ALTER TABLE social_posts
  ADD COLUMN options jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(options) = 'object');

-- When a relay accepted the post. remote_id then holds the relay's post id and
-- the row stays 'publishing' until the relay reports it sent (or failed).
ALTER TABLE social_posts ADD COLUMN handed_off_at timestamptz;

-- Videos (reels and Shorts). Still bytes in Postgres, so a post can be queued
-- from any machine that reaches the database; capped at 200 MB and dropped
-- once the post is out (purged_at), so the table and its nightly dump stay small.
ALTER TABLE social_post_media DROP CONSTRAINT social_post_media_content_type_check;
ALTER TABLE social_post_media ADD CONSTRAINT social_post_media_content_type_check
  CHECK (content_type IN ('image/jpeg', 'image/png', 'image/gif', 'video/mp4', 'video/quicktime'));
ALTER TABLE social_post_media DROP CONSTRAINT social_post_media_bytes_check;
ALTER TABLE social_post_media ALTER COLUMN bytes DROP NOT NULL;
ALTER TABLE social_post_media ADD COLUMN purged_at timestamptz;
ALTER TABLE social_post_media ADD CONSTRAINT social_post_media_bytes_check CHECK (
  CASE WHEN content_type LIKE 'video/%' THEN octet_length(bytes) BETWEEN 1 AND 209715200
       ELSE octet_length(bytes) BETWEEN 1 AND 5242880 END
);
ALTER TABLE social_post_media ADD CONSTRAINT social_post_media_bytes_present_check
  CHECK (bytes IS NOT NULL OR purged_at IS NOT NULL);
-- Networks take no alt text on a video.
ALTER TABLE social_post_media DROP CONSTRAINT social_post_media_alt_text_check;
ALTER TABLE social_post_media ADD CONSTRAINT social_post_media_alt_text_check
  CHECK (length(alt_text) <= 1000 AND (content_type LIKE 'video/%' OR length(alt_text) >= 1));

-- The relay fetches media from a public URL (it has no upload). The token is
-- the unguessable part of that URL; the route serves it only while the post is
-- 'publishing'.
ALTER TABLE social_post_media ADD COLUMN public_token text UNIQUE;

-- Down Migration

DELETE FROM social_post_media WHERE bytes IS NULL OR content_type LIKE 'video/%';
ALTER TABLE social_post_media DROP COLUMN public_token;
ALTER TABLE social_post_media DROP CONSTRAINT social_post_media_alt_text_check;
ALTER TABLE social_post_media ADD CONSTRAINT social_post_media_alt_text_check CHECK (length(alt_text) BETWEEN 1 AND 1000);
ALTER TABLE social_post_media DROP CONSTRAINT social_post_media_bytes_present_check;
ALTER TABLE social_post_media DROP CONSTRAINT social_post_media_bytes_check;
ALTER TABLE social_post_media DROP COLUMN purged_at;
ALTER TABLE social_post_media ALTER COLUMN bytes SET NOT NULL;
ALTER TABLE social_post_media ADD CONSTRAINT social_post_media_bytes_check CHECK (octet_length(bytes) BETWEEN 1 AND 5242880);
ALTER TABLE social_post_media DROP CONSTRAINT social_post_media_content_type_check;
ALTER TABLE social_post_media ADD CONSTRAINT social_post_media_content_type_check
  CHECK (content_type IN ('image/jpeg', 'image/png', 'image/gif'));
ALTER TABLE social_posts DROP COLUMN handed_off_at;
ALTER TABLE social_posts DROP COLUMN options;
UPDATE social_posts SET status = 'canceled' WHERE status = 'draft';
ALTER TABLE social_posts DROP CONSTRAINT social_posts_status_check;
ALTER TABLE social_posts ADD CONSTRAINT social_posts_status_check
  CHECK (status IN ('queued', 'publishing', 'posted', 'failed', 'canceled'));
ALTER TABLE social_accounts DROP COLUMN transport;
