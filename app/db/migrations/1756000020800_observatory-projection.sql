-- Up Migration
ALTER TABLE archive_messages ADD COLUMN observatory_projection jsonb;
CREATE INDEX archive_messages_observatory_missing_idx ON archive_messages(session_id, id) WHERE observatory_projection IS NULL;
CREATE INDEX archive_messages_session_time_idx ON archive_messages(session_id, ts);
CREATE INDEX archive_messages_observatory_tools_idx ON archive_messages(session_id, seq, id)
WHERE observatory_projection->'parts' @> '[{"step":"tool_call"}]'::jsonb
   OR observatory_projection->'parts' @> '[{"step":"tool_result"}]'::jsonb;
-- Any source rewrite queues a rebuild. Readers fail explicitly until it completes.
CREATE FUNCTION invalidate_observatory_projection() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.raw, NEW.role, NEW.kind, NEW.content_text) IS DISTINCT FROM (OLD.raw, OLD.role, OLD.kind, OLD.content_text) THEN
    NEW.observatory_projection := NULL;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER archive_observatory_invalidate BEFORE UPDATE ON archive_messages
FOR EACH ROW EXECUTE FUNCTION invalidate_observatory_projection();

-- Down Migration
DROP TRIGGER archive_observatory_invalidate ON archive_messages;
DROP FUNCTION invalidate_observatory_projection();
DROP INDEX archive_messages_observatory_tools_idx;
DROP INDEX archive_messages_session_time_idx;
DROP INDEX archive_messages_observatory_missing_idx;
ALTER TABLE archive_messages DROP COLUMN observatory_projection;
