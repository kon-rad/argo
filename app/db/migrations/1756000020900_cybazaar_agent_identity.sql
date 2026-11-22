-- Immutable Cybazaar agent identity and the trusted local assignee for imported service requests.
-- agent_id is the Cybazaar agent UUID reported with the request (NULL until Cybazaar supplies it).
-- assigned_agent is the local org agent resolved from CYBAZAAR_AGENT_MAP when the owner accepts.
-- identity_conflict is set when a later poll reports a different listing, agent or requester.
ALTER TABLE desk_cybazaar_requests
  ADD COLUMN IF NOT EXISTS agent_id uuid,
  ADD COLUMN IF NOT EXISTS assigned_agent text CHECK (assigned_agent ~ '^[a-z0-9][a-z0-9-]{0,31}$'),
  ADD COLUMN IF NOT EXISTS identity_conflict boolean NOT NULL DEFAULT false;

-- Defence in depth: the connector never rewrites identity, and the database refuses it too.
CREATE OR REPLACE FUNCTION desk_cybazaar_requests_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.request_id IS DISTINCT FROM OLD.request_id
     OR NEW.listing_id IS DISTINCT FROM OLD.listing_id
     OR lower(NEW.requester_wallet) IS DISTINCT FROM lower(OLD.requester_wallet)
     OR (OLD.agent_id IS NOT NULL AND NEW.agent_id IS DISTINCT FROM OLD.agent_id)
     OR (OLD.assigned_agent IS NOT NULL AND NEW.assigned_agent IS DISTINCT FROM OLD.assigned_agent)
     OR (OLD.kanban_card_id IS NOT NULL AND NEW.kanban_card_id IS DISTINCT FROM OLD.kanban_card_id) THEN
    RAISE EXCEPTION 'Cybazaar request % identity is immutable', OLD.request_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS desk_cybazaar_requests_identity_guard ON desk_cybazaar_requests;
CREATE TRIGGER desk_cybazaar_requests_identity_guard BEFORE UPDATE ON desk_cybazaar_requests
  FOR EACH ROW EXECUTE FUNCTION desk_cybazaar_requests_identity_guard();
