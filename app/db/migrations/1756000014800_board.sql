-- Up Migration

-- The board (board module): the kanban record moves into the engine. Design: docs/board-design.md.
--
-- Cards, comments, events, dependencies and runs live here next to the tracker and the org; whatever runs the
-- work (Hermes, a Claude Code dispatcher, zen-agent) is a lane that claims, heartbeats and finishes through the
-- board_* functions. Every write is a SECURITY DEFINER function that checks org_me() against the caller it is
-- told, enforces one rule, appends a card_events row and notifies 'board'. task_links (the old link rows) is
-- folded into cards and kept as a view so usage_facts and the ship approvals keep their join.

-- Lanes and the vault session are roster rows too, so every assignee and author has a foreign key.
ALTER TABLE org_agents DROP CONSTRAINT org_agents_runtime_check;
ALTER TABLE org_agents ADD CONSTRAINT org_agents_runtime_check
  CHECK (runtime IN ('claude-code','hermes','codex','zen-agent','session','human'));

CREATE TABLE boards (
  slug        text PRIMARY KEY CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,40}$'),
  name        text NOT NULL,
  team_slug   text REFERENCES teams(slug) ON UPDATE CASCADE ON DELETE SET NULL,   -- NULL: the company board
  created_at  timestamptz NOT NULL DEFAULT now()
);
INSERT INTO boards (slug, name) VALUES ('exo', 'Exo');

CREATE TABLE cards (
  id            text PRIMARY KEY CHECK (id ~ '^t_[0-9a-f]{6,32}$'),
  board_slug    text NOT NULL REFERENCES boards(slug) ON UPDATE CASCADE,
  title         text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  body          text CHECK (length(body) <= 20000),
  contract      jsonb NOT NULL DEFAULT '{}',
  status        text NOT NULL DEFAULT 'todo' CHECK (status IN ('triage','todo','scheduled','ready','running','review','blocked','done','archived')),
  priority      smallint NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 5),
  assignee      text REFERENCES org_agents(name) ON UPDATE CASCADE,
  created_by    text NOT NULL REFERENCES org_agents(name) ON UPDATE CASCADE,
  project_slug  text REFERENCES projects(slug) ON UPDATE CASCADE ON DELETE SET NULL,
  feature_slug  text,
  kind          text NOT NULL DEFAULT 'work' CHECK (kind IN ('work','spec','build','review','verify','doc','status','improve','revert')),
  work_type     text CHECK (work_type IN ('research','coding','design','media','writing','sales','education','ops')),
  needs         text CHECK (needs IN ('code','review','merge','deploy','m1','web')),
  ship_now      boolean NOT NULL DEFAULT false,
  repo          text,
  graph         text,
  node          text,
  rounds        integer NOT NULL DEFAULT 0,
  scheduled_for timestamptz,
  block_kind    text CHECK (block_kind IN ('dependency','needs-owner','missing-input','tool-error','budget','review-changes','other')),
  block_reason  text,
  result        text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  started_at    timestamptz,
  completed_at  timestamptz,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  tsv           tsvector GENERATED ALWAYS AS (to_tsvector('simple', title || ' ' || coalesce(body, ''))) STORED
);
CREATE INDEX cards_board_status_idx ON cards (board_slug, status, priority, created_at);
CREATE INDEX cards_assignee_idx     ON cards (assignee) WHERE status NOT IN ('done','archived');
CREATE INDEX cards_project_idx      ON cards (project_slug, feature_slug);
CREATE INDEX cards_tsv_idx          ON cards USING gin (tsv);

