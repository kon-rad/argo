-- Up Migration
ALTER TABLE archive_sessions ADD COLUMN persona_evidence jsonb;

-- Launch identity is independent of token-call identity and dispatch wake accounting.
CREATE TABLE usage_launches (
  host text NOT NULL REFERENCES usage_hosts(slug),
  source text NOT NULL,
  runtime text NOT NULL,
  run_id text NOT NULL,
  session_id text,
  envelope jsonb NOT NULL,
  resolved_persona text,
  verified_task_ids text[] NOT NULL,
  persona_status text NOT NULL CHECK (persona_status IN ('known','unknown','absent')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (host, source, runtime, run_id)
);
CREATE INDEX usage_launches_session_idx ON usage_launches(host, source, runtime, session_id);
CREATE TABLE archive_session_tasks (
  session_id bigint NOT NULL REFERENCES archive_sessions(id) ON DELETE CASCADE,
  task_id text NOT NULL REFERENCES cards(id),
  evidence_id text NOT NULL,
  provenance text NOT NULL,
  confidence text NOT NULL,
  reason text NOT NULL,
  PRIMARY KEY (session_id, task_id, evidence_id)
);
-- Strict identity on all three independent evidence paths; no synthetic usage_runs.
CREATE VIEW usage_session_tasks AS
SELECT s.id AS session_id, c.id AS task_id, 'launch:' || l.run_id AS evidence_id,
       'launch-v1'::text AS provenance, 'verified'::text AS confidence, 'trusted launch taskIds'::text AS reason
FROM archive_sessions s JOIN usage_launches l ON l.host=s.host AND l.source=s.source AND l.runtime=s.harness AND l.session_id=s.external_id
CROSS JOIN LATERAL unnest(l.verified_task_ids) t(id) JOIN cards c ON c.id=t.id
UNION ALL
SELECT s.id, c.id, 'run:' || r.run_id, 'dispatch-run', 'verified', 'strict host/source/runtime run identity'
FROM archive_sessions s JOIN usage_runs r ON r.host=s.host AND r.session_id=s.external_id
  AND coalesce(r.runtime,'claude-code')=s.harness AND s.source=s.harness
JOIN cards c ON c.id=r.task_id
UNION ALL SELECT session_id, task_id, evidence_id, provenance, confidence, reason FROM archive_session_tasks;

-- Read the same attribution in list, detail, facets and the usage aggregation view.
-- resolved_persona is a snapshot validated at launch ingestion, never a later roster guess.
CREATE FUNCTION usage_session_persona(session_key bigint) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN (SELECT l.envelope->>'persona' FROM usage_launches l
      WHERE l.host=s.host AND l.source=s.source AND l.runtime=s.harness AND l.session_id=s.external_id
      ORDER BY l.created_at DESC,l.run_id DESC LIMIT 1) IS NOT NULL THEN
    (SELECT l.resolved_persona FROM usage_launches l WHERE l.host=s.host AND l.source=s.source
      AND l.runtime=s.harness AND l.session_id=s.external_id ORDER BY l.created_at DESC,l.run_id DESC LIMIT 1)
    ELSE coalesce(
      (SELECT r.agent_name FROM usage_runs r JOIN org_agents o ON o.name=r.agent_name AND o.runtime<>'human'
        WHERE r.host=s.host AND r.session_id=s.external_id AND coalesce(r.runtime,'claude-code')=s.harness
          AND s.source=s.harness AND r.agent_name IS NOT NULL
        ORDER BY r.started_at DESC NULLS LAST,r.run_id DESC LIMIT 1), s.bot) END
    FROM archive_sessions s WHERE s.id=session_key
$$;

CREATE FUNCTION usage_session_persona_status(session_key bigint) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN usage_session_persona(s.id) IS NOT NULL THEN 'known'
    WHEN s.persona_evidence->>'status'='unknown'
      OR nullif(s.meta->>'persona','') IS NOT NULL OR nullif(s.meta->>'channel_persona','') IS NOT NULL
      OR EXISTS (SELECT 1 FROM usage_launches l WHERE l.host=s.host AND l.source=s.source AND l.runtime=s.harness AND l.session_id=s.external_id AND l.persona_status='unknown')
      OR EXISTS (SELECT 1 FROM usage_runs r WHERE r.host=s.host AND r.session_id=s.external_id AND coalesce(r.runtime,'claude-code')=s.harness AND s.source=s.harness AND r.agent_name IS NOT NULL)
    THEN 'unknown' ELSE 'absent' END FROM archive_sessions s WHERE s.id=session_key
$$;

CREATE OR REPLACE VIEW usage_facts AS
SELECT c.id, c.ts, c.host, c.source, c.model, c.session_external_id AS sid, c.entrypoint,
       (c.entrypoint IS DISTINCT FROM 'cli') AS headless,
       CASE WHEN a.name IS NOT NULL AND (CASE WHEN s.id IS NULL THEN a.name ELSE usage_session_persona(s.id) END) IS NOT NULL THEN 'bot'
            WHEN usage_session_persona(s.id) IS NOT NULL THEN 'owner-chat'
            WHEN c.host = 'droplet' AND r.run_id IS NOT NULL THEN 'cc-lane'
            WHEN c.host = 'droplet' THEN 'droplet'
            WHEN c.entrypoint = 'cli' THEN c.host ELSE c.host || '-headless' END AS surface,
       c.run_id, CASE WHEN s.id IS NULL THEN a.name ELSE usage_session_persona(s.id) END AS agent_name, coalesce(r.team_slug, a.team_slug, b.team_slug) AS team_slug,
       coalesce(r.reasons -> 0 ->> 'reason', w.reason) AS reason,
       c.tool, c.action,
       coalesce(tl.work_type, r.work_type,
                CASE r.lane WHEN 'cc-coder' THEN 'coding' WHEN 'cc-research' THEN 'research'
                            WHEN 'cc-writer' THEN 'writing' WHEN 'cc-reviewer' THEN 'coding' END,
                a.work) AS work_type,
       tl.area_slug, tl.project_slug, r.task_id, r.board, r.lane,
       coalesce(r.runtime, c.source) AS runtime, r.tier, r.outcome,
       s.channel,
       c.input_tokens AS input, c.cache_write_tokens AS cache_write, c.cache_read_tokens AS cache_read, c.output_tokens AS output,
       c.cost_usd
FROM usage_calls c
LEFT JOIN usage_runs r ON r.host = c.host AND r.run_id = c.run_id AND coalesce(r.runtime, 'claude-code') = c.source
LEFT JOIN org_agents a ON a.name = r.agent_name AND a.runtime<>'human'
LEFT JOIN task_links tl ON tl.task_id = r.task_id
LEFT JOIN LATERAL (SELECT reason FROM org_wakeups WHERE claimed_by = r.run_id ORDER BY id LIMIT 1) w ON r.run_id IS NOT NULL
LEFT JOIN archive_sessions s ON s.host = c.host AND s.source = c.source AND s.external_id = c.session_external_id
LEFT JOIN org_agents b ON b.name = usage_session_persona(s.id) AND r.agent_name IS NULL
WHERE c.source IN ('claude-code', 'zen-agent', 'codex');


-- Down Migration
-- Forward only. Raw evidence and nullable additions are retained on rollback.
