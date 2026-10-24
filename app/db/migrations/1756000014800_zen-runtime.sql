-- db/migrations/1756000014800_zen-runtime.sql
-- Up Migration

-- Bots on zen-agent (docs/zen-runtime.md): a third bot runtime next to claude-code and hermes, the
-- ledger rows its traces produce, the decisions a classify step makes in front of a wake, and two
-- rules that stop wakes nobody needs (an acknowledgement, a routine repeated across a day boundary).

-- 1. The per-bot switch. The roster's `runtime: zen-agent` is what the dispatcher reads to choose the runner.
ALTER TABLE org_agents DROP CONSTRAINT org_agents_runtime_check;
ALTER TABLE org_agents ADD CONSTRAINT org_agents_runtime_check
  CHECK (runtime IN ('claude-code','hermes','codex','zen-agent','human'));
-- Scheduled wakes from the roster: [{ "name", "at": "HH:MM", "days": [1..7]?, "task_file" }], in ORG_TZ.
ALTER TABLE org_agents ADD COLUMN routines jsonb NOT NULL DEFAULT '[]';

-- 2. An acknowledgement wakes nobody. It is read on the recipient's next real wake.
ALTER TABLE org_messages DROP CONSTRAINT org_messages_kind_check;
ALTER TABLE org_messages ADD CONSTRAINT org_messages_kind_check
  CHECK (kind IN ('message','status','decision','handoff','question-for-owner','standup','reflection','reply','ack'));

CREATE OR REPLACE FUNCTION org_messages_wake() RETURNS trigger AS $$
DECLARE
  ch_kind      text;
  author_team  text;
  author_human boolean;
  base_reason  text;
  bot_cap      constant integer := 3;
