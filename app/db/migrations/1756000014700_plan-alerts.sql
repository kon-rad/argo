-- Up Migration

-- One row per plan-percent alert already sent: the window (five_hour or
-- seven_day), the threshold crossed (60, 80, 90) and which window instance it
-- was (resets_at changes when the window rolls over, so a new window alerts
-- again). The primary key is the dedupe: a crossing is claimed by inserting its
-- row, and only the insert that wins sends the message.
CREATE TABLE plan_alerts (
  "window"    text        NOT NULL CHECK ("window" IN ('five_hour', 'seven_day')),
  threshold   smallint    NOT NULL CHECK (threshold BETWEEN 1 AND 100),
  resets_at   timestamptz NOT NULL,
  used_pct    real        NOT NULL,                 -- the reading that crossed it
  sent_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("window", threshold, resets_at)
);

-- Down Migration

DROP TABLE plan_alerts;
