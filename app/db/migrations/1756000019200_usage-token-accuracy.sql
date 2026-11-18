-- Up Migration

-- A Hermes job (cron, mostly) on the openai-codex provider runs its turns inside a Codex thread. The tokens are
-- measured once, on the Codex session; Hermes keeps the thread id inside its model_config. Lift it into a column
-- so a Codex call can name the Hermes job that started it. model_config arrives as a JSON string or an object,
-- so the id is read by pattern (no cast that could fail an insert).
ALTER TABLE archive_sessions
  ADD COLUMN codex_thread_id text GENERATED ALWAYS AS
    (substring(meta ->> 'model_config' from '"codex_thread_id": *"([0-9A-Za-z-]+)"')) STORED;
CREATE INDEX archive_sessions_codex_thread_idx ON archive_sessions (host, codex_thread_id) WHERE codex_thread_id IS NOT NULL;

-- usage_facts, as of 1756000019100_session-bot.sql, plus three columns at the end:
--   provider         the call's own provider; a row written before providers were recorded falls back to its harness's
--   job              the Hermes job whose Codex thread made the call (its title without the run date)
--   launcher_session that Hermes session's id
CREATE OR REPLACE VIEW usage_facts AS
SELECT c.id, c.ts, c.host, c.source, c.model, c.session_external_id AS sid, c.entrypoint,
       (c.entrypoint IS DISTINCT FROM 'cli') AS headless,
       CASE WHEN r.agent_name IS NOT NULL THEN 'bot'
            WHEN s.bot IS NOT NULL THEN 'owner-chat'
            WHEN c.host = 'droplet' AND r.run_id IS NOT NULL THEN 'cc-lane'
            WHEN c.host = 'droplet' THEN 'droplet'
            WHEN c.entrypoint = 'cli' THEN c.host ELSE c.host || '-headless' END AS surface,
       c.run_id, coalesce(r.agent_name, s.bot) AS agent_name, coalesce(r.team_slug, a.team_slug, b.team_slug) AS team_slug,
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
LEFT JOIN usage_runs r ON r.host = c.host AND r.run_id = c.run_id
LEFT JOIN org_agents a ON a.name = r.agent_name
LEFT JOIN task_links tl ON tl.task_id = r.task_id
LEFT JOIN LATERAL (SELECT reason FROM org_wakeups WHERE claimed_by = r.run_id ORDER BY id LIMIT 1) w ON r.run_id IS NOT NULL
LEFT JOIN archive_sessions s ON s.host = c.host AND s.source = c.source AND s.external_id = c.session_external_id
LEFT JOIN org_agents b ON b.name = s.bot AND r.agent_name IS NULL
-- One row at most: a compression continuation can repeat the thread id on a second Hermes session.
LEFT JOIN LATERAL (SELECT p.external_id, p.title FROM archive_sessions p
                    WHERE c.source = 'codex' AND p.harness = 'hermes' AND p.host = c.host
                      AND p.codex_thread_id = c.session_external_id
                    ORDER BY p.started_at NULLS LAST, p.id LIMIT 1) hp ON true
WHERE c.source IN ('claude-code', 'zen-agent', 'codex');

-- Down Migration
-- Forward only.
