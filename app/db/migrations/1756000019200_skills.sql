-- The skills addon (docs/skills.md): operational records only. Skill packages and the assignment
-- policy live in Git; nothing here is a second editable policy. Each row is the latest acknowledgement
-- a machine sent for one agent's generated view, written by POST /api/skills/ack with that machine's
-- device token (ingest_devices), so the host comes from the token, never from the body.

CREATE TABLE skill_view_acks (
  host          text NOT NULL REFERENCES usage_hosts (slug) ON DELETE CASCADE,
  agent         text NOT NULL CHECK (agent ~ '^[a-z0-9][a-z0-9-]{0,31}$'),
  runtime       text NOT NULL CHECK (runtime IN ('zen-agent', 'claude-code', 'hermes', 'codex')),
  status        text NOT NULL CHECK (status IN ('current', 'dirty', 'failed')),
  error         text,
  view_digest   text CHECK (view_digest ~ '^sha256:[0-9a-f]{64}$'),
  policy_digest text CHECK (policy_digest ~ '^sha256:[0-9a-f]{64}$'),
  generated_at  timestamptz,
  received_at   timestamptz NOT NULL DEFAULT now(),
  device_id     bigint REFERENCES ingest_devices (id) ON DELETE SET NULL,
  engine        text,
  -- [{name, id, digest}], [{skill, bins, env}] (names only), [name]
  skills        jsonb NOT NULL DEFAULT '[]',
  missing       jsonb NOT NULL DEFAULT '[]',
  dirty         jsonb NOT NULL DEFAULT '[]',
  PRIMARY KEY (host, agent, runtime)
);

-- One line per acknowledgement received, for "last seen" and a short audit trail. Bounded by the route
-- (it keeps the newest 200 per host).
CREATE TABLE skill_ack_log (
  id          bigserial PRIMARY KEY,
  host        text NOT NULL REFERENCES usage_hosts (slug) ON DELETE CASCADE,
  received_at timestamptz NOT NULL DEFAULT now(),
  views       integer NOT NULL,
  failed      integer NOT NULL,
  dirty       integer NOT NULL,
  policy_digest text
);
CREATE INDEX skill_ack_log_host_idx ON skill_ack_log (host, received_at DESC);
