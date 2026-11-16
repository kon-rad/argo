-- Up Migration

-- Newsroom records. Prose and media remain in the vault; these rows track a
-- story, its derived pieces, measurements, checks, and evidence-led changes.
-- Apply after board.sql and social.sql so card and social post references exist.
-- No existing rows are rewritten. Rollback drops only these five new tables.

CREATE TABLE media_stories (
  id            bigserial PRIMARY KEY,
  day           date NOT NULL,
  source        text NOT NULL CHECK (source IN ('digest', 'konrad')),
  card_id       text REFERENCES cards(id) ON DELETE SET NULL,
  title         text NOT NULL CHECK (length(trim(title)) > 0),
  url           text,
  primary_url   text,
  category      text,
  score         numeric,
  priority      smallint CHECK (priority BETWEEN 1 AND 5),
  status        text NOT NULL DEFAULT 'candidate' CHECK (status IN
                ('candidate', 'picked', 'researched', 'drafted', 'approved', 'published', 'dropped')),
  research_path text,
  post_path     text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX media_stories_day_status_idx ON media_stories (day DESC, status);
CREATE INDEX media_stories_card_idx ON media_stories (card_id) WHERE card_id IS NOT NULL;

CREATE TABLE media_pieces (
  id               bigserial PRIMARY KEY,
  story_id         bigint NOT NULL REFERENCES media_stories(id) ON DELETE CASCADE,
  format           text NOT NULL CHECK (format IN ('blog', 'linkedin', 'x_thread', 'reel', 'youtube')),
  bot              text REFERENCES org_agents(name) ON UPDATE CASCADE ON DELETE SET NULL,
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN
                   ('draft', 'review', 'approved', 'queued', 'published', 'failed', 'dropped')),
  draft_path       text,
  published_url    text,
  social_post_id   bigint REFERENCES social_posts(id) ON DELETE SET NULL,
  run_ids          text[] NOT NULL DEFAULT '{}',
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (story_id, format)
);
CREATE INDEX media_pieces_social_post_idx ON media_pieces (social_post_id) WHERE social_post_id IS NOT NULL;

CREATE TABLE social_metrics (
  id             bigserial PRIMARY KEY,
  piece_id       bigint NOT NULL REFERENCES media_pieces(id) ON DELETE CASCADE,
  social_post_id bigint REFERENCES social_posts(id) ON DELETE SET NULL,
  platform       text NOT NULL,
  remote_id      text NOT NULL,
  metric         text NOT NULL CHECK (metric IN
                 ('views', 'likes', 'comments', 'shares', 'saves', 'watch_time_s',
                  'avg_view_pct', 'clicks', 'follows')),
  value          numeric NOT NULL CHECK (value >= 0),
  sampled_at     timestamptz NOT NULL,
  UNIQUE (piece_id, platform, remote_id, metric, sampled_at)
);
CREATE INDEX social_metrics_piece_sampled_idx ON social_metrics (piece_id, sampled_at DESC);

CREATE TABLE media_checks (
  id        bigserial PRIMARY KEY,
  piece_id  bigint NOT NULL REFERENCES media_pieces(id) ON DELETE CASCADE,
  run_day   date NOT NULL,
  "check"   text NOT NULL CHECK ("check" IN
            ('format', 'loudness', 'dead_frames', 'silence', 'caption_drift', 'visual_errors')),
  pass      boolean NOT NULL,
  detail    text,
  checked_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX media_checks_piece_day_idx ON media_checks (piece_id, run_day DESC);

CREATE TABLE media_changes (
  id          bigserial PRIMARY KEY,
  run_day     date NOT NULL,
  target      text NOT NULL CHECK (length(trim(target)) > 0),
  change      text NOT NULL CHECK (length(trim(change)) > 0),
  evidence    jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evidence) = 'object'),
  commit_sha  text CHECK (commit_sha IS NULL OR commit_sha ~ '^[0-9a-f]{7,40}$'),
  status      text NOT NULL DEFAULT 'proposed' CHECK (status IN ('applied', 'carded', 'proposed', 'reverted')),
  card_id     text REFERENCES cards(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX media_changes_day_idx ON media_changes (run_day DESC);

-- Down Migration

DROP TABLE media_changes;
DROP TABLE media_checks;
DROP TABLE social_metrics;
DROP TABLE media_pieces;
DROP TABLE media_stories;
