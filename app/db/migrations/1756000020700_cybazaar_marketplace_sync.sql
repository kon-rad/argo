CREATE TABLE IF NOT EXISTS desk_cybazaar_requests (
  request_id uuid PRIMARY KEY,
  listing_id uuid NOT NULL,
  title text NOT NULL,
  description text NOT NULL,
  attachment_refs jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(attachment_refs)='array'),
  listing_snapshot jsonb NOT NULL,
  requester_wallet text NOT NULL,
  marketplace_status text NOT NULL CHECK (marketplace_status IN ('submitted','accepted','rejected','in_progress','revision_requested','completed','cancelled')),
  local_status text NOT NULL CHECK (local_status IN ('submitted','accepted','rejected','in_progress','revision_requested','completed','cancelled')),
  provider_summary text,
  kanban_card_id text UNIQUE,
  marketplace_updated_at timestamptz NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS desk_cybazaar_requests_status ON desk_cybazaar_requests(local_status, imported_at DESC);
CREATE TABLE IF NOT EXISTS desk_cybazaar_sync_state (
  integration_id text PRIMARY KEY,
  cursor text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS desk_cybazaar_outbox (
  id bigserial PRIMARY KEY,
  request_id uuid NOT NULL REFERENCES desk_cybazaar_requests(request_id) ON DELETE CASCADE,
  status text NOT NULL,
  summary text,
  idempotency_key text NOT NULL UNIQUE,
  attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz
);
CREATE INDEX IF NOT EXISTS desk_cybazaar_outbox_pending ON desk_cybazaar_outbox(created_at) WHERE delivered_at IS NULL;
REVOKE ALL ON desk_cybazaar_requests,desk_cybazaar_sync_state,desk_cybazaar_outbox FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='sb_app') THEN
    GRANT SELECT,INSERT,UPDATE ON desk_cybazaar_requests,desk_cybazaar_sync_state,desk_cybazaar_outbox TO sb_app;
    GRANT USAGE,SELECT ON SEQUENCE desk_cybazaar_outbox_id_seq TO sb_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='sb_agent') THEN
    REVOKE ALL ON desk_cybazaar_requests,desk_cybazaar_sync_state,desk_cybazaar_outbox FROM sb_agent;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='sb_org') THEN
    REVOKE ALL ON desk_cybazaar_requests,desk_cybazaar_sync_state,desk_cybazaar_outbox FROM sb_org;
  END IF;
END $$;
