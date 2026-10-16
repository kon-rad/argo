-- Up Migration

-- Project tracker: teams, projects, features, their stage history and the
-- verifications that prove a feature works. Design:
-- Projects/secondbrain-app/project-tracker-design.md.
--
-- Records live here; prose stays in markdown. A project row points at its
-- dev-log README (Resume block, next action) and design doc by vault path.
-- Goals stay in CURRENT/goals-master.md: rows only carry the goal codes
-- (W1, M2, Q1, Y3), and the report reads the goals file for their text.
--
-- Numbered 11500 so the unmerged usage-ledger migration (12000) still sorts
-- after it when that branch lands.

CREATE TABLE teams (
  slug        text PRIMARY KEY CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,47}$'),
  name        text NOT NULL,
  mission     text,
  lead        text,                                  -- 'owner', 'claude-code', 'hermes'
  members     text[] NOT NULL DEFAULT '{}',
  sort        integer NOT NULL DEFAULT 0,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- One list for projects and features. 'idea' is the backlog.
CREATE TABLE projects (
  slug          text PRIMARY KEY CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  title         text NOT NULL,
  team_slug     text REFERENCES teams(slug) ON UPDATE CASCADE ON DELETE SET NULL,
  area          text,
  stage         text NOT NULL CHECK (stage IN ('idea','designing','building','testing','live','parked','done')),
  health        text CHECK (health IN ('green','yellow','red')),
  priority      smallint CHECK (priority > 0),
  goals         text[] NOT NULL DEFAULT '{}',
  needs_owner   text,
  blocked_on    text,
  started       date,
  due           date,
  devlog_path   text,
  design_path   text,
  paths         text[] NOT NULL DEFAULT '{}',
  repos         text[] NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    text
);

CREATE TABLE features (
  id            bigserial PRIMARY KEY,
  project_slug  text NOT NULL REFERENCES projects(slug) ON UPDATE CASCADE ON DELETE CASCADE,
  slug          text NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  title         text NOT NULL,
  stage         text NOT NULL DEFAULT 'idea' CHECK (stage IN ('idea','designing','building','testing','live','parked','done')),
  health        text CHECK (health IN ('green','yellow','red')),
  owner         text,                                -- who is building it: 'claude-code', 'hermes', 'owner'
  goals         text[] NOT NULL DEFAULT '{}',
  needs_owner   text,
  blocked_on    text,
  started       date,
  due           date,
  shipped_at    date,                                -- set when it first reaches live
  notes_path    text,
  sort          integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    text,
  UNIQUE (project_slug, slug)
);
CREATE INDEX features_stage_idx ON features (stage);

-- Append-only. Written in the same transaction as every stage change, so
-- "days in stage" and "what moved this week" come from here.
CREATE TABLE stage_changes (
  id            bigserial PRIMARY KEY,
  project_slug  text NOT NULL REFERENCES projects(slug) ON UPDATE CASCADE ON DELETE CASCADE,
  feature_id    bigint REFERENCES features(id) ON DELETE CASCADE,   -- NULL = the project itself
  from_stage    text,
  to_stage      text NOT NULL,
  at            timestamptz NOT NULL DEFAULT now(),
  by            text,
  note          text
);
CREATE INDEX stage_changes_at_idx ON stage_changes (at DESC);
CREATE INDEX stage_changes_feature_idx ON stage_changes (feature_id, at DESC);

-- Evidence that a feature works. A feature can only move to live or done when
-- its newest verification passed (or the move records why it skipped that).
CREATE TABLE verifications (
  id          bigserial PRIMARY KEY,
  feature_id  bigint NOT NULL REFERENCES features(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('test','manual','deploy','review','metric')),
  check_run   text NOT NULL,                         -- what was run or looked at: 'npx vitest run', 'opened /projects on the droplet'
  result      text NOT NULL CHECK (result IN ('pass','fail')),
  evidence    text,                                  -- output excerpt, counts, or a vault path
  at          timestamptz NOT NULL DEFAULT now(),
  by          text
);
CREATE INDEX verifications_feature_idx ON verifications (feature_id, at DESC);

-- Down Migration

DROP TABLE verifications;
DROP TABLE stage_changes;
DROP TABLE features;
DROP TABLE projects;
DROP TABLE teams;
