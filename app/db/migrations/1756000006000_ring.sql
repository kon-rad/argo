-- Up Migration

-- Ultrahuman ring data from the cyberdeck Pi. On the droplet, ring-ingest
-- (ops/ring-ingest/ring_ingest.py) creates and fills these
-- same tables from the Pi's hourly push; IF NOT EXISTS lets this migration run
-- there after it. On the Mac they are a mirror, replaced wholesale by
-- `secondbrain ring-pull` from the droplet. Keep the columns identical to
-- ring_ingest.py's SCHEMA: the pull copies rows by column name.
CREATE TABLE IF NOT EXISTS ring_raw (
  day DATE PRIMARY KEY, payload JSONB NOT NULL, payload_sha256 TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(), changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ring_daily (
  day DATE PRIMARY KEY,
  sleep_score INTEGER, total_sleep_min INTEGER, time_in_bed_min INTEGER,
  deep_min INTEGER, rem_min INTEGER, light_min INTEGER, awake_min INTEGER,
  sleep_efficiency_pct REAL, restorative_pct REAL, temp_deviation_c REAL,
  avg_body_temp_c REAL, spo2_pct REAL, tosses_turns INTEGER, full_cycles INTEGER,
  bedtime_start BIGINT, bedtime_end BIGINT, morning_alertness_min INTEGER,
  steps_total REAL, hrv_avg REAL, hr_last REAL, sleep_hrv REAL, sleep_rhr REAL,
  recovery_index REAL, movement_index REAL, active_min REAL, inactive_min REAL,
  vo2_max REAL
);
CREATE TABLE IF NOT EXISTS ring_samples (
  metric TEXT NOT NULL, ts BIGINT NOT NULL, day DATE NOT NULL, value REAL,
  PRIMARY KEY (metric, ts)
);
CREATE INDEX IF NOT EXISTS ring_samples_day ON ring_samples(day);
CREATE TABLE IF NOT EXISTS ring_sleep_stages (
  day DATE NOT NULL, start BIGINT NOT NULL, "end" BIGINT NOT NULL, stage TEXT NOT NULL,
  PRIMARY KEY (day, start)
);

-- Down Migration

DROP TABLE IF EXISTS ring_sleep_stages;
DROP TABLE IF EXISTS ring_samples;
DROP TABLE IF EXISTS ring_daily;
DROP TABLE IF EXISTS ring_raw;
