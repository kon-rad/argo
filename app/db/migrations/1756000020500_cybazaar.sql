-- Separate server-attested marketplace authority. Legacy desk/v1 tables stay unchanged.
CREATE TABLE cyba_profiles (
  id text PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 100),
  name text NOT NULL, service_title text NOT NULL, description text NOT NULL,
  price_atomic numeric(78,0) NOT NULL CHECK (price_atomic > 0 AND price_atomic < 115792089237316195423570985008687907853269984665640564039457584007913129639936),
  payout_wallet text NOT NULL CHECK (payout_wallet ~ '^0x[0-9a-f]{40}$'),
  ens_name text NOT NULL, agent_id text NOT NULL,
  identity_bound boolean NOT NULL DEFAULT false
);
CREATE TABLE cyba_jobs (
  id text PRIMARY KEY, client_wallet text NOT NULL CHECK (client_wallet ~ '^0x[0-9a-f]{40}$'),
  provider_id text NOT NULL REFERENCES cyba_profiles(id), title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  brief text NOT NULL CHECK (length(brief) BETWEEN 1 AND 10000), request_key text NOT NULL UNIQUE,
  price_atomic numeric(78,0) NOT NULL CHECK (price_atomic > 0 AND price_atomic < 115792089237316195423570985008687907853269984665640564039457584007913129639936),
  recipient text NOT NULL CHECK (recipient ~ '^0x[0-9a-f]{40}$'), chain_id integer NOT NULL CHECK (chain_id=8453),
  token_address text NOT NULL CHECK (token_address ~ '^0x[0-9a-f]{40}$'),
  status text NOT NULL CHECK (status IN ('triage','active','review','released','paid','cancelled')),
  card_id text UNIQUE, artifact_sha256 text CHECK (artifact_sha256 ~ '^[0-9a-f]{64}$'),
  artifact_path text, summary text, pending_payment_tx text CHECK (pending_payment_tx ~ '^0x[0-9a-f]{64}$'), payment_tx text UNIQUE CHECK (payment_tx ~ '^0x[0-9a-f]{64}$'),
  upload_state text NOT NULL DEFAULT 'not-started' CHECK (upload_state IN ('not-started','uploading','uploaded')),
  swarm_ref text CHECK (swarm_ref ~ '^swarm://[0-9a-f]{64}$'), released_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status NOT IN ('released','paid') OR (artifact_sha256 IS NOT NULL AND artifact_path IS NOT NULL AND summary IS NOT NULL AND released_at IS NOT NULL)),
  CHECK (status <> 'paid' OR (payment_tx IS NOT NULL AND swarm_ref IS NOT NULL)),
  CHECK (swarm_ref IS NULL OR payment_tx IS NOT NULL),
  CHECK (payment_tx IS NULL OR status IN ('released','paid'))
);
CREATE INDEX cyba_jobs_client ON cyba_jobs(client_wallet,created_at DESC);
CREATE TABLE cyba_publications (
  id text PRIMARY KEY, job_id text NOT NULL REFERENCES cyba_jobs(id), kind text NOT NULL,
  idempotency_key text NOT NULL UNIQUE, payload jsonb NOT NULL,
  event_digest text, lease_until timestamptz, write_started boolean NOT NULL DEFAULT false,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','confirmed')), reference text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (state <> 'confirmed' OR reference IS NOT NULL)
);
CREATE INDEX cyba_publications_pending ON cyba_publications(job_id,state,created_at);
REVOKE ALL ON cyba_profiles,cyba_jobs,cyba_publications FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='sb_app') THEN
    GRANT SELECT,INSERT,UPDATE ON cyba_profiles,cyba_jobs,cyba_publications TO sb_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='sb_agent') THEN
    REVOKE ALL ON cyba_profiles,cyba_jobs,cyba_publications FROM sb_agent;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='sb_org') THEN
    REVOKE ALL ON cyba_profiles,cyba_jobs,cyba_publications FROM sb_org;
  END IF;
END $$;
