-- Up Migration

-- Livestream viewers and hours, for a public livestream page (livestream
-- module). On the server a systemd timer runs `cli-livestream.js` every
-- minute: it reads the public YouTube /live page (no API key), appends one
-- sample while the channel is live, and keeps one session row per broadcast.
-- It then writes the public summary JSON that Caddy serves at
-- /public/livestream.json.

-- One row per broadcast. Collector sessions run from the first sample that saw
-- the stream live to the last one (ended_at stays NULL while it is live).
-- Manual rows cover streams the collector never saw (e.g. before it existed).
CREATE TABLE livestream_sessions (
  id              bigserial PRIMARY KEY,
  platform        text NOT NULL,                -- 'youtube' (later: 'x', 'twitch', 'kick')
  video_id        text,                         -- the platform's broadcast id; NULL for manual rows
  title           text,
  started_at      timestamptz NOT NULL,
  last_seen_at    timestamptz NOT NULL,
  ended_at        timestamptz,
  peak_viewers    integer,
  source          text NOT NULL DEFAULT 'collector' CHECK (source IN ('collector', 'manual')),
  note            text,
  UNIQUE (platform, video_id)
);
CREATE INDEX livestream_sessions_started_idx ON livestream_sessions (started_at DESC);

-- Concurrent viewers, one sample per platform per poll, only while live.
CREATE TABLE livestream_viewer_samples (
  platform        text NOT NULL,
  ts              timestamptz NOT NULL,
  video_id        text NOT NULL,
  viewers         integer NOT NULL,
  PRIMARY KEY (platform, ts)
);
CREATE INDEX livestream_samples_video_idx ON livestream_viewer_samples (platform, video_id, ts);

-- Down Migration

DROP TABLE livestream_viewer_samples;
DROP TABLE livestream_sessions;
