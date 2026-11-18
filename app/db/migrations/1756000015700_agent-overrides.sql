-- Up Migration

-- Phase 1b of the kanban cutover, items 3 to 5 of plan section 5a (vault: kanban-board/kanban-cutover-plan.md).
-- Builds on 1756000015400 (pause and resume); never edits it.
--
--   * org_agent_overrides: the owner switches an agent's runtime, model or effort (or pauses it) with one row, no
--     commit and no deploy. `.agents/org.yaml` stays the default and the audit trail. A null field means "no
--     override of this field". The claim path resolves override ?? roster through org_agents_effective, so every
--     lane obeys it with no adapter code, the same way every lane already obeys the pause flag.
--   * board_pause_lane: pause or resume every bot whose *effective* runtime is X. The credit breaker uses it.
--   * board_card_claim, re-issued to read the effective runtime and pause state.
--
-- Owner-only: only a human may write an override. A bot cannot move itself onto a model it likes, or move a
-- colleague off one. Validation of the runtime/model pair happens in the app (src/agent-spec.ts) because it is
-- shared with the roster import; this table only guarantees the shape.

CREATE TABLE org_agent_overrides (
  agent    text PRIMARY KEY REFERENCES org_agents(name) ON UPDATE CASCADE ON DELETE CASCADE,
  runtime  text CHECK (runtime IN ('claude-code', 'zen-agent', 'hermes')),
  model    text,
  effort   text CHECK (effort IN ('low', 'medium', 'high', 'xhigh', 'max')),
  paused   boolean NOT NULL DEFAULT false,
  set_by   text NOT NULL,
  set_at   timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON org_agent_overrides TO sb_org;

-- The roster row with its override applied. Everything that decides who runs a card or on what reads this, not
-- org_agents, so a switch takes effect on the next claim.
CREATE VIEW org_agents_effective AS
  SELECT a.name,
         coalesce(o.runtime, a.runtime) AS runtime,
         coalesce(o.model, a.model) AS model,
         o.effort,
         (a.paused OR coalesce(o.paused, false)) AS paused,
         (o.agent IS NOT NULL) AS overridden,
         a.retired_at
    FROM org_agents a LEFT JOIN org_agent_overrides o ON o.agent = a.name;
GRANT SELECT ON org_agents_effective TO sb_org;

CREATE OR REPLACE FUNCTION board_agent_may_claim(p_name text) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce((SELECT NOT paused AND retired_at IS NULL FROM org_agents_effective WHERE name = p_name), false)
$$;

-- Write or replace an agent's override. Fields left null inherit the roster. Owner only.
CREATE OR REPLACE FUNCTION board_set_override(p_by text, p_agent text, p_runtime text, p_model text, p_effort text)
RETURNS org_agent_overrides LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE c org_agents; o org_agent_overrides;
BEGIN
  c := board_caller(p_by);
  IF c.runtime <> 'human' THEN RAISE EXCEPTION 'only the owner can set an override; % is a bot', c.name; END IF;
  IF NOT EXISTS (SELECT 1 FROM org_agents WHERE name = p_agent AND retired_at IS NULL AND runtime NOT IN ('human', 'session')) THEN
    RAISE EXCEPTION 'no bot named "%" on the roster; run cli-org agents', p_agent;
  END IF;
  IF p_runtime IS NULL AND p_model IS NULL AND p_effort IS NULL THEN
    RAISE EXCEPTION 'an override sets a runtime, a model or an effort; to remove one use --clear';
  END IF;
  INSERT INTO org_agent_overrides (agent, runtime, model, effort, set_by) VALUES (p_agent, p_runtime, p_model, p_effort, c.name)
  ON CONFLICT (agent) DO UPDATE SET runtime = EXCLUDED.runtime, model = EXCLUDED.model, effort = EXCLUDED.effort,
         set_by = EXCLUDED.set_by, set_at = now()
  RETURNING * INTO o;
  PERFORM board_control_event(c.name, 'override-set', json_build_object('scope', p_agent,
          'reason', concat_ws(' ', coalesce('runtime ' || p_runtime, ''), coalesce('model ' || p_model, ''), coalesce('effort ' || p_effort, '')))::jsonb);
  RETURN o;
END
$$;
GRANT EXECUTE ON FUNCTION board_set_override(text, text, text, text, text) TO sb_org;

-- Remove an override; the roster applies again. Returns whether a row was there. Owner only.
CREATE OR REPLACE FUNCTION board_clear_override(p_by text, p_agent text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE c org_agents; n integer;
BEGIN
  c := board_caller(p_by);
  IF c.runtime <> 'human' THEN RAISE EXCEPTION 'only the owner can clear an override; % is a bot', c.name; END IF;
  DELETE FROM org_agent_overrides WHERE agent = p_agent;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    PERFORM board_control_event(c.name, 'override-cleared', json_build_object('scope', p_agent)::jsonb);
  END IF;
  RETURN n > 0;
END
$$;
GRANT EXECUTE ON FUNCTION board_clear_override(text, text) TO sb_org;

-- Pause or resume a whole lane: every bot whose effective runtime is p_runtime. Owner or a dispatch bot, the same
-- rule as board_pause. Only rows that change are touched, so a breaker that fires twice pauses once and says so
-- once (the return value is the number of bots that changed).
CREATE OR REPLACE FUNCTION board_pause_lane(p_by text, p_runtime text, p_paused boolean, p_reason text)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE c org_agents; n integer := 0;
BEGIN
  c := board_caller(p_by);
  IF c.runtime <> 'human' AND NOT ('dispatch' = ANY (c.capabilities)) THEN
    RAISE EXCEPTION '% may not pause or resume; only the owner or a dispatch bot can', c.name;
  END IF;
  IF p_paused AND coalesce(btrim(p_reason), '') = '' THEN RAISE EXCEPTION 'a pause needs a reason'; END IF;
  UPDATE org_agents a SET paused = p_paused, paused_reason = CASE WHEN p_paused THEN p_reason ELSE NULL END,
         paused_at = CASE WHEN p_paused THEN now() ELSE NULL END
    FROM org_agents_effective e
   WHERE e.name = a.name AND e.runtime = p_runtime AND a.retired_at IS NULL AND a.paused IS DISTINCT FROM p_paused;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    PERFORM board_control_event(c.name, CASE WHEN p_paused THEN 'paused' ELSE 'resumed' END,
            json_build_object('scope', 'lane ' || p_runtime, 'agents', n, 'reason', p_reason)::jsonb);
  END IF;
  RETURN n;
END
$$;
GRANT EXECUTE ON FUNCTION board_pause_lane(text, text, boolean, text) TO sb_org;

-- board_card_claim, re-issued: the same signature and the same rules as 1756000015400, reading the effective
-- runtime and pause state so an override moves a bot between lanes on its next claim.
DROP FUNCTION IF EXISTS board_card_claim(text, text, text, integer, text, bigint, text);
CREATE OR REPLACE FUNCTION board_card_claim(p_by text, p_runtime text, p_agent text, p_lease_minutes integer, p_board text, p_wakeup bigint DEFAULT NULL, p_task_id text DEFAULT NULL)
RETURNS cards LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE c org_agents; card cards;
BEGIN
  IF p_by IS NOT NULL THEN
    c := board_caller(p_by);
    IF c.runtime <> 'human' AND NOT ('dispatch' = ANY (c.capabilities)) AND p_agent IS DISTINCT FROM c.name THEN
      RAISE EXCEPTION '% can claim only its own cards', c.name;
    END IF;
  ELSIF org_me() IS NOT NULL THEN
    RAISE EXCEPTION 'board: no caller';
  END IF;
  IF p_runtime IS NULL AND p_agent IS NULL THEN RAISE EXCEPTION 'claim needs a runtime or an agent'; END IF;
  IF NOT board_dispatch_enabled(p_board) THEN
    RETURN NULL;
  END IF;
  SELECT k.* INTO card FROM cards k JOIN org_agents_effective a ON a.name = k.assignee
   WHERE k.status = 'ready' AND a.retired_at IS NULL AND a.runtime NOT IN ('human', 'session') AND NOT a.paused
     AND (p_runtime IS NULL OR a.runtime = p_runtime) AND (p_agent IS NULL OR a.name = p_agent) AND (p_board IS NULL OR k.board_slug = p_board)
     AND (p_task_id IS NULL OR k.id = p_task_id)
     AND NOT EXISTS (SELECT 1 FROM card_runs r WHERE r.card_id = k.id AND r.finished_at IS NULL)
   ORDER BY k.priority, k.created_at FOR UPDATE OF k SKIP LOCKED LIMIT 1;
  IF card.id IS NULL THEN
    RETURN NULL;
  END IF;
  UPDATE cards SET status = 'running', started_at = coalesce(started_at, now()) WHERE id = card.id RETURNING * INTO card;
  INSERT INTO card_runs (card_id, agent_name, runtime, wakeup_id, lease_until)
  SELECT card.id, card.assignee, a.runtime, p_wakeup, now() + make_interval(mins => coalesce(p_lease_minutes, 60)) FROM org_agents_effective a WHERE a.name = card.assignee;
  PERFORM board_event(card.id, 'claimed', coalesce(c.name, card.assignee), json_build_object('agent', card.assignee, 'lease_minutes', coalesce(p_lease_minutes, 60))::jsonb);
  RETURN card;
END
$$;
GRANT EXECUTE ON FUNCTION board_card_claim(text, text, text, integer, text, bigint, text) TO sb_org;

-- Down Migration

DROP FUNCTION IF EXISTS board_card_claim(text, text, text, integer, text, bigint, text);
CREATE OR REPLACE FUNCTION board_card_claim(p_by text, p_runtime text, p_agent text, p_lease_minutes integer, p_board text, p_wakeup bigint DEFAULT NULL, p_task_id text DEFAULT NULL)
RETURNS cards LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE c org_agents; card cards;
BEGIN
  IF p_by IS NOT NULL THEN
    c := board_caller(p_by);
    IF c.runtime <> 'human' AND NOT ('dispatch' = ANY (c.capabilities)) AND p_agent IS DISTINCT FROM c.name THEN
      RAISE EXCEPTION '% can claim only its own cards', c.name;
    END IF;
  ELSIF org_me() IS NOT NULL THEN
    RAISE EXCEPTION 'board: no caller';
  END IF;
  IF p_runtime IS NULL AND p_agent IS NULL THEN RAISE EXCEPTION 'claim needs a runtime or an agent'; END IF;
  IF NOT board_dispatch_enabled(p_board) THEN
    RETURN NULL;
  END IF;
  SELECT k.* INTO card FROM cards k JOIN org_agents a ON a.name = k.assignee
   WHERE k.status = 'ready' AND a.retired_at IS NULL AND a.runtime NOT IN ('human', 'session') AND NOT a.paused
     AND (p_runtime IS NULL OR a.runtime = p_runtime) AND (p_agent IS NULL OR a.name = p_agent) AND (p_board IS NULL OR k.board_slug = p_board)
     AND (p_task_id IS NULL OR k.id = p_task_id)
     AND NOT EXISTS (SELECT 1 FROM card_runs r WHERE r.card_id = k.id AND r.finished_at IS NULL)
   ORDER BY k.priority, k.created_at FOR UPDATE OF k SKIP LOCKED LIMIT 1;
  IF card.id IS NULL THEN
    RETURN NULL;
  END IF;
  UPDATE cards SET status = 'running', started_at = coalesce(started_at, now()) WHERE id = card.id RETURNING * INTO card;
  INSERT INTO card_runs (card_id, agent_name, runtime, wakeup_id, lease_until)
  SELECT card.id, card.assignee, a.runtime, p_wakeup, now() + make_interval(mins => coalesce(p_lease_minutes, 60)) FROM org_agents a WHERE a.name = card.assignee;
  PERFORM board_event(card.id, 'claimed', coalesce(c.name, card.assignee), json_build_object('agent', card.assignee, 'lease_minutes', coalesce(p_lease_minutes, 60))::jsonb);
  RETURN card;
END
$$;
GRANT EXECUTE ON FUNCTION board_card_claim(text, text, text, integer, text, bigint, text) TO sb_org;

CREATE OR REPLACE FUNCTION board_agent_may_claim(p_name text) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce((SELECT NOT paused AND retired_at IS NULL FROM org_agents WHERE name = p_name), false)
$$;
DROP FUNCTION IF EXISTS board_pause_lane(text, text, boolean, text);
DROP FUNCTION IF EXISTS board_clear_override(text, text);
DROP FUNCTION IF EXISTS board_set_override(text, text, text, text, text);
DROP VIEW IF EXISTS org_agents_effective;
DROP TABLE IF EXISTS org_agent_overrides;
