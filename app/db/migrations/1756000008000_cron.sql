-- Up Migration

-- Hermes cron jobs, their runs and their outputs, copied from each Hermes
-- home (the main one and every profile) by `secondbrain agents-sync`, which a
-- systemd timer runs on the droplet. Hermes prunes and rewrites its own files;
-- these rows are the durable history. Chat transcripts (Telegram, cron runs,
-- subagents) go to archive_sessions / archive_messages, like the agent archive.

CREATE TABLE cron_jobs (
  profile         text NOT NULL,          -- 'main' or the Hermes profile name
  job_id          text NOT NULL,
  name            text NOT NULL,
  schedule        text,                   -- Hermes's display form, e.g. '40 6 * * *'
  state           text,                   -- scheduled | paused | completed | …
  enabled         boolean NOT NULL DEFAULT true,
  next_run_at     timestamptz,
  last_run_at     timestamptz,
  last_status     text,
  last_error      text,
  deliver         text,
  skill           text,
  script          text,
  prompt          text,
  timezone        text,                   -- Hermes's configured zone when last synced
  raw             jsonb NOT NULL,
  first_seen_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  removed_at      timestamptz,            -- set when the job disappears from jobs.json
  PRIMARY KEY (profile, job_id)
);

CREATE TABLE cron_runs (
  profile         text NOT NULL,
  id              text NOT NULL,          -- executions.id
  job_id          text NOT NULL,
  status          text NOT NULL,
  claimed_at      timestamptz,
  started_at      timestamptz,
  finished_at     timestamptz,
  error           text,
  raw             jsonb NOT NULL,
  PRIMARY KEY (profile, id)
);
CREATE INDEX cron_runs_job_idx ON cron_runs (profile, job_id, started_at DESC);

-- One file per run under cron/output/<job_id>/<local time>.md: what the job produced.
CREATE TABLE cron_outputs (
  profile         text NOT NULL,
  job_id          text NOT NULL,
  file_name       text NOT NULL,
  run_at          timestamptz,            -- parsed from the file name in Hermes's timezone
  content         text NOT NULL,
  content_sha     text NOT NULL,
  synced_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (profile, job_id, file_name)
);
CREATE INDEX cron_outputs_job_idx ON cron_outputs (profile, job_id, run_at DESC);

-- One row per `secondbrain agents-sync` run, so the pages can say how fresh they are.
CREATE TABLE agents_sync_runs (
  id        bigserial PRIMARY KEY,
  ran_at    timestamptz NOT NULL DEFAULT now(),
  host      text NOT NULL,
  counts    jsonb NOT NULL
);

-- Down Migration

DROP TABLE agents_sync_runs;

DROP TABLE cron_outputs;
DROP TABLE cron_runs;
DROP TABLE cron_jobs;
