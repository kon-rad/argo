-- Up Migration
-- Capture sender identity at message insertion. Do not backfill historical rows from today's roster.
ALTER TABLE org_messages ADD COLUMN author_kind text CHECK (author_kind IN ('human', 'agent', 'unknown'));
CREATE FUNCTION org_messages_record_sender() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT CASE WHEN runtime = 'human' THEN 'human' ELSE 'agent' END
      INTO NEW.author_kind FROM org_agents WHERE name = NEW.author;
    NEW.author_kind := coalesce(NEW.author_kind, 'unknown');
  ELSIF NEW.author IS DISTINCT FROM OLD.author THEN
    NEW.author_kind := 'unknown';
  ELSE
    NEW.author_kind := OLD.author_kind;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER org_messages_record_sender BEFORE INSERT OR UPDATE ON org_messages
  FOR EACH ROW EXECUTE FUNCTION org_messages_record_sender();

-- Down Migration
DROP TRIGGER org_messages_record_sender ON org_messages;
DROP FUNCTION org_messages_record_sender();
ALTER TABLE org_messages DROP COLUMN author_kind;