CREATE TABLE card_comments (
  id          bigserial PRIMARY KEY,
  card_id     text NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  author      text NOT NULL REFERENCES org_agents(name) ON UPDATE CASCADE,
  body        text NOT NULL CHECK (length(body) BETWEEN 1 AND 8000),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX card_comments_card_idx ON card_comments (card_id, id);

-- Append-only; only the functions write it. actor NULL: the board itself (promotion, reclaim).
CREATE TABLE card_events (
  id          bigserial PRIMARY KEY,
  card_id     text NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  kind        text NOT NULL,
  actor       text REFERENCES org_agents(name) ON UPDATE CASCADE,
  payload     jsonb,
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX card_events_card_idx ON card_events (card_id, id);

-- card_id waits for depends_on.
CREATE TABLE card_deps (
  card_id     text NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  depends_on  text NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  PRIMARY KEY (card_id, depends_on),
  CHECK (card_id <> depends_on)
);
CREATE INDEX card_deps_on_idx ON card_deps (depends_on);

-- One claim of a card by a lane: a lease that heartbeats extend, an outcome when it ends.
CREATE TABLE card_runs (
  id            bigserial PRIMARY KEY,
  card_id       text NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  agent_name    text NOT NULL REFERENCES org_agents(name) ON UPDATE CASCADE,
  runtime       text NOT NULL,
  wakeup_id     bigint REFERENCES org_wakeups(id) ON DELETE SET NULL,
  run_id        text,
  claimed_at    timestamptz NOT NULL DEFAULT now(),
  lease_until   timestamptz NOT NULL,
  heartbeat_at  timestamptz,
  finished_at   timestamptz,
  outcome       text CHECK (outcome IN ('done','blocked','partial','lost','budget')),
  tokens        bigint,
  turns         integer
);
CREATE UNIQUE INDEX card_runs_open_idx ON card_runs (card_id) WHERE finished_at IS NULL;
CREATE INDEX card_runs_agent_idx ON card_runs (agent_name, claimed_at DESC);

-- A device or agent process that reaches the board over HTTPS as one roster member. Only the hash is stored.
CREATE TABLE board_tokens (
  id            bigserial PRIMARY KEY,
  agent_name    text NOT NULL REFERENCES org_agents(name) ON UPDATE CASCADE ON DELETE CASCADE,
  label         text,
  token_hash    text NOT NULL UNIQUE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz,
  revoked_at    timestamptz
);

-- ---- the old link rows become cards ------------------------------------------------------------------
-- Assignees and creators the roster does not know (the vault session, a lane) get a roster row so the keys hold.
INSERT INTO org_agents (name, runtime, role, org_version)
SELECT DISTINCT n, 'session', 'imported with the board (task_links)', 'board-migration'
  FROM (SELECT assignee AS n FROM task_links UNION SELECT created_by FROM task_links) x
 WHERE n ~ '^[a-z0-9][a-z0-9-]{0,31}$' AND NOT EXISTS (SELECT 1 FROM org_agents a WHERE a.name = x.n);
INSERT INTO boards (slug, name)
SELECT DISTINCT board, initcap(board) FROM task_links WHERE board ~ '^[a-z0-9][a-z0-9-]{0,40}$' ON CONFLICT DO NOTHING;
INSERT INTO cards (id, board_slug, title, status, assignee, created_by, project_slug, feature_slug, kind, work_type, needs, ship_now, graph, node, rounds, created_at)
SELECT t.task_id, t.board, left(t.title, 200), 'todo', t.assignee, t.created_by,
       CASE WHEN EXISTS (SELECT 1 FROM projects p WHERE p.slug = t.project_slug) THEN t.project_slug END,
       t.feature_slug, CASE WHEN t.kind IN ('work','spec','build','review','verify','doc','status') THEN t.kind ELSE 'work' END,
       t.work_type, t.needs, t.ship_now, t.graph, t.node, t.rounds, t.created_at
  FROM task_links t
  JOIN org_agents a ON a.name = t.assignee JOIN org_agents c ON c.name = t.created_by JOIN boards b ON b.slug = t.board;

DROP FUNCTION IF EXISTS org_task_link(text, text, text, text, text, text, text, text, text, text, integer, text);
DROP FUNCTION IF EXISTS org_task_link(text, text, text, text, text, text, text, text, text, text, integer);
DROP FUNCTION IF EXISTS org_task_link(text, text, text, text, text, text, text);
DROP VIEW usage_facts;
DROP TABLE task_links;
CREATE VIEW task_links AS
  SELECT id AS task_id, board_slug AS board, title, project_slug, feature_slug, assignee, created_by, rounds, created_at,
         graph, node, kind, work_type, ship_now, needs
    FROM cards WHERE assignee IS NOT NULL;
GRANT SELECT ON task_links TO sb_org;
CREATE OR REPLACE VIEW usage_facts AS
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

-- ---- helpers ------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION cards_touch() RETURNS trigger AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END
$$ LANGUAGE plpgsql;
CREATE TRIGGER cards_touch BEFORE UPDATE ON cards FOR EACH ROW EXECUTE FUNCTION cards_touch();

CREATE OR REPLACE FUNCTION board_new_id() RETURNS text LANGUAGE sql VOLATILE AS $$
  SELECT 't_' || substr(md5(random()::text || clock_timestamp()::text), 1, 8)
$$;

-- The caller: p_by must be the connection's identity when there is one, and a live roster row.
CREATE OR REPLACE FUNCTION board_caller(p_by text) RETURNS org_agents
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE a org_agents;
BEGIN
  IF p_by IS NULL THEN RAISE EXCEPTION 'board: no caller'; END IF;
  IF org_me() IS NOT NULL AND org_me() <> p_by THEN RAISE EXCEPTION 'board: caller is %, not %', org_me(), p_by; END IF;
  SELECT * INTO a FROM org_agents WHERE name = p_by;
  IF a.name IS NULL THEN RAISE EXCEPTION 'unknown agent "%"', p_by; END IF;
  IF a.retired_at IS NOT NULL THEN RAISE EXCEPTION 'agent "%" is retired', p_by; END IF;
  RETURN a;
END
$$;

CREATE OR REPLACE FUNCTION board_is_lead(p_name text) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM teams WHERE lead = p_name)
$$;

-- Who may give whom a card: a human anyone; `dispatch` any bot; a lead its own team; a member only itself.
-- The vault session (runtime session) takes cards from a human, a lead or dispatch.
CREATE OR REPLACE FUNCTION board_may_assign(c org_agents, t org_agents) RETURNS void LANGUAGE plpgsql STABLE AS $$
BEGIN
  IF t.runtime = 'human' THEN RAISE EXCEPTION '% is not a bot; cards go to bots on the roster', t.name; END IF;
  IF c.runtime = 'human' OR c.name = t.name OR 'dispatch' = ANY (c.capabilities) THEN RETURN; END IF;
  IF t.runtime = 'session' THEN
    IF board_is_lead(c.name) THEN RETURN; END IF;
    RAISE EXCEPTION '% can''t give the vault session a card: leads do; ask your lead', c.name;
  END IF;
  IF c.team_slug IS NOT NULL AND c.team_slug = t.team_slug AND board_is_lead(c.name) THEN RETURN; END IF;
  RAISE EXCEPTION '% can''t give % a card: a lead assigns inside its team, a member only to itself; ask your lead or hand off on the board', c.name, t.name;
END
$$;

-- A card goes only to a bot that has the tools for it; the refusal names the bots that do.
CREATE OR REPLACE FUNCTION board_assert_capable(t org_agents, p_need text) RETURNS void LANGUAGE plpgsql STABLE AS $$
DECLARE who text;
BEGIN
  IF p_need IS NULL OR t.runtime = 'session' OR p_need = ANY (t.capabilities) THEN RETURN; END IF;
  SELECT string_agg(name, ', ' ORDER BY name) INTO who FROM org_agents WHERE p_need = ANY (capabilities) AND retired_at IS NULL AND runtime <> 'human';
  RAISE EXCEPTION '% doesn''t have the % capability this card needs; give it to %', t.name, p_need, coalesce(who, 'nobody yet (add it in org.yaml)');
END
$$;

CREATE OR REPLACE FUNCTION board_event(p_card text, p_kind text, p_actor text, p_payload jsonb) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE b text;
BEGIN
  INSERT INTO card_events (card_id, kind, actor, payload) VALUES (p_card, p_kind, p_actor, p_payload);
  SELECT board_slug INTO b FROM cards WHERE id = p_card;
  PERFORM pg_notify('board', json_build_object('card', p_card, 'kind', p_kind, 'board', b)::text);
END
$$;

-- A ready card wakes its lane's bot once (reason task, ref card id). Humans and the vault session wake nobody.
-- A card that woke its bot more than twice in 24 h without finishing waits for a person (the hold).
CREATE OR REPLACE FUNCTION board_wake(p_card text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE c cards; a org_agents; runs integer;
BEGIN
  SELECT * INTO c FROM cards WHERE id = p_card;
  IF c.assignee IS NULL THEN RETURN; END IF;
  SELECT * INTO a FROM org_agents WHERE name = c.assignee;
  IF a.runtime IN ('human', 'session') OR a.retired_at IS NOT NULL THEN RETURN; END IF;
  SELECT count(*) INTO runs FROM org_wakeups WHERE agent_name = a.name AND reason = 'task' AND ref = p_card AND done_at > now() - interval '24 hours';
  IF runs > 2 THEN RETURN; END IF;
  INSERT INTO org_wakeups (agent_name, reason, ref) VALUES (a.name, 'task', p_card)
  ON CONFLICT (agent_name, reason, ref) WHERE done_at IS NULL DO NOTHING;
END
$$;

-- todo (or blocked on a dependency) → ready, once nothing open is ahead of it and its time has come.
CREATE OR REPLACE FUNCTION board_promote(p_card text) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE c cards;
BEGIN
  SELECT * INTO c FROM cards WHERE id = p_card FOR UPDATE;
  IF c.id IS NULL THEN RETURN false; END IF;
  IF NOT (c.status IN ('todo', 'scheduled') OR (c.status = 'blocked' AND c.block_kind = 'dependency')) THEN RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM card_deps d JOIN cards p ON p.id = d.depends_on WHERE d.card_id = p_card AND p.status NOT IN ('done', 'archived')) THEN RETURN false; END IF;
  IF c.scheduled_for IS NOT NULL AND c.scheduled_for > now() THEN RETURN false; END IF;
  UPDATE cards SET status = 'ready', block_kind = NULL, block_reason = NULL WHERE id = p_card;
  PERFORM board_event(p_card, 'moved', NULL, json_build_object('from', c.status, 'to', 'ready', 'why', 'promoted')::jsonb);
  PERFORM board_wake(p_card);
  RETURN true;
END
$$;

-- A finished card lets its dependants through.
CREATE OR REPLACE FUNCTION cards_promote_dependants() RETURNS trigger AS $$
DECLARE d record;
BEGIN
  IF NEW.status IN ('done', 'archived') AND OLD.status NOT IN ('done', 'archived') THEN
    FOR d IN SELECT card_id FROM card_deps WHERE depends_on = NEW.id LOOP PERFORM board_promote(d.card_id); END LOOP;
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
CREATE TRIGGER cards_promote_dependants AFTER UPDATE OF status ON cards FOR EACH ROW EXECUTE FUNCTION cards_promote_dependants();

-- ---- the write path -----------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION board_card_create(
  p_by text, p_board text, p_title text, p_body text, p_contract jsonb, p_assignee text, p_project text, p_feature text,
  p_kind text, p_work text, p_needs text, p_repo text, p_priority integer, p_deps text[], p_graph text, p_node text,
  p_rounds integer, p_ship_now boolean, p_id text DEFAULT NULL, p_scheduled timestamptz DEFAULT NULL)
RETURNS cards LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE c org_agents; t org_agents; card cards; new_id text; st text; dep text;
BEGIN
  c := board_caller(p_by);
  -- Boards come into being on first use, as they did on the Hermes board.
  IF coalesce(p_board, 'exo') !~ '^[a-z0-9][a-z0-9-]{0,40}$' THEN RAISE EXCEPTION 'bad board name "%"', p_board; END IF;
  INSERT INTO boards (slug, name) VALUES (coalesce(p_board, 'exo'), initcap(coalesce(p_board, 'exo'))) ON CONFLICT DO NOTHING;
  IF p_assignee IS NOT NULL THEN
    SELECT * INTO t FROM org_agents WHERE name = p_assignee AND retired_at IS NULL;
    IF t.name IS NULL THEN RAISE EXCEPTION 'unknown agent "%"; run cli-org agents for the roster', p_assignee; END IF;
    -- A reviewer may open a new round for the builder of a card it reviews (cli-org task redo); otherwise the give-rule.
    IF NOT (coalesce(p_rounds, 0) > 0 AND EXISTS (SELECT 1 FROM cards r JOIN card_deps d ON d.card_id = r.id JOIN cards b ON b.id = d.depends_on
                                                   WHERE r.assignee = c.name AND r.kind = 'review' AND b.assignee = t.name)) THEN
      PERFORM board_may_assign(c, t);
    END IF;
    PERFORM board_assert_capable(t, p_needs);
  END IF;
  IF coalesce(p_ship_now, false) AND c.runtime <> 'human' THEN RAISE EXCEPTION 'only the owner can mark a card ship-now'; END IF;
  IF p_project IS NOT NULL AND NOT EXISTS (SELECT 1 FROM projects WHERE slug = p_project) THEN RAISE EXCEPTION 'no project "%" in the tracker (cli-projects list)', p_project; END IF;
  IF p_feature IS NOT NULL AND NOT EXISTS (SELECT 1 FROM features WHERE project_slug = p_project AND slug = p_feature) THEN RAISE EXCEPTION 'no feature "%/%" in the tracker', p_project, p_feature; END IF;
  new_id := coalesce(p_id, board_new_id());
  IF EXISTS (SELECT 1 FROM cards WHERE cards.id = new_id) THEN RAISE EXCEPTION 'card % exists', new_id; END IF;
  FOREACH dep IN ARRAY coalesce(p_deps, '{}') LOOP
    IF NOT EXISTS (SELECT 1 FROM cards WHERE cards.id = dep) THEN RAISE EXCEPTION 'no card % to depend on', dep; END IF;
  END LOOP;
  st := CASE WHEN p_scheduled IS NOT NULL AND p_scheduled > now() THEN 'scheduled'
             WHEN EXISTS (SELECT 1 FROM unnest(coalesce(p_deps, '{}')) d JOIN cards p ON p.id = d WHERE p.status NOT IN ('done', 'archived')) THEN 'todo'
             ELSE 'ready' END;
  INSERT INTO cards (id, board_slug, title, body, contract, status, priority, assignee, created_by, project_slug, feature_slug, kind, work_type, needs, ship_now, repo, graph, node, rounds, scheduled_for)
  VALUES (new_id, coalesce(p_board, 'exo'), trim(regexp_replace(p_title, '\s+', ' ', 'g')), nullif(trim(p_body), ''), coalesce(p_contract, '{}'), st, coalesce(p_priority, 3),
          p_assignee, c.name, p_project, p_feature, coalesce(p_kind, 'work'), p_work, p_needs, coalesce(p_ship_now, false), p_repo, p_graph, p_node, coalesce(p_rounds, 0), p_scheduled)
  RETURNING * INTO card;
  INSERT INTO card_deps (card_id, depends_on) SELECT new_id, d FROM unnest(coalesce(p_deps, '{}')) d ON CONFLICT DO NOTHING;
  IF p_project IS NOT NULL AND p_feature IS NOT NULL AND p_assignee IS NOT NULL AND coalesce(p_kind, 'work') IN ('work', 'build') THEN
    UPDATE features SET owner = p_assignee WHERE project_slug = p_project AND slug = p_feature;
  END IF;
  PERFORM board_event(new_id, 'created', c.name, json_build_object('assignee', p_assignee, 'status', st)::jsonb);
  IF st = 'ready' THEN PERFORM board_wake(new_id); END IF;
  RETURN card;
END
$$;

CREATE OR REPLACE FUNCTION board_card_assign(p_by text, p_card text, p_assignee text, p_project text, p_feature text, p_work text, p_needs text)
RETURNS cards LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE c org_agents; t org_agents; card cards;
BEGIN
  c := board_caller(p_by);
  SELECT * INTO card FROM cards WHERE id = p_card FOR UPDATE;
  IF card.id IS NULL THEN RAISE EXCEPTION 'no card %', p_card; END IF;
  IF card.status IN ('done', 'archived') THEN RAISE EXCEPTION 'card % is %; give a new card instead', p_card, card.status; END IF;
  IF card.status = 'running' THEN RAISE EXCEPTION 'card % is running; wait for the worker or reclaim it first', p_card; END IF;
  IF p_assignee IS NOT NULL THEN
    SELECT * INTO t FROM org_agents WHERE name = p_assignee AND retired_at IS NULL;
    IF t.name IS NULL THEN RAISE EXCEPTION 'unknown agent "%"; run cli-org agents for the roster', p_assignee; END IF;
    PERFORM board_may_assign(c, t);
    PERFORM board_assert_capable(t, coalesce(p_needs, card.needs));
  ELSIF c.runtime <> 'human' AND NOT ('dispatch' = ANY (c.capabilities)) AND card.assignee IS DISTINCT FROM c.name THEN
    RAISE EXCEPTION '% can''t unassign %''s card', c.name, card.assignee;
  END IF;
  IF p_project IS NOT NULL AND NOT EXISTS (SELECT 1 FROM projects WHERE slug = p_project) THEN RAISE EXCEPTION 'no project "%" in the tracker (cli-projects list)', p_project; END IF;
  IF p_feature IS NOT NULL AND NOT EXISTS (SELECT 1 FROM features WHERE project_slug = coalesce(p_project, card.project_slug) AND slug = p_feature) THEN RAISE EXCEPTION 'no feature "%/%" in the tracker', coalesce(p_project, card.project_slug), p_feature; END IF;
  UPDATE cards SET assignee = p_assignee, project_slug = coalesce(p_project, project_slug),
         feature_slug = CASE WHEN p_project IS NOT NULL THEN p_feature ELSE coalesce(p_feature, feature_slug) END,
         work_type = coalesce(p_work, work_type), needs = coalesce(p_needs, needs)
   WHERE id = p_card RETURNING * INTO card;
  IF card.project_slug IS NOT NULL AND card.feature_slug IS NOT NULL AND p_assignee IS NOT NULL AND card.kind IN ('work', 'build') THEN
    UPDATE features SET owner = p_assignee WHERE project_slug = card.project_slug AND slug = card.feature_slug;
  END IF;
  PERFORM board_event(p_card, 'assigned', c.name, json_build_object('assignee', p_assignee)::jsonb);
  IF card.status = 'ready' THEN PERFORM board_wake(p_card); END IF;
  RETURN card;
END
$$;

CREATE OR REPLACE FUNCTION board_card_comment(p_by text, p_card text, p_body text)
RETURNS card_comments LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE c org_agents; r card_comments;
BEGIN
  c := board_caller(p_by);
  IF NOT EXISTS (SELECT 1 FROM cards WHERE id = p_card) THEN RAISE EXCEPTION 'no card %', p_card; END IF;
  INSERT INTO card_comments (card_id, author, body) VALUES (p_card, c.name, trim(p_body)) RETURNING * INTO r;
  PERFORM board_event(p_card, 'commented', c.name, json_build_object('comment', r.id)::jsonb);
  RETURN r;
END
$$;

-- A person moves a card anywhere but into running (claim) or done from a bot's side; a bot moves only its own
-- card, and never to done or archived (finish is the path). The vault session takes its card with move running.
CREATE OR REPLACE FUNCTION board_card_move(p_by text, p_card text, p_status text, p_note text)
RETURNS cards LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE c org_agents; card cards; was text;
BEGIN
  c := board_caller(p_by);
  SELECT * INTO card FROM cards WHERE id = p_card FOR UPDATE;
  IF card.id IS NULL THEN RAISE EXCEPTION 'no card %', p_card; END IF;
  IF c.runtime <> 'human' AND NOT ('dispatch' = ANY (c.capabilities)) THEN
    IF card.assignee IS DISTINCT FROM c.name THEN RAISE EXCEPTION '% can''t move %''s card', c.name, card.assignee; END IF;
    IF p_status IN ('done', 'archived') THEN RAISE EXCEPTION 'finish the card (cli-board finish) instead of moving it to %', p_status; END IF;
  END IF;
  IF card.status = 'running' AND p_status <> 'running' AND EXISTS (SELECT 1 FROM card_runs WHERE card_id = p_card AND finished_at IS NULL) THEN
    UPDATE card_runs SET finished_at = now(), outcome = 'partial' WHERE card_id = p_card AND finished_at IS NULL;
  END IF;
  was := card.status;
  UPDATE cards SET status = p_status,
         started_at = CASE WHEN p_status = 'running' THEN coalesce(started_at, now()) ELSE started_at END,
         completed_at = CASE WHEN p_status = 'done' THEN coalesce(completed_at, now()) ELSE completed_at END,
         block_kind = CASE WHEN p_status = 'blocked' THEN coalesce(block_kind, 'other') WHEN p_status IN ('ready', 'todo', 'running', 'done') THEN NULL ELSE block_kind END,
         block_reason = CASE WHEN p_status = 'blocked' THEN coalesce(p_note, block_reason) WHEN p_status IN ('ready', 'todo', 'running', 'done') THEN NULL ELSE block_reason END
   WHERE id = p_card RETURNING * INTO card;
  PERFORM board_event(p_card, 'moved', c.name, json_build_object('from', was, 'to', p_status, 'note', p_note)::jsonb);
  IF p_status = 'ready' THEN PERFORM board_wake(p_card); END IF;
  RETURN card;
END
$$;

-- The next ready card for a lane: for one agent, or any agent of a runtime; by priority, then age. Contention-safe.
-- The caller is the owner's process (no identity), a human, a bot with dispatch, or the agent taking its own card.
CREATE OR REPLACE FUNCTION board_card_claim(p_by text, p_runtime text, p_agent text, p_lease_minutes integer, p_board text, p_wakeup bigint DEFAULT NULL)
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
  SELECT k.* INTO card FROM cards k JOIN org_agents a ON a.name = k.assignee
   WHERE k.status = 'ready' AND a.retired_at IS NULL AND a.runtime NOT IN ('human', 'session')
     AND (p_runtime IS NULL OR a.runtime = p_runtime) AND (p_agent IS NULL OR a.name = p_agent) AND (p_board IS NULL OR k.board_slug = p_board)
     AND NOT EXISTS (SELECT 1 FROM card_runs r WHERE r.card_id = k.id AND r.finished_at IS NULL)
   ORDER BY k.priority, k.created_at FOR UPDATE OF k SKIP LOCKED LIMIT 1;
  IF card.id IS NULL THEN RETURN NULL; END IF;
  UPDATE cards SET status = 'running', started_at = coalesce(started_at, now()) WHERE id = card.id RETURNING * INTO card;
  INSERT INTO card_runs (card_id, agent_name, runtime, wakeup_id, lease_until)
  SELECT card.id, card.assignee, a.runtime, p_wakeup, now() + make_interval(mins => coalesce(p_lease_minutes, 60)) FROM org_agents a WHERE a.name = card.assignee;
  PERFORM board_event(card.id, 'claimed', coalesce(c.name, card.assignee), json_build_object('agent', card.assignee, 'lease_minutes', coalesce(p_lease_minutes, 60))::jsonb);
  RETURN card;
END
$$;

CREATE OR REPLACE FUNCTION board_card_heartbeat(p_by text, p_card text, p_tokens bigint, p_turns integer, p_lease_minutes integer)
RETURNS card_runs LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE c org_agents; r card_runs;
BEGIN
  c := board_caller(p_by);
  SELECT * INTO r FROM card_runs WHERE card_id = p_card AND finished_at IS NULL FOR UPDATE;
  IF r.id IS NULL THEN RAISE EXCEPTION 'card % has no live run', p_card; END IF;
  IF c.runtime <> 'human' AND NOT ('dispatch' = ANY (c.capabilities)) AND r.agent_name <> c.name THEN RAISE EXCEPTION 'run % is %''s', r.id, r.agent_name; END IF;
  UPDATE card_runs SET heartbeat_at = now(), lease_until = now() + make_interval(mins => coalesce(p_lease_minutes, 60)),
         tokens = coalesce(p_tokens, tokens), turns = coalesce(p_turns, turns) WHERE id = r.id RETURNING * INTO r;
  PERFORM board_event(p_card, 'heartbeat', c.name, json_build_object('tokens', p_tokens, 'turns', p_turns)::jsonb);
  RETURN r;
END
$$;

-- The assignee (or a human) ends the card: done with its result, blocked with a kind, partial (back to ready),
-- budget (blocked, kind budget). A verification {kind, check, result, evidence} writes the feature's verifications row.
CREATE OR REPLACE FUNCTION board_card_finish(p_by text, p_card text, p_outcome text, p_result text, p_block_kind text, p_verification jsonb,
                                             p_tokens bigint, p_turns integer, p_run_id text)
RETURNS cards LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE c org_agents; card cards; st text; fid bigint;
BEGIN
  c := board_caller(p_by);
  SELECT * INTO card FROM cards WHERE id = p_card FOR UPDATE;
  IF card.id IS NULL THEN RAISE EXCEPTION 'no card %', p_card; END IF;
  IF card.status IN ('done', 'archived') THEN RAISE EXCEPTION 'card % is already %', p_card, card.status; END IF;
  IF c.runtime <> 'human' AND NOT ('dispatch' = ANY (c.capabilities)) AND card.assignee IS DISTINCT FROM c.name THEN
    RAISE EXCEPTION '% can''t finish %''s card', c.name, card.assignee;
  END IF;
  IF p_outcome NOT IN ('done', 'blocked', 'partial', 'budget') THEN RAISE EXCEPTION 'outcome is done, blocked, partial or budget, not %', p_outcome; END IF;
  IF p_outcome = 'blocked' AND p_block_kind IS NULL THEN RAISE EXCEPTION 'a blocked card says why: --blocked <kind> "<reason>"'; END IF;
  st := CASE p_outcome WHEN 'done' THEN 'done' WHEN 'partial' THEN 'ready' ELSE 'blocked' END;
  UPDATE card_runs SET finished_at = now(), outcome = p_outcome, tokens = coalesce(p_tokens, tokens), turns = coalesce(p_turns, turns), run_id = coalesce(p_run_id, run_id)
   WHERE card_id = p_card AND finished_at IS NULL;
  -- The wake this card made is answered: a dispatcher that still calls wake-done finds nothing left to close.
  UPDATE org_wakeups SET done_at = now(), result = coalesce(result, 'card ' || p_outcome) WHERE reason = 'task' AND ref = p_card AND done_at IS NULL;
  UPDATE cards SET status = st,
         result = CASE WHEN p_outcome = 'done' THEN coalesce(p_result, result) ELSE result END,
         completed_at = CASE WHEN p_outcome = 'done' THEN now() ELSE completed_at END,
         block_kind = CASE WHEN st = 'blocked' THEN coalesce(p_block_kind, 'budget') ELSE NULL END,
         block_reason = CASE WHEN st = 'blocked' THEN p_result ELSE NULL END
   WHERE id = p_card RETURNING * INTO card;
  IF p_verification IS NOT NULL AND card.project_slug IS NOT NULL AND card.feature_slug IS NOT NULL THEN
    SELECT id INTO fid FROM features WHERE project_slug = card.project_slug AND slug = card.feature_slug;
    IF fid IS NOT NULL THEN
      INSERT INTO verifications (feature_id, kind, check_run, result, evidence, by)
      VALUES (fid, coalesce(p_verification ->> 'kind', 'manual'), coalesce(p_verification ->> 'check', 'card ' || p_card),
              CASE WHEN p_verification ->> 'result' = 'fail' THEN 'fail' ELSE 'pass' END, p_verification ->> 'evidence', c.name);
    END IF;
  END IF;
  PERFORM board_event(p_card, CASE WHEN st = 'blocked' THEN 'blocked' ELSE 'finished' END, c.name,
                      json_build_object('outcome', p_outcome, 'result', p_result, 'block_kind', p_block_kind, 'tokens', p_tokens, 'turns', p_turns)::jsonb);
  IF st = 'ready' THEN PERFORM board_wake(p_card); END IF;
  RETURN card;
END
$$;

-- card waits for depends_on. No cycles; a ready card with a new open dependency goes back to todo.
CREATE OR REPLACE FUNCTION board_card_link(p_by text, p_card text, p_depends_on text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE c org_agents; card cards; dep cards;
BEGIN
  c := board_caller(p_by);
  SELECT * INTO card FROM cards WHERE id = p_card FOR UPDATE;
  SELECT * INTO dep FROM cards WHERE id = p_depends_on;
  IF card.id IS NULL THEN RAISE EXCEPTION 'no card %', p_card; END IF;
  IF dep.id IS NULL THEN RAISE EXCEPTION 'no card %', p_depends_on; END IF;
  IF p_card = p_depends_on THEN RAISE EXCEPTION 'a card can''t wait for itself'; END IF;
  IF EXISTS (WITH RECURSIVE up AS (SELECT depends_on FROM card_deps WHERE card_id = p_depends_on
                                   UNION SELECT d.depends_on FROM card_deps d JOIN up ON d.card_id = up.depends_on)
             SELECT 1 FROM up WHERE depends_on = p_card) THEN
    RAISE EXCEPTION 'linking % after % would make a cycle', p_card, p_depends_on;
  END IF;
  INSERT INTO card_deps (card_id, depends_on) VALUES (p_card, p_depends_on) ON CONFLICT DO NOTHING;
  IF card.status = 'ready' AND dep.status NOT IN ('done', 'archived') THEN
    UPDATE cards SET status = 'todo' WHERE id = p_card;
    PERFORM board_event(p_card, 'moved', c.name, json_build_object('from', 'ready', 'to', 'todo', 'why', 'waits for ' || p_depends_on)::jsonb);
  END IF;
  PERFORM board_event(p_card, 'linked', c.name, json_build_object('depends_on', p_depends_on)::jsonb);
END
$$;

-- ship_now only from a human (or the owner's own connection); needs from whoever may give the card.
CREATE OR REPLACE FUNCTION board_card_flags(p_by text, p_card text, p_ship_now boolean, p_needs text)
RETURNS cards LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE c org_agents; card cards;
BEGIN
  c := board_caller(p_by);
  SELECT * INTO card FROM cards WHERE id = p_card FOR UPDATE;
  IF card.id IS NULL THEN RAISE EXCEPTION 'no card %', p_card; END IF;
  IF coalesce(p_ship_now, false) AND c.runtime <> 'human' THEN RAISE EXCEPTION 'only the owner can mark a card ship-now'; END IF;
  IF c.runtime <> 'human' AND card.created_by <> c.name AND NOT ('dispatch' = ANY (c.capabilities)) THEN RAISE EXCEPTION '% didn''t give card %', c.name, p_card; END IF;
  UPDATE cards SET ship_now = coalesce(p_ship_now, ship_now), needs = coalesce(p_needs, needs) WHERE id = p_card RETURNING * INTO card;
  PERFORM board_event(p_card, 'flagged', c.name, json_build_object('ship_now', p_ship_now, 'needs', p_needs)::jsonb);
  RETURN card;
END
$$;

-- Runs past their lease with no heartbeat are lost: the card goes back to ready. Scheduled cards whose time has
-- come are promoted. For a timer; cheap.
CREATE OR REPLACE FUNCTION board_reclaim() RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r record; n integer := 0;
BEGIN
  FOR r IN SELECT id, card_id FROM card_runs WHERE finished_at IS NULL AND lease_until < now() FOR UPDATE SKIP LOCKED LOOP
    UPDATE card_runs SET finished_at = now(), outcome = 'lost' WHERE id = r.id;
    UPDATE cards SET status = 'ready' WHERE id = r.card_id AND status = 'running';
    PERFORM board_event(r.card_id, 'reclaimed', NULL, json_build_object('run', r.id)::jsonb);
    PERFORM board_wake(r.card_id);
    n := n + 1;
  END LOOP;
  FOR r IN SELECT id FROM cards WHERE status = 'scheduled' AND scheduled_for <= now() LOOP
    IF board_promote(r.id) THEN n := n + 1; END IF;
  END LOOP;
  RETURN n;
END
$$;

-- The old flag function keeps its name for callers that have it; the rule now lives in board_card_flags.
CREATE OR REPLACE FUNCTION org_task_flags(p_task text, p_ship_now boolean, p_needs text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE who text;
BEGIN
  who := coalesce(org_me(), (SELECT created_by FROM cards WHERE id = p_task));
  IF who IS NULL THEN RETURN; END IF;
  PERFORM board_card_flags(who, p_task, p_ship_now, p_needs);
END
$$;

-- ---- the agents' view: every member reads the company boards and its team's; nobody writes but the functions ----

GRANT SELECT ON boards, cards, card_comments, card_events, card_deps, card_runs TO sb_org;
GRANT EXECUTE ON FUNCTION board_card_create(text, text, text, text, jsonb, text, text, text, text, text, text, text, integer, text[], text, text, integer, boolean, text, timestamptz) TO sb_org;
GRANT EXECUTE ON FUNCTION board_card_assign(text, text, text, text, text, text, text) TO sb_org;
GRANT EXECUTE ON FUNCTION board_card_comment(text, text, text) TO sb_org;
GRANT EXECUTE ON FUNCTION board_card_move(text, text, text, text) TO sb_org;
GRANT EXECUTE ON FUNCTION board_card_claim(text, text, text, integer, text, bigint) TO sb_org;
GRANT EXECUTE ON FUNCTION board_card_heartbeat(text, text, bigint, integer, integer) TO sb_org;
GRANT EXECUTE ON FUNCTION board_card_finish(text, text, text, text, text, jsonb, bigint, integer, text) TO sb_org;
GRANT EXECUTE ON FUNCTION board_card_link(text, text, text) TO sb_org;
GRANT EXECUTE ON FUNCTION board_card_flags(text, text, boolean, text) TO sb_org;
GRANT EXECUTE ON FUNCTION board_caller(text) TO sb_org;

CREATE OR REPLACE FUNCTION board_visible(p_board text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT org_me() IS NULL
      OR EXISTS (SELECT 1 FROM org_agents a WHERE a.name = org_me() AND a.runtime = 'human')
      OR EXISTS (SELECT 1 FROM boards b WHERE b.slug = p_board
                   AND (b.team_slug IS NULL OR b.team_slug = (SELECT team_slug FROM org_agents WHERE name = org_me())))
$$;

ALTER TABLE boards        ENABLE ROW LEVEL SECURITY;
ALTER TABLE cards         ENABLE ROW LEVEL SECURITY;
ALTER TABLE card_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE card_events   ENABLE ROW LEVEL SECURITY;
ALTER TABLE card_deps     ENABLE ROW LEVEL SECURITY;
ALTER TABLE card_runs     ENABLE ROW LEVEL SECURITY;
CREATE POLICY boards_read        ON boards        FOR SELECT TO sb_org USING (board_visible(slug));
CREATE POLICY cards_read         ON cards         FOR SELECT TO sb_org USING (board_visible(board_slug));
CREATE POLICY card_comments_read ON card_comments FOR SELECT TO sb_org USING (EXISTS (SELECT 1 FROM cards c WHERE c.id = card_id AND board_visible(c.board_slug)));
CREATE POLICY card_events_read   ON card_events   FOR SELECT TO sb_org USING (EXISTS (SELECT 1 FROM cards c WHERE c.id = card_id AND board_visible(c.board_slug)));
CREATE POLICY card_deps_read     ON card_deps     FOR SELECT TO sb_org USING (EXISTS (SELECT 1 FROM cards c WHERE c.id = card_id AND board_visible(c.board_slug)));
CREATE POLICY card_runs_read     ON card_runs     FOR SELECT TO sb_org USING (EXISTS (SELECT 1 FROM cards c WHERE c.id = card_id AND board_visible(c.board_slug)));

-- Down Migration

DROP POLICY card_runs_read ON card_runs;
DROP POLICY card_deps_read ON card_deps;
DROP POLICY card_events_read ON card_events;
DROP POLICY card_comments_read ON card_comments;
DROP POLICY cards_read ON cards;
DROP POLICY boards_read ON boards;
DROP FUNCTION board_visible(text);
REVOKE ALL ON boards, cards, card_comments, card_events, card_deps, card_runs FROM sb_org;
DROP FUNCTION board_reclaim();
DROP FUNCTION board_card_flags(text, text, boolean, text);
DROP FUNCTION board_card_link(text, text, text);
DROP FUNCTION board_card_finish(text, text, text, text, text, jsonb, bigint, integer, text);
DROP FUNCTION board_card_heartbeat(text, text, bigint, integer, integer);
DROP FUNCTION board_card_claim(text, text, text, integer, text, bigint);
DROP FUNCTION board_card_move(text, text, text, text);
DROP FUNCTION board_card_comment(text, text, text);
DROP FUNCTION board_card_assign(text, text, text, text, text, text, text);
DROP FUNCTION board_card_create(text, text, text, text, jsonb, text, text, text, text, text, text, text, integer, text[], text, text, integer, boolean, text, timestamptz);
DROP TRIGGER cards_promote_dependants ON cards;
DROP FUNCTION cards_promote_dependants();
DROP FUNCTION board_promote(text);
DROP FUNCTION board_wake(text);
DROP FUNCTION board_event(text, text, text, jsonb);
DROP FUNCTION board_assert_capable(org_agents, text);
DROP FUNCTION board_may_assign(org_agents, org_agents);
DROP FUNCTION board_is_lead(text);
DROP FUNCTION board_caller(text);
DROP FUNCTION board_new_id();
DROP TRIGGER cards_touch ON cards;
DROP FUNCTION cards_touch();
DROP VIEW usage_facts;
DROP VIEW task_links;
CREATE TABLE task_links (
  task_id       text PRIMARY KEY CHECK (task_id ~ '^t_[0-9a-f]{6,32}$'),
  board         text NOT NULL,
  title         text NOT NULL,
  project_slug  text REFERENCES projects(slug) ON UPDATE CASCADE ON DELETE SET NULL,
  feature_slug  text,
  assignee      text NOT NULL,
  created_by    text NOT NULL,
  rounds        integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  graph         text,
  node          text,
  kind          text NOT NULL DEFAULT 'work',
  work_type     text CHECK (work_type IN ('research', 'coding', 'design', 'media', 'writing', 'sales', 'education', 'ops')),
  ship_now      boolean NOT NULL DEFAULT false,
  needs         text CHECK (needs IN ('code','review','merge','deploy','m1','web'))
);
INSERT INTO task_links (task_id, board, title, project_slug, feature_slug, assignee, created_by, rounds, created_at, graph, node, kind, work_type, ship_now, needs)
SELECT id, board_slug, title, project_slug, feature_slug, assignee, created_by, rounds, created_at, graph, node, kind, work_type, ship_now, needs FROM cards WHERE assignee IS NOT NULL;
GRANT SELECT ON task_links TO sb_org;
ALTER TABLE task_links ENABLE ROW LEVEL SECURITY;
CREATE POLICY task_links_read ON task_links FOR SELECT TO sb_org USING (true);
CREATE OR REPLACE VIEW usage_facts AS
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
DROP TABLE board_tokens;
DROP TABLE card_runs;
DROP TABLE card_deps;
DROP TABLE card_events;
DROP TABLE card_comments;
DROP TABLE cards;
DROP TABLE boards;
ALTER TABLE org_agents DROP CONSTRAINT org_agents_runtime_check;
ALTER TABLE org_agents ADD CONSTRAINT org_agents_runtime_check CHECK (runtime IN ('claude-code','hermes','codex','human'));
-- org_task_link is not recreated on the way down; the 12600/12800 bodies can be re-run by hand.
