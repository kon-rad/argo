-- Up Migration

-- Model routing log (design: Areas/argo/second-brain/agent-company/org-config-and-model-routing-design.md).
-- Every routing decision is a row; the outcome joins it so the weekly report can show escalation rate and cost per
-- merged PR by tier. config_applies is the audit trail for `cli-org apply` (a later phase writes it).

CREATE TABLE IF NOT EXISTS route_decisions (
  id         bigserial PRIMARY KEY,
  run_id     text,                       -- joins usage_runs.run_id when the run is known
  card_id    text,
  agent      text NOT NULL,
  action     text NOT NULL CHECK (action IN ('run', 'ask-spec', 'park', 'wait', 'blocked')),
  signals    jsonb NOT NULL DEFAULT '{}'::jsonb,
  tier       text CHECK (tier IN ('t0', 't1', 't2', 't3')),
  model      text,
  reason     text NOT NULL,
  budget     jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS route_decisions_card_idx ON route_decisions (card_id);
CREATE INDEX IF NOT EXISTS route_decisions_created_idx ON route_decisions (created_at DESC);

CREATE TABLE IF NOT EXISTS route_outcomes (
  decision_id    bigint PRIMARY KEY REFERENCES route_decisions (id) ON DELETE CASCADE,
  result         text NOT NULL CHECK (result IN ('merged', 'rejected', 'parked', 'blocked', 'done', 'failed')),
  turns          integer,
  tokens         bigint,
  cost_usd       numeric(12, 4),
  escalated_from text CHECK (escalated_from IN ('t0', 't1', 't2', 't3')),
  verified       boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS config_applies (
  id         bigserial PRIMARY KEY,
  git_sha    text,
  plan       jsonb NOT NULL DEFAULT '{}'::jsonb,
  applied_by text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);
