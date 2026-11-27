-- Up Migration
CREATE TABLE hc_enroll (
  code_hash text PRIMARY KEY,
  machine text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL
);
CREATE TABLE hc_tokens (
  token_hash text PRIMARY KEY,
  machine text NOT NULL UNIQUE
);
CREATE TABLE hc_requests (
  id text PRIMARY KEY,
  request_key text NOT NULL UNIQUE,
  command text NOT NULL,
  handler text NOT NULL,
  body_text text NOT NULL,
  state text NOT NULL CHECK (state IN ('queued','reserved','running','succeeded','failed')),
  machine text,
  generation integer NOT NULL DEFAULT 1 CHECK (generation > 0),
  pid integer,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX hc_requests_queue ON hc_requests(command, created_at, id) WHERE state='queued';
CREATE INDEX hc_requests_active ON hc_requests(machine) WHERE state IN ('reserved','running');
-- Down Migration
DROP TABLE hc_requests, hc_tokens, hc_enroll;
