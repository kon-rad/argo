-- Up Migration

-- Bot powers and shared memory (vault: Areas/argo/second-brain/agent-company/bot-powers-and-shared-memory-design.md).
--
-- 1. org_agents.capabilities: what a bot may do beyond the board (code, review, merge, deploy, m1, web). Written only by
--    `cli-org import`; the git, deploy and M1 wrappers read it, so a bot that edits a vault file can't widen its powers.
-- 2. task_links.ship_now / needs: a card the owner marked to ship without asking, and the capability a card needs.
-- 3. org_approvals: one row per "may this ship?" question; only a human decides.
-- 4. memory_facts: shared, sourced, time-bounded claims every runtime can recall.
-- 5. The wake trigger: status and reply posts wake nobody, and one bot wakes another at most 3 times a day.

ALTER TABLE org_agents ADD COLUMN capabilities text[] NOT NULL DEFAULT '{}'
  CHECK (capabilities <@ ARRAY['code','review','merge','deploy','m1','web']::text[]);

ALTER TABLE task_links ADD COLUMN ship_now boolean NOT NULL DEFAULT false;
ALTER TABLE task_links ADD COLUMN needs text CHECK (needs IN ('code','review','merge','deploy','m1','web'));

-- Flags on a link: ship_now only from a human (or the owner's own connection), needs from whoever made the link.
CREATE OR REPLACE FUNCTION org_task_flags(p_task text, p_ship_now boolean, p_needs text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  caller_human boolean := org_me() IS NULL OR EXISTS (SELECT 1 FROM org_agents WHERE name = org_me() AND runtime = 'human');
BEGIN
  IF coalesce(p_ship_now, false) AND NOT caller_human THEN
    RAISE EXCEPTION 'only the owner can mark a card ship-now';
  END IF;
  UPDATE task_links SET ship_now = coalesce(p_ship_now, ship_now), needs = coalesce(p_needs, needs)
   WHERE task_id = p_task AND (caller_human OR created_by = org_me());
END
$$;
GRANT EXECUTE ON FUNCTION org_task_flags(text, boolean, text) TO sb_org;

CREATE TABLE org_approvals (
  id            bigserial PRIMARY KEY,
  task_id       text NOT NULL,
  pr_url        text,
  deploy_target text,
  summary       text NOT NULL CHECK (length(summary) BETWEEN 1 AND 2000),
  requested_by  text NOT NULL REFERENCES org_agents(name),
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied')),
  ship_now      boolean NOT NULL DEFAULT false,
  decided_by    text REFERENCES org_agents(name),
  decided_at    timestamptz,
  note          text,
  message_id    bigint REFERENCES org_messages(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX org_approvals_task_idx ON org_approvals (task_id);
CREATE INDEX org_approvals_pending_idx ON org_approvals (created_at) WHERE status = 'pending';

ALTER TABLE org_approvals ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON org_approvals TO sb_org;
CREATE POLICY org_approvals_read ON org_approvals FOR SELECT TO sb_org USING (true);

-- A request: always as the caller. A ship-now card is approved on the spot (the owner already said so on the card).
CREATE OR REPLACE FUNCTION org_ship_request(p_task text, p_pr text, p_target text, p_summary text, p_by text)
RETURNS org_approvals LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  now_ok boolean;
  r org_approvals;
BEGIN
  IF org_me() IS NOT NULL AND org_me() <> p_by THEN
    RAISE EXCEPTION 'ship request: caller is %, not %', org_me(), p_by;
  END IF;
  SELECT coalesce(bool_or(ship_now), false) INTO now_ok FROM task_links WHERE task_id = p_task;
  INSERT INTO org_approvals (task_id, pr_url, deploy_target, summary, requested_by, status, ship_now, decided_by, decided_at, note)
  VALUES (p_task, p_pr, p_target, p_summary, p_by,
          CASE WHEN now_ok THEN 'approved' ELSE 'pending' END, now_ok,
          CASE WHEN now_ok THEN (SELECT created_by FROM task_links WHERE task_id = p_task) END,
          CASE WHEN now_ok THEN now() END,
          CASE WHEN now_ok THEN 'ship-now card' END)
  RETURNING * INTO r;
  RETURN r;
END
$$;
GRANT EXECUTE ON FUNCTION org_ship_request(text, text, text, text, text) TO sb_org;

-- Only a human decides. The requester is woken with the answer.
CREATE OR REPLACE FUNCTION org_ship_decide(p_id bigint, p_approve boolean, p_by text, p_note text)
RETURNS org_approvals LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  r org_approvals;
BEGIN
  IF org_me() IS NOT NULL AND org_me() <> p_by THEN
    RAISE EXCEPTION 'ship decide: caller is %, not %', org_me(), p_by;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM org_agents WHERE name = p_by AND runtime = 'human') THEN
    RAISE EXCEPTION 'only the owner approves shipping (% is a bot)', p_by;
  END IF;
  UPDATE org_approvals SET status = CASE WHEN p_approve THEN 'approved' ELSE 'denied' END,
         decided_by = p_by, decided_at = now(), note = p_note
   WHERE id = p_id AND status = 'pending'
  RETURNING * INTO r;
  IF r.id IS NULL THEN
    RAISE EXCEPTION 'no pending approval %', p_id;
  END IF;
  INSERT INTO org_wakeups (agent_name, reason, ref) VALUES (r.requested_by, 'owner', 'ship:' || r.id)
  ON CONFLICT (agent_name, reason, ref) WHERE done_at IS NULL DO NOTHING;
  RETURN r;
END
$$;
GRANT EXECUTE ON FUNCTION org_ship_decide(bigint, boolean, text, text) TO sb_org;

CREATE OR REPLACE FUNCTION org_ship_set_message(p_id bigint, p_message bigint)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE org_approvals SET message_id = p_message WHERE id = p_id AND (org_me() IS NULL OR requested_by = org_me())
$$;
GRANT EXECUTE ON FUNCTION org_ship_set_message(bigint, bigint) TO sb_org;

-- Shared memory. A fact is a claim with a source and an author; it is closed (valid_to), never deleted.
CREATE TABLE memory_facts (
  id           bigserial PRIMARY KEY,
  subject      text NOT NULL CHECK (length(subject) BETWEEN 1 AND 200),
  claim        text NOT NULL CHECK (length(claim) BETWEEN 1 AND 1000),
  source       text NOT NULL CHECK (length(source) BETWEEN 1 AND 500),
  author       text NOT NULL,
  via          text,
  project_slug text REFERENCES projects(slug) ON UPDATE CASCADE,
  confidence   text NOT NULL DEFAULT 'confirmed' CHECK (confidence IN ('confirmed','inferred')),
  supersedes   bigint REFERENCES memory_facts(id),
  valid_from   timestamptz NOT NULL DEFAULT now(),
  valid_to     timestamptz,
  retired_by   text,
  retired_why  text,
  tsv          tsvector GENERATED ALWAYS AS (to_tsvector('english', subject || ' ' || claim)) STORED
);
CREATE INDEX memory_facts_tsv_idx ON memory_facts USING gin (tsv);
CREATE INDEX memory_facts_current_idx ON memory_facts (subject) WHERE valid_to IS NULL;

ALTER TABLE memory_facts ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON memory_facts TO sb_org;
GRANT USAGE, SELECT ON SEQUENCE memory_facts_id_seq TO sb_org;
CREATE POLICY memory_facts_read ON memory_facts FOR SELECT TO sb_org USING (true);
CREATE POLICY memory_facts_write ON memory_facts FOR INSERT TO sb_org WITH CHECK (author = org_me());

-- Close a fact: its author, the author's lead, or a human. Superseding closes the old fact the same way.
CREATE OR REPLACE FUNCTION memory_fact_retire(p_id bigint, p_by text, p_why text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  f memory_facts;
BEGIN
  IF org_me() IS NOT NULL AND org_me() <> p_by THEN
    RAISE EXCEPTION 'forget: caller is %, not %', org_me(), p_by;
  END IF;
  SELECT * INTO f FROM memory_facts WHERE id = p_id;
  IF f.id IS NULL THEN RAISE EXCEPTION 'no fact %', p_id; END IF;
  IF f.valid_to IS NOT NULL THEN RETURN; END IF;
  IF NOT (f.author = p_by
          OR EXISTS (SELECT 1 FROM org_agents WHERE name = p_by AND runtime = 'human')
          OR EXISTS (SELECT 1 FROM org_agents a JOIN teams t ON t.slug = a.team_slug WHERE a.name = f.author AND t.lead = p_by)) THEN
    RAISE EXCEPTION '% can''t close fact % (only its author, the author''s lead or the owner)', p_by, p_id;
  END IF;
  UPDATE memory_facts SET valid_to = now(), retired_by = p_by, retired_why = p_why WHERE id = p_id;
END
$$;
GRANT EXECUTE ON FUNCTION memory_fact_retire(bigint, text, text) TO sb_org;

-- How many times today this bot has woken that one through the board. Humans are never capped.
CREATE OR REPLACE FUNCTION org_bot_wakes_today(p_from text, p_to text) RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT count(*)::int FROM org_wakeups w JOIN org_messages m ON m.id::text = w.ref
   WHERE w.agent_name = p_to AND m.author = p_from AND w.reason IN ('dm','mention','handoff')
     AND w.created_at > now() - interval '1 day'
$$;

-- The wake trigger: as before (DM recipient, handoff target and its lead, mentioned members), plus two rules that stop
-- wakes nobody needs: a `status` or `reply` wakes nobody (it is read on the next real wake), and a bot wakes the same
-- bot at most 3 times in 24 hours (later messages still arrive).
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

-- Down Migration

DROP FUNCTION org_bot_wakes_today(text, text);
DROP FUNCTION memory_fact_retire(bigint, text, text);
DROP TABLE memory_facts;
DROP FUNCTION org_ship_set_message(bigint, bigint);
DROP FUNCTION org_ship_decide(bigint, boolean, text, text);
DROP FUNCTION org_ship_request(text, text, text, text, text);
DROP TABLE org_approvals;
DROP FUNCTION org_task_flags(text, boolean, text);
ALTER TABLE task_links DROP COLUMN needs;
ALTER TABLE task_links DROP COLUMN ship_now;
ALTER TABLE org_agents DROP COLUMN capabilities;
-- The trigger function keeps the new rules on the way down; the 13300 migration's body can be re-run by hand.
