-- db/migrations/1756000012900_usage-attribution.sql
-- Up Migration

-- Usage attribution:
-- one usage_runs row per wake (not per resumed session), the bot and its reasons
-- on the run, the tool and action on every call, a host registry instead of the
-- two-value check, and the usage_facts view every /usage endpoint reads.

-- The hosts. `mac` (the owner's laptop) and `droplet` (the server) are the two
-- slugs the collectors have always written, and the archive tables share the
-- label. Register more with an INSERT into usage_hosts.
CREATE TABLE usage_hosts (
  slug    text PRIMARY KEY CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,31}$'),
  display text NOT NULL,
  kind    text NOT NULL CHECK (kind IN ('laptop', 'server', 'pi')),
  chip    text,
  notes   text
);
INSERT INTO usage_hosts (slug, display, kind, chip, notes) VALUES
  ('mac',     'Laptop', 'laptop', NULL, 'interactive Claude Code; pushes its usage to the server'),
  ('droplet', 'Server', 'server', NULL, 'the always-on box: scheduled agents and the database');

ALTER TABLE usage_calls            DROP CONSTRAINT usage_calls_host_check,            ADD FOREIGN KEY (host) REFERENCES usage_hosts(slug) ON UPDATE CASCADE;
ALTER TABLE usage_runs             DROP CONSTRAINT usage_runs_host_check,             ADD FOREIGN KEY (host) REFERENCES usage_hosts(slug) ON UPDATE CASCADE;
ALTER TABLE plan_usage_snapshots   DROP CONSTRAINT plan_usage_snapshots_host_check,   ADD FOREIGN KEY (host) REFERENCES usage_hosts(slug) ON UPDATE CASCADE;
ALTER TABLE hermes_usage_snapshots DROP CONSTRAINT hermes_usage_snapshots_host_check, ADD FOREIGN KEY (host) REFERENCES usage_hosts(slug) ON UPDATE CASCADE;
ALTER TABLE usage_files            DROP CONSTRAINT usage_files_host_check,            ADD FOREIGN KEY (host) REFERENCES usage_hosts(slug) ON UPDATE CASCADE;
-- The archive shares the label; a new host must be able to push transcripts too.
ALTER TABLE archive_files     DROP CONSTRAINT IF EXISTS archive_files_host_check;
ALTER TABLE archive_sessions  DROP CONSTRAINT IF EXISTS archive_sessions_host_check;
ALTER TABLE archive_memory_versions DROP CONSTRAINT IF EXISTS archive_memory_versions_host_check;
ALTER TABLE archive_log_lines DROP CONSTRAINT IF EXISTS archive_log_lines_host_check;
ALTER TABLE ingest_runs       DROP CONSTRAINT IF EXISTS ingest_runs_host_check;

-- One row per run. A bot resumes one session for days, so the session id is not a key.
ALTER TABLE usage_runs
  ADD COLUMN run_id     text,
  ADD COLUMN agent_name text,
  ADD COLUMN team_slug  text,
  ADD COLUMN work_type  text,
  ADD COLUMN reasons    jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN wakeup_ids bigint[] NOT NULL DEFAULT '{}',
  ADD COLUMN resumed    boolean;
-- Existing rows: the log's file name, with an ordinal when a retried lane card put two runs in one file.
WITH named AS (
  SELECT host, session_id,
         regexp_replace(log_path, '^.*/|\.jsonl$', '', 'g') AS base,
         row_number() OVER (PARTITION BY host, log_path ORDER BY started_at NULLS LAST, session_id) AS n,
         count(*)    OVER (PARTITION BY host, log_path) AS total
  FROM usage_runs)
