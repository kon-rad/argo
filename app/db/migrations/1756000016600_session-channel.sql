-- Up Migration

-- Where a session's prompts came from when not a keyboard: 'telegram' (a Telegram bot on any harness),
-- 'web' (the app's chat page), 'remote-control'. Written into meta by the collectors
-- (server/src/archive/channel.ts); the generated column gives the sessions page a facet and an index.
-- `secondbrain archive-steps --relabel` fills it for sessions stored before this migration.
ALTER TABLE archive_sessions
  ADD COLUMN channel text GENERATED ALWAYS AS (NULLIF(meta ->> 'channel', '')) STORED;
CREATE INDEX archive_sessions_channel_idx ON archive_sessions (channel, started_at) WHERE channel IS NOT NULL;

-- usage_facts: the same label on every call, so the token charts filter to Telegram too.
-- Definition as of 1756000015000_zen-runtime.sql plus `channel`.
DROP VIEW usage_facts;
CREATE VIEW usage_facts AS
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
WHERE c.source IN ('claude-code', 'zen-agent');

-- Down Migration

DROP VIEW usage_facts;
CREATE VIEW usage_facts AS
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
       c.input_tokens AS input, c.cache_write_tokens AS cache_write, c.cache_read_tokens AS cache_read, c.output_tokens AS output,
       c.cost_usd
FROM usage_calls c
LEFT JOIN usage_runs r ON r.host = c.host AND r.run_id = c.run_id
LEFT JOIN org_agents a ON a.name = r.agent_name
LEFT JOIN task_links tl ON tl.task_id = r.task_id
LEFT JOIN LATERAL (SELECT reason FROM org_wakeups WHERE claimed_by = r.run_id ORDER BY id LIMIT 1) w ON r.run_id IS NOT NULL
WHERE c.source IN ('claude-code', 'zen-agent');

DROP INDEX archive_sessions_channel_idx;
ALTER TABLE archive_sessions DROP COLUMN channel;
