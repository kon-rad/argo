-- Up Migration

-- Which roster bot a session talked as, when the person who started it chose one: `claude --agent <name>`
-- (Claude Code's `agent-setting` record), a Codex or Hermes chat opened with the compiled persona as its first
-- message ("You are **<name>**"), or a zen-agent trace's persona. Set at import time by
-- server/src/archive/bot.ts, never from a folder name or a title. The foreign key keeps a name that is not in
-- the roster out of the column. A dispatcher wake keeps its own label (usage_runs.agent_name); this column only
-- labels the sessions a person started.
ALTER TABLE archive_sessions
  ADD COLUMN bot text REFERENCES org_agents(name) ON UPDATE CASCADE ON DELETE SET NULL;
CREATE INDEX archive_sessions_bot_idx ON archive_sessions (bot, started_at) WHERE bot IS NOT NULL;

-- usage_facts: a call outside any wake whose session has a bot is labelled with that bot and the surface
-- 'owner-chat'. A call in a run keeps the run's agent and the surface 'bot', exactly as before.
-- Definition as of 1756000018400_para-areas-projects.sql (column names) with agent_name, team_slug and surface
-- reading the session's bot.
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
       c.cost_usd
FROM usage_calls c
LEFT JOIN usage_runs r ON r.host = c.host AND r.run_id = c.run_id
LEFT JOIN org_agents a ON a.name = r.agent_name
LEFT JOIN task_links tl ON tl.task_id = r.task_id
LEFT JOIN LATERAL (SELECT reason FROM org_wakeups WHERE claimed_by = r.run_id ORDER BY id LIMIT 1) w ON r.run_id IS NOT NULL
LEFT JOIN archive_sessions s ON s.host = c.host AND s.source = c.source AND s.external_id = c.session_external_id
LEFT JOIN org_agents b ON b.name = s.bot AND r.agent_name IS NULL
WHERE c.source IN ('claude-code', 'zen-agent', 'codex');

-- Down Migration
-- Forward only.