BEGIN
  SELECT kind INTO ch_kind FROM org_channels WHERE slug = NEW.channel_slug;
  SELECT team_slug, runtime = 'human' INTO author_team, author_human FROM org_agents WHERE name = NEW.author;
  base_reason := CASE WHEN author_human THEN 'owner' ELSE NULL END;

  -- An acknowledgement never wakes anyone, whoever wrote it; a bot's status or reply neither.
  IF NEW.kind = 'ack' OR (NEW.kind IN ('status', 'reply') AND NOT coalesce(author_human, false)) THEN
    PERFORM pg_notify('org_board', NEW.id::text);
    RETURN NEW;
  END IF;

  IF ch_kind = 'dm' THEN
    INSERT INTO org_wakeups (agent_name, reason, ref)
    SELECT m.agent_name, COALESCE(base_reason, 'dm'), NEW.id::text
      FROM org_channel_members m JOIN org_agents a ON a.name = m.agent_name
     WHERE m.channel_slug = NEW.channel_slug AND m.agent_name <> NEW.author
       AND a.runtime <> 'human' AND a.retired_at IS NULL
       AND (coalesce(author_human, false) OR org_bot_wakes_today(NEW.author, m.agent_name) < bot_cap)
    ON CONFLICT (agent_name, reason, ref) WHERE done_at IS NULL DO NOTHING;
  ELSIF NEW.kind = 'handoff' THEN
    INSERT INTO org_wakeups (agent_name, reason, ref)
    SELECT DISTINCT x.who, 'handoff', NEW.id::text
      FROM (
        SELECT a.name AS who FROM org_agents a WHERE a.name = ANY (NEW.mentions)
        UNION
        SELECT a.reports_to FROM org_agents a
         WHERE a.name = ANY (NEW.mentions) AND a.reports_to IS NOT NULL
           AND a.team_slug IS DISTINCT FROM author_team
      ) x
      JOIN org_agents t ON t.name = x.who
      JOIN org_channel_members m ON m.channel_slug = NEW.channel_slug AND m.agent_name = x.who
     WHERE x.who <> NEW.author AND t.runtime <> 'human' AND t.retired_at IS NULL
       AND (coalesce(author_human, false) OR org_bot_wakes_today(NEW.author, x.who) < bot_cap)
    ON CONFLICT (agent_name, reason, ref) WHERE done_at IS NULL DO NOTHING;
  ELSIF NEW.kind <> 'question-for-owner' AND cardinality(NEW.mentions) > 0 THEN
    INSERT INTO org_wakeups (agent_name, reason, ref)
    SELECT a.name, COALESCE(base_reason, 'mention'), NEW.id::text
      FROM org_agents a
      JOIN org_channel_members m ON m.channel_slug = NEW.channel_slug AND m.agent_name = a.name
     WHERE a.name = ANY (NEW.mentions) AND a.name <> NEW.author
       AND a.runtime <> 'human' AND a.retired_at IS NULL
       AND (coalesce(author_human, false) OR org_bot_wakes_today(NEW.author, a.name) < bot_cap)
    ON CONFLICT (agent_name, reason, ref) WHERE done_at IS NULL DO NOTHING;
  END IF;

  PERFORM pg_notify('org_board', NEW.id::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- 3. The ledger: one usage_runs row per zen-agent run (from its trace's meta and end lines), one usage_calls
-- row per model response. `runtime` is the facet; `outcome` the classify step's label of the run's result;
-- `parts` the size of every system-prompt part; `tier` the card tier the dispatcher chose.
ALTER TABLE usage_runs
  ADD COLUMN runtime     text NOT NULL DEFAULT 'claude-code' CHECK (runtime IN ('claude-code','zen-agent')),
  ADD COLUMN outcome     text CHECK (outcome IN ('did-work','no-op','blocked','failed')),
  ADD COLUMN parts       jsonb,
  ADD COLUMN budget      jsonb,
  ADD COLUMN tier        text,
  ADD COLUMN compactions int,
  ADD COLUMN blocked     int;
-- Real dollars, priced by the runtime from the provider's catalogue. Claude Code calls (subscription) leave it
-- null and the routes keep hiding cost for them; zen-agent and Hermes calls carry it.
ALTER TABLE usage_calls ADD COLUMN cost_usd double precision;

-- 4. Every decision a classifier made in front of a wake or a card, joined to the run it caused or avoided.
CREATE TABLE classify_decisions (
  id             bigserial PRIMARY KEY,
  decision       text NOT NULL,                 -- wake-gate | card-tier | run-outcome | ...
  schema_version text NOT NULL,
  input_hash     text NOT NULL,                 -- sha256 of the state JSON: the cache key with decision + version
  input_level    text,                          -- shared | public | refused
  model          text,
  answer         text,
  probabilities  jsonb,
  confidence     double precision,
  action         text NOT NULL CHECK (action IN ('act','skip','escalate','fallthrough')),
  latency_ms     int,
  input_tokens   int,
  cost_usd       double precision,
  error          text,                          -- privacy | timeout | no-key | budget | provider: <message>
  run_id         text,
  agent_name     text,
  ref            text,                          -- the message id or card the decision was about
  created_at     timestamptz NOT NULL DEFAULT now(),
  label          text,                          -- a person's later verdict: right | wrong
  labelled_by    text,
  labelled_at    timestamptz
);
CREATE INDEX classify_decisions_cache_idx ON classify_decisions (decision, schema_version, input_hash, created_at DESC);
CREATE INDEX classify_decisions_run_idx ON classify_decisions (run_id) WHERE run_id IS NOT NULL;
CREATE INDEX classify_decisions_created_idx ON classify_decisions (created_at);

-- 5. The page reads zen-agent calls through the same view; Hermes keeps its counters path. A run with a bot
-- is a bot's wherever it ran; `runtime` joins from the run (a call without a run is its source's).
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

-- Down Migration

DROP VIEW usage_facts;
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
                            WHEN 'cc-writer' THEN 'writing' WHEN 'cc-reviewer' THEN 'coding' END,
                a.work) AS work_type,
       tl.project_slug, tl.feature_slug, r.task_id, r.board, r.lane,
       c.input_tokens AS input, c.cache_write_tokens AS cache_write, c.cache_read_tokens AS cache_read, c.output_tokens AS output
FROM usage_calls c
LEFT JOIN usage_runs r ON r.host = c.host AND r.run_id = c.run_id
LEFT JOIN org_agents a ON a.name = r.agent_name
LEFT JOIN task_links tl ON tl.task_id = r.task_id
LEFT JOIN LATERAL (SELECT reason FROM org_wakeups WHERE claimed_by = r.run_id ORDER BY id LIMIT 1) w ON r.run_id IS NOT NULL
WHERE c.source = 'claude-code';

