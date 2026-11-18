-- Up Migration

CREATE OR REPLACE VIEW usage_facts AS
SELECT c.id, c.ts, c.host, c.source, c.model, c.session_external_id AS sid, c.entrypoint,
       (c.entrypoint IS DISTINCT FROM 'cli') AS headless,
       CASE WHEN r.agent_name IS NOT NULL THEN 'bot'
            WHEN c.host = 'droplet' AND r.run_id IS NOT NULL THEN 'cc-lane'
            WHEN c.host = 'droplet' THEN 'droplet'
            WHEN c.entrypoint = 'cli' THEN c.host ELSE c.host || '-headless' END AS surface,
       c.run_id, r.agent_name, coalesce(r.team_slug, a.team_slug) AS team_slug,
       coalesce(r.reasons -> 0 ->> 'reason', w.reason) AS reason,
       c.tool, c.action,
       coalesce(tl.work_type, r.work_type,
                CASE r.lane WHEN 'cc-coder' THEN 'coding' WHEN 'cc-research' THEN 'research'
                            WHEN 'cc-writer' THEN 'writing' WHEN 'cc-reviewer' THEN 'coding' END,
                a.work) AS work_type,
       tl.project_slug, tl.feature_slug, r.task_id, r.board, r.lane,
       coalesce(r.runtime, c.source) AS runtime, r.tier, r.outcome,
       s.channel,
       c.input_tokens AS input, c.cache_write_tokens AS cache_write, c.cache_read_tokens AS cache_read, c.output_tokens AS output,
       c.cost_usd
FROM usage_calls c
LEFT JOIN usage_runs r ON r.host = c.host AND r.run_id = c.run_id
LEFT JOIN org_agents a ON a.name = r.agent_name
LEFT JOIN task_links tl ON tl.task_id = r.task_id
LEFT JOIN LATERAL (SELECT reason FROM org_wakeups WHERE claimed_by = r.run_id ORDER BY id LIMIT 1) w ON r.run_id IS NOT NULL
LEFT JOIN archive_sessions s ON s.host = c.host AND s.source = c.source AND s.external_id = c.session_external_id
WHERE c.source IN ('claude-code', 'zen-agent', 'codex');


-- Down Migration
-- Forward only.