UPDATE usage_runs r SET run_id = CASE WHEN named.total > 1 THEN named.base || '#' || named.n ELSE named.base END
FROM named WHERE named.host = r.host AND named.session_id = r.session_id;
UPDATE usage_runs SET agent_name = substring(run_id FROM '^org-([a-z0-9-]+)-[0-9]{8}-[0-9]{6}') WHERE run_id LIKE 'org-%';
ALTER TABLE usage_runs DROP CONSTRAINT usage_runs_pkey;
ALTER TABLE usage_runs ALTER COLUMN run_id SET NOT NULL, ADD PRIMARY KEY (host, run_id);
CREATE INDEX usage_runs_session_idx ON usage_runs (host, session_id);
CREATE INDEX usage_runs_agent_idx ON usage_runs (agent_name, started_at);
-- Re-read every run log on the next sync so each wake gets its own row.
DELETE FROM usage_files WHERE path LIKE '%/cc-runs/%';

-- What a call did: the first tool the response invoked, and its class.
ALTER TABLE usage_calls
  ADD COLUMN run_id text,
  ADD COLUMN tool   text,
  ADD COLUMN action text CHECK (action IN ('dm', 'post', 'ticket', 'card', 'tracker', 'write', 'read', 'shell', 'reply'));
CREATE INDEX usage_calls_run_idx ON usage_calls (host, run_id);

-- The kind of work a card is: set by cli-org task create|assign --type, by a graph template, else the bot's default.
ALTER TABLE task_links ADD COLUMN work_type text
  CHECK (work_type IN ('research', 'coding', 'design', 'media', 'writing', 'sales', 'education', 'ops'));

