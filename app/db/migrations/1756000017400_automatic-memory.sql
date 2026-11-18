-- Up Migration

-- Save extracted claims in the same transaction as their session summary. A trigger
-- covers every writer, including older summarizers during a rolling upgrade.
CREATE FUNCTION save_summary_memory() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  summary record;
  existing_id bigint;
  normalized text;
  project text;
BEGIN
  IF NEW.status <> 'proposed' THEN RETURN NEW; END IF;
  normalized := btrim(regexp_replace(NEW.claim, '\s+', ' ', 'g'));
  SELECT s.project, s.host, a.external_id INTO STRICT summary
    FROM agent_summaries s JOIN archive_sessions a ON a.id = s.session_id
    WHERE s.id = NEW.summary_id;
  SELECT slug INTO project FROM projects WHERE slug = summary.project;
  -- Serialise equal scoped claims, including concurrent sessions. Retired facts
  -- count as matches too: rerunning a summarizer must never resurrect a claim.
  PERFORM pg_advisory_xact_lock(hashtextextended(json_build_array(NEW.agent, project, normalized)::text, 0));
  SELECT m.id INTO existing_id FROM memory_facts m
    WHERE m.agent IS NOT DISTINCT FROM NEW.agent
      AND m.project_slug IS NOT DISTINCT FROM project
      AND btrim(regexp_replace(m.claim, '\s+', ' ', 'g')) = normalized
    ORDER BY m.id LIMIT 1;
  IF existing_id IS NULL AND EXISTS (
    SELECT 1 FROM agent_summary_facts f JOIN agent_summaries s ON s.id = f.summary_id
    WHERE f.status = 'rejected' AND f.agent IS NOT DISTINCT FROM NEW.agent
      AND s.project IS NOT DISTINCT FROM summary.project
      AND btrim(regexp_replace(f.claim, '\s+', ' ', 'g')) = normalized
  ) THEN
    NEW.status := 'rejected';
  ELSE
    IF existing_id IS NULL THEN
      INSERT INTO memory_facts (subject, claim, source, author, via, project_slug, agent, confidence)
        VALUES (NEW.subject, normalized,
          left(format('agent-summary:%s (session %s/%s)', NEW.summary_id, summary.host, summary.external_id), 500),
          'summarizer', 'agent-summaries', project, NEW.agent, 'inferred')
        RETURNING id INTO existing_id;
    END IF;
    NEW.status := 'promoted';
    NEW.fact_id := existing_id;
  END IF;
  NEW.decided_by := 'automatic';
  NEW.decided_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER summary_memory_automatic BEFORE INSERT OR UPDATE OF status ON agent_summary_facts
  FOR EACH ROW EXECUTE FUNCTION save_summary_memory();

-- Existing pending claims use exactly the same path, retaining their session
-- provenance. Rejected and promoted history is untouched.
UPDATE agent_summary_facts SET status = status WHERE status = 'proposed';

-- Down Migration
DROP TRIGGER IF EXISTS summary_memory_automatic ON agent_summary_facts;
DROP FUNCTION IF EXISTS save_summary_memory();
-- Saved facts remain durable history on rollback.
