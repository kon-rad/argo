-- Up Migration

-- The media schedule page links each post to the kanban card behind it and to
-- the draft file it came from. Both are optional: older posts have neither.
ALTER TABLE social_posts
  ADD COLUMN card_id     text CHECK (card_id ~ '^t_[0-9a-f]{6,32}$'),
  ADD COLUMN source_path text;                 -- vault path of the draft file

CREATE INDEX social_posts_card_idx ON social_posts (card_id) WHERE card_id IS NOT NULL;
-- The calendar reads posts by account and date range.
CREATE INDEX social_posts_account_time_idx ON social_posts (account_id, scheduled_for);

-- Down Migration

DROP INDEX social_posts_account_time_idx;
DROP INDEX social_posts_card_idx;
ALTER TABLE social_posts DROP COLUMN source_path, DROP COLUMN card_id;