DROP TABLE classify_decisions;
ALTER TABLE usage_calls DROP COLUMN cost_usd;
ALTER TABLE usage_runs DROP COLUMN blocked, DROP COLUMN compactions, DROP COLUMN tier, DROP COLUMN budget, DROP COLUMN parts,
  DROP COLUMN outcome, DROP COLUMN runtime;

CREATE OR REPLACE FUNCTION org_messages_wake() RETURNS trigger AS $$
DECLARE
  ch_kind      text;
  author_team  text;
  author_human boolean;
  base_reason  text;
  bot_cap      constant integer := 3;
BEGIN
  SELECT kind INTO ch_kind FROM org_channels WHERE slug = NEW.channel_slug;
  SELECT team_slug, runtime = 'human' INTO author_team, author_human FROM org_agents WHERE name = NEW.author;
  base_reason := CASE WHEN author_human THEN 'owner' ELSE NULL END;

  IF NEW.kind IN ('status', 'reply') AND NOT coalesce(author_human, false) THEN
    PERFORM pg_notify('org_board', NEW.id::text);
    RETURN NEW;
  END IF;

  IF ch_kind = 'dm' THEN
    INSERT INTO org_wakeups (agent_name, reason, ref)
    SELECT m.agent_name, COALESCE(base_reason, 'dm'), NEW.id::text
      FROM org_channel_members m JOIN org_agents a ON a.name = m.agent_name
     WHERE m.channel_slug = NEW.channel_slug AND m.agent_name <> NEW.author
       AND a.runtime <> 'human' AND a.retired_at IS NULL
       AND (coalesce(author_human, false) OR org_bot_wakes_today(NEW.author, m.agent_name) < bot_cap)
    ON CONFLICT (agent_name, reason, ref) WHERE done_at IS NULL DO NOTHING;
  ELSIF NEW.kind = 'handoff' THEN
    INSERT INTO org_wakeups (agent_name, reason, ref)
    SELECT DISTINCT x.who, 'handoff', NEW.id::text
      FROM (
        SELECT a.name AS who FROM org_agents a WHERE a.name = ANY (NEW.mentions)
        UNION
        SELECT a.reports_to FROM org_agents a
         WHERE a.name = ANY (NEW.mentions) AND a.reports_to IS NOT NULL
           AND a.team_slug IS DISTINCT FROM author_team
      ) x
      JOIN org_agents t ON t.name = x.who
      JOIN org_channel_members m ON m.channel_slug = NEW.channel_slug AND m.agent_name = x.who
     WHERE x.who <> NEW.author AND t.runtime <> 'human' AND t.retired_at IS NULL
       AND (coalesce(author_human, false) OR org_bot_wakes_today(NEW.author, x.who) < bot_cap)
    ON CONFLICT (agent_name, reason, ref) WHERE done_at IS NULL DO NOTHING;
  ELSIF NEW.kind <> 'question-for-owner' AND cardinality(NEW.mentions) > 0 THEN
    INSERT INTO org_wakeups (agent_name, reason, ref)
    SELECT a.name, COALESCE(base_reason, 'mention'), NEW.id::text
      FROM org_agents a
      JOIN org_channel_members m ON m.channel_slug = NEW.channel_slug AND m.agent_name = a.name
     WHERE a.name = ANY (NEW.mentions) AND a.name <> NEW.author
       AND a.runtime <> 'human' AND a.retired_at IS NULL
       AND (coalesce(author_human, false) OR org_bot_wakes_today(NEW.author, a.name) < bot_cap)
    ON CONFLICT (agent_name, reason, ref) WHERE done_at IS NULL DO NOTHING;
  END IF;

  PERFORM pg_notify('org_board', NEW.id::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DELETE FROM org_messages WHERE kind = 'ack';
ALTER TABLE org_messages DROP CONSTRAINT org_messages_kind_check;
ALTER TABLE org_messages ADD CONSTRAINT org_messages_kind_check
  CHECK (kind IN ('message','status','decision','handoff','question-for-owner','standup','reflection','reply'));

ALTER TABLE org_agents DROP COLUMN routines;
UPDATE org_agents SET runtime = 'claude-code' WHERE runtime = 'zen-agent';
ALTER TABLE org_agents DROP CONSTRAINT org_agents_runtime_check;
ALTER TABLE org_agents ADD CONSTRAINT org_agents_runtime_check CHECK (runtime IN ('claude-code','hermes','codex','human'));
