-- Up Migration

-- X live broadcasts can't be discovered without a login, so the owner pastes the
-- broadcast link to their agent (skill livestream-x), which registers it
-- here. The livestream timer then reads it every minute from X's public
-- broadcast endpoint until X marks it ended. See server/src/livestream-x.ts.
CREATE TABLE livestream_x_broadcasts (
  broadcast_id    text PRIMARY KEY,             -- the id in x.com/i/broadcasts/<id>
  added_at        timestamptz NOT NULL DEFAULT now(),
  last_state      text,                         -- X's state: NOT_STARTED | RUNNING | ENDED | TIMED_OUT
  last_checked_at timestamptz,
  done_at         timestamptz                   -- set once ended (or given up on); the timer stops polling it
);

-- One row per reminder sent, so a stream gets the "paste the X link" ping once.
CREATE TABLE livestream_notices (
  key             text PRIMARY KEY,
  sent_at         timestamptz NOT NULL DEFAULT now()
);

-- Down Migration

DROP TABLE livestream_notices;
DROP TABLE livestream_x_broadcasts;
