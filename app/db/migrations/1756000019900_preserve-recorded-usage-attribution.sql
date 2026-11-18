-- Up Migration
-- Recorded run identity and configured transport persona are evidence independent of the archive bot FK.
-- Additive launch metadata must never relabel an established dispatcher run or its accounting surface.
CREATE OR REPLACE FUNCTION usage_session_persona(session_key bigint) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT coalesce(
    (SELECT r.agent_name FROM usage_runs r
      WHERE r.host=s.host AND r.session_id=s.external_id AND coalesce(r.runtime,'claude-code')=s.harness
        AND s.source=s.harness AND r.agent_name IS NOT NULL
      ORDER BY r.started_at DESC NULLS LAST,r.run_id DESC LIMIT 1),
    s.bot,
    (SELECT l.resolved_persona FROM usage_launches l
      WHERE l.host=s.host AND l.source=s.source AND l.runtime=s.harness AND l.session_id=s.external_id
        AND l.envelope->>'persona' IS NOT NULL
      ORDER BY l.created_at DESC,l.run_id DESC LIMIT 1),
    nullif(s.meta->>'channel_persona',''))
  FROM archive_sessions s WHERE s.id=session_key
$$;

CREATE OR REPLACE FUNCTION usage_session_persona_status(session_key bigint) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN usage_session_persona(s.id) IS NOT NULL THEN
      CASE WHEN EXISTS (SELECT 1 FROM org_agents o WHERE o.name=usage_session_persona(s.id) AND o.runtime<>'human')
        THEN 'known' ELSE 'unknown' END
    WHEN s.persona_evidence->>'status'='unknown'
      OR nullif(s.meta->>'persona','') IS NOT NULL OR nullif(s.meta->>'channel_persona','') IS NOT NULL
      OR EXISTS (SELECT 1 FROM usage_launches l WHERE l.host=s.host AND l.source=s.source AND l.runtime=s.harness AND l.session_id=s.external_id AND l.persona_status='unknown')
      OR EXISTS (SELECT 1 FROM usage_runs r WHERE r.host=s.host AND r.session_id=s.external_id AND coalesce(r.runtime,'claude-code')=s.harness AND s.source=s.harness AND r.agent_name IS NOT NULL)
    THEN 'unknown' ELSE 'absent' END FROM archive_sessions s WHERE s.id=session_key
$$;

CREATE OR REPLACE VIEW usage_facts AS
SELECT c.id, c.ts, c.host, c.source, c.model, c.session_external_id AS sid, c.entrypoint,
       (c.entrypoint IS DISTINCT FROM 'cli') AS headless,
       CASE WHEN r.agent_name IS NOT NULL THEN 'bot'
            WHEN usage_session_persona(s.id) IS NOT NULL THEN 'owner-chat'
            WHEN c.host = 'droplet' AND r.run_id IS NOT NULL THEN 'cc-lane'
            WHEN c.host = 'droplet' THEN 'droplet'
            WHEN c.entrypoint = 'cli' THEN c.host ELSE c.host || '-headless' END AS surface,
       c.run_id, coalesce(r.agent_name, usage_session_persona(s.id)) AS agent_name, coalesce(r.team_slug, a.team_slug, b.team_slug) AS team_slug,
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
       c.cost_usd,
       coalesce(nullif(c.provider, ''), CASE c.source WHEN 'claude-code' THEN 'anthropic' WHEN 'codex' THEN 'openai' END) AS provider,
       nullif(btrim(split_part(hp.title, ' · ', 1)), '') AS job,
       hp.external_id AS launcher_session
FROM usage_calls c
LEFT JOIN usage_runs r ON r.host = c.host AND r.run_id = c.run_id AND coalesce(r.runtime, 'claude-code') = c.source
LEFT JOIN org_agents a ON a.name = r.agent_name
LEFT JOIN task_links tl ON tl.task_id = r.task_id
LEFT JOIN LATERAL (SELECT reason FROM org_wakeups WHERE claimed_by = r.run_id ORDER BY id LIMIT 1) w ON r.run_id IS NOT NULL
LEFT JOIN archive_sessions s ON s.host = c.host AND s.source = c.source AND s.external_id = c.session_external_id
LEFT JOIN org_agents b ON b.name = usage_session_persona(s.id) AND r.agent_name IS NULL
LEFT JOIN LATERAL (SELECT p.external_id, p.title FROM archive_sessions p
                    WHERE c.source = 'codex' AND p.harness = 'hermes' AND p.host = c.host
                      AND p.codex_thread_id = c.session_external_id
                    ORDER BY p.started_at NULLS LAST, p.id LIMIT 1) hp ON true
WHERE c.source IN ('claude-code', 'zen-agent', 'codex');


-- Down Migration
-- Forward only. Preserve all raw evidence and nullable schema additions.