CREATE OR REPLACE FUNCTION org_task_link(p_task text, p_board text, p_title text, p_project text, p_feature text, p_assignee text, p_by text,
                                         p_graph text, p_node text, p_kind text, p_rounds integer, p_work text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF org_me() IS NOT NULL AND org_me() <> p_by THEN
    RAISE EXCEPTION 'task link: caller is %, not %', org_me(), p_by;
  END IF;
  INSERT INTO task_links (task_id, board, title, project_slug, feature_slug, assignee, created_by, graph, node, kind, rounds, work_type)
  VALUES (p_task, p_board, p_title, p_project, p_feature, p_assignee, p_by, p_graph, p_node, coalesce(p_kind, 'work'), coalesce(p_rounds, 0), p_work)
  ON CONFLICT (task_id) DO UPDATE SET project_slug = EXCLUDED.project_slug, feature_slug = EXCLUDED.feature_slug, assignee = EXCLUDED.assignee,
    title = EXCLUDED.title, graph = EXCLUDED.graph, node = EXCLUDED.node, kind = EXCLUDED.kind, rounds = EXCLUDED.rounds,
    work_type = coalesce(EXCLUDED.work_type, task_links.work_type);
  IF p_project IS NOT NULL AND p_feature IS NOT NULL AND coalesce(p_kind, 'work') IN ('work', 'build') THEN
    UPDATE features SET owner = p_assignee WHERE project_slug = p_project AND slug = p_feature;
  END IF;
END
$$;
-- The eleven-argument form keeps the card's type as it is.
CREATE OR REPLACE FUNCTION org_task_link(p_task text, p_board text, p_title text, p_project text, p_feature text, p_assignee text, p_by text,
                                         p_graph text, p_node text, p_kind text, p_rounds integer)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT org_task_link(p_task, p_board, p_title, p_project, p_feature, p_assignee, p_by, p_graph, p_node, p_kind, p_rounds, NULL)
$$;

-- One row per Claude Code call with every label the dashboard filters on.
CREATE VIEW usage_facts AS
SELECT c.id, c.ts, c.host, c.source, c.model, c.session_external_id AS sid, c.entrypoint,
       (c.entrypoint IS DISTINCT FROM 'cli') AS headless,
       CASE WHEN c.host = 'droplet' AND r.agent_name IS NOT NULL THEN 'bot'
            WHEN c.host = 'droplet' AND r.run_id IS NOT NULL THEN 'cc-lane'
            WHEN c.host = 'droplet' THEN 'droplet'
            WHEN c.entrypoint = 'cli' THEN c.host ELSE c.host || '-headless' END AS surface,
       c.run_id, r.agent_name, coalesce(r.team_slug, a.team_slug) AS team_slug,
       coalesce(r.reasons -> 0 ->> 'reason', w.reason) AS reason,
       c.tool, c.action,
       coalesce(tl.work_type, r.work_type,
                CASE r.lane WHEN 'cc-coder' THEN 'coding' WHEN 'cc-research' THEN 'research'
                            WHEN 'cc-writer' THEN 'writing' WHEN 'cc-reviewer' THEN 'coding' END) AS work_type,
       tl.project_slug, tl.feature_slug, r.task_id, r.board, r.lane,
       c.input_tokens AS input, c.cache_write_tokens AS cache_write, c.cache_read_tokens AS cache_read, c.output_tokens AS output
FROM usage_calls c
LEFT JOIN usage_runs r ON r.host = c.host AND r.run_id = c.run_id
LEFT JOIN org_agents a ON a.name = r.agent_name
LEFT JOIN task_links tl ON tl.task_id = r.task_id
LEFT JOIN LATERAL (SELECT reason FROM org_wakeups WHERE claimed_by = r.run_id ORDER BY id LIMIT 1) w ON r.run_id IS NOT NULL;

-- Down Migration

DROP VIEW usage_facts;
DROP FUNCTION org_task_link(text, text, text, text, text, text, text, text, text, text, integer, text);
CREATE OR REPLACE FUNCTION org_task_link(p_task text, p_board text, p_title text, p_project text, p_feature text, p_assignee text, p_by text,
                                         p_graph text, p_node text, p_kind text, p_rounds integer)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF org_me() IS NOT NULL AND org_me() <> p_by THEN
    RAISE EXCEPTION 'task link: caller is %, not %', org_me(), p_by;
  END IF;
  INSERT INTO task_links (task_id, board, title, project_slug, feature_slug, assignee, created_by, graph, node, kind, rounds)
  VALUES (p_task, p_board, p_title, p_project, p_feature, p_assignee, p_by, p_graph, p_node, coalesce(p_kind, 'work'), coalesce(p_rounds, 0))
  ON CONFLICT (task_id) DO UPDATE SET project_slug = EXCLUDED.project_slug, feature_slug = EXCLUDED.feature_slug, assignee = EXCLUDED.assignee,
    title = EXCLUDED.title, graph = EXCLUDED.graph, node = EXCLUDED.node, kind = EXCLUDED.kind, rounds = EXCLUDED.rounds;
  IF p_project IS NOT NULL AND p_feature IS NOT NULL AND coalesce(p_kind, 'work') IN ('work', 'build') THEN
    UPDATE features SET owner = p_assignee WHERE project_slug = p_project AND slug = p_feature;
  END IF;
END
$$;
ALTER TABLE task_links DROP COLUMN work_type;
DROP INDEX usage_calls_run_idx;
ALTER TABLE usage_calls DROP COLUMN action, DROP COLUMN tool, DROP COLUMN run_id;
DROP INDEX usage_runs_agent_idx;
DROP INDEX usage_runs_session_idx;
ALTER TABLE usage_runs DROP CONSTRAINT usage_runs_pkey;
ALTER TABLE usage_runs ADD PRIMARY KEY (host, session_id);
ALTER TABLE usage_runs DROP COLUMN resumed, DROP COLUMN wakeup_ids, DROP COLUMN reasons, DROP COLUMN work_type,
  DROP COLUMN team_slug, DROP COLUMN agent_name, DROP COLUMN run_id;
ALTER TABLE usage_calls            DROP CONSTRAINT usage_calls_host_fkey,            ADD CHECK (host IN ('mac', 'droplet'));
ALTER TABLE usage_runs             DROP CONSTRAINT usage_runs_host_fkey,             ADD CHECK (host IN ('mac', 'droplet'));
ALTER TABLE plan_usage_snapshots   DROP CONSTRAINT plan_usage_snapshots_host_fkey,   ADD CHECK (host IN ('mac', 'droplet'));
ALTER TABLE hermes_usage_snapshots DROP CONSTRAINT hermes_usage_snapshots_host_fkey, ADD CHECK (host IN ('mac', 'droplet'));
ALTER TABLE usage_files            DROP CONSTRAINT usage_files_host_fkey,            ADD CHECK (host IN ('mac', 'droplet'));
DROP TABLE usage_hosts;
