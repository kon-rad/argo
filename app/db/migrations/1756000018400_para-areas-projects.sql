-- Up Migration

-- The PARA rename of the tracker: areas are what you run, projects are what you
-- finish. The table `projects` becomes `areas` and `features` becomes `projects`,
-- so the name `projects` is reused: old code reading it would get finite projects
-- where it expected areas. Hence one cutover (this migration runs in a single
-- transaction, node-pg-migrate's default) and guards that make a stale writer
-- fail instead of writing an area slug into a project column.
--
--   areas     lose stage and due (an area has no end), gain status (active|parked),
--             home_path and archived_at. The free-text `area` column goes: its name
--             collides with the new meaning.
--   projects  keep every column of features, gain outcome (backfilled from title),
--             next_action and archived_at.
--   history   stage_changes is kept verbatim; each area gets one note row that
--             records the stage (and due date) it had, which the down migration
--             reads back.

-- ------------------------------------------------------------------ areas (was projects)

ALTER TABLE projects RENAME TO areas;
ALTER TABLE areas RENAME CONSTRAINT projects_pkey TO areas_pkey;
ALTER TABLE areas RENAME CONSTRAINT projects_slug_check TO areas_slug_check;
ALTER TABLE areas RENAME CONSTRAINT projects_health_check TO areas_health_check;
ALTER TABLE areas RENAME CONSTRAINT projects_priority_check TO areas_priority_check;
ALTER TABLE areas RENAME CONSTRAINT projects_team_slug_fkey TO areas_team_slug_fkey;
ALTER TABLE areas RENAME CONSTRAINT projects_division_slug_fkey TO areas_division_slug_fkey;
ALTER TRIGGER review_lock_projects ON areas RENAME TO review_lock_areas;

-- ------------------------------------------------------------------ projects (was features)

ALTER TABLE features RENAME TO projects;
ALTER TABLE projects RENAME COLUMN project_slug TO area_slug;
ALTER SEQUENCE features_id_seq RENAME TO projects_id_seq;
ALTER TABLE projects RENAME CONSTRAINT features_pkey TO projects_pkey;
ALTER TABLE projects RENAME CONSTRAINT features_slug_check TO projects_slug_check;
ALTER TABLE projects RENAME CONSTRAINT features_stage_check TO projects_stage_check;
ALTER TABLE projects RENAME CONSTRAINT features_health_check TO projects_health_check;
ALTER TABLE projects RENAME CONSTRAINT features_project_slug_fkey TO projects_area_slug_fkey;
ALTER TABLE projects RENAME CONSTRAINT features_project_slug_slug_key TO projects_area_slug_slug_key;
ALTER INDEX features_stage_idx RENAME TO projects_stage_idx;
ALTER TRIGGER review_lock_features ON projects RENAME TO review_lock_projects;

-- ------------------------------------------------------------------ history and evidence

ALTER TABLE stage_changes RENAME COLUMN project_slug TO area_slug;
ALTER TABLE stage_changes RENAME COLUMN feature_id TO project_id;      -- NULL = the area itself
ALTER TABLE stage_changes RENAME CONSTRAINT stage_changes_project_slug_fkey TO stage_changes_area_slug_fkey;
ALTER TABLE stage_changes RENAME CONSTRAINT stage_changes_feature_id_fkey TO stage_changes_project_id_fkey;
ALTER INDEX stage_changes_feature_idx RENAME TO stage_changes_project_idx;

ALTER TABLE verifications RENAME COLUMN feature_id TO project_id;
ALTER TABLE verifications RENAME CONSTRAINT verifications_feature_id_fkey TO verifications_project_id_fkey;
ALTER INDEX verifications_feature_idx RENAME TO verifications_project_idx;

-- ------------------------------------------------------------------ the tables that point at the tracker

ALTER TABLE cards RENAME COLUMN project_slug TO area_slug;
ALTER TABLE cards RENAME COLUMN feature_slug TO project_slug;
ALTER TABLE cards RENAME CONSTRAINT cards_project_slug_fkey TO cards_area_slug_fkey;
ALTER INDEX cards_project_idx RENAME TO cards_area_project_idx;

ALTER TABLE org_messages RENAME COLUMN project_slug TO area_slug;
ALTER TABLE org_messages RENAME COLUMN feature_slug TO project_slug;
ALTER TABLE org_messages RENAME CONSTRAINT org_messages_project_slug_fkey TO org_messages_area_slug_fkey;

-- Shared memory is area-level. The FK stays ON DELETE SET NULL (migration 16100).
ALTER TABLE memory_facts RENAME COLUMN project_slug TO area_slug;
ALTER TABLE memory_facts RENAME CONSTRAINT memory_facts_project_slug_fkey TO memory_facts_area_slug_fkey;

-- The views follow their tables, but keep their own column names until renamed.
ALTER VIEW task_links RENAME COLUMN project_slug TO area_slug;
ALTER VIEW task_links RENAME COLUMN feature_slug TO project_slug;
ALTER VIEW usage_facts RENAME COLUMN project_slug TO area_slug;
ALTER VIEW usage_facts RENAME COLUMN feature_slug TO project_slug;

-- ------------------------------------------------------------------ functions
-- plpgsql bodies are text: every function that names a renamed table or column is
-- written again. The three that take the pair are dropped first, because Postgres
-- cannot rename a parameter in place. p_area and p_project sit in the SAME positions
-- p_project and p_feature had, so an old positional caller still passes the area
-- first and the project second, which is correct.

DROP FUNCTION board_card_assign(text,text,text,text,text,text,text,text);
CREATE OR REPLACE FUNCTION board_card_assign(p_by text, p_card text, p_assignee text, p_area text, p_project text, p_work text, p_needs text, p_repo text)
 RETURNS cards
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $fn$
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
  IF p_area IS NOT NULL AND NOT EXISTS (SELECT 1 FROM areas WHERE slug = p_area) THEN RAISE EXCEPTION 'no area "%" in the tracker (cli-areas list)', p_area; END IF;
  IF p_project IS NOT NULL AND NOT EXISTS (SELECT 1 FROM projects WHERE area_slug = coalesce(p_area, card.area_slug) AND slug = p_project) THEN RAISE EXCEPTION 'no project "%/%" in the tracker (cli-projects list)', coalesce(p_area, card.area_slug), p_project; END IF;
  UPDATE cards SET assignee = p_assignee, area_slug = coalesce(p_area, area_slug),
         project_slug = CASE WHEN p_area IS NOT NULL THEN p_project ELSE coalesce(p_project, project_slug) END,
         work_type = coalesce(p_work, work_type), needs = coalesce(p_needs, needs), repo = coalesce(p_repo, repo)
   WHERE id = p_card RETURNING * INTO card;
  IF card.area_slug IS NOT NULL AND card.project_slug IS NOT NULL AND p_assignee IS NOT NULL AND card.kind IN ('work', 'build') THEN
    UPDATE projects SET owner = p_assignee WHERE area_slug = card.area_slug AND slug = card.project_slug;
  END IF;
  PERFORM board_event(p_card, 'assigned', c.name, json_build_object('assignee', p_assignee, 'repo', p_repo)::jsonb);
  IF card.status = 'ready' THEN PERFORM board_wake(p_card); END IF;
  RETURN card;
END
$fn$;
GRANT EXECUTE ON FUNCTION board_card_assign(text,text,text,text,text,text,text,text) TO sb_org;

DROP FUNCTION board_card_create(text,text,text,text,jsonb,text,text,text,text,text,text,text,integer,text[],text,text,integer,boolean,text,timestamp with time zone);
CREATE OR REPLACE FUNCTION board_card_create(p_by text, p_board text, p_title text, p_body text, p_contract jsonb, p_assignee text, p_area text, p_project text, p_kind text, p_work text, p_needs text, p_repo text, p_priority integer, p_deps text[], p_graph text, p_node text, p_rounds integer, p_ship_now boolean, p_id text DEFAULT NULL::text, p_scheduled timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS cards
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $fn$
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
  IF p_area IS NOT NULL AND NOT EXISTS (SELECT 1 FROM areas WHERE slug = p_area) THEN RAISE EXCEPTION 'no area "%" in the tracker (cli-areas list)', p_area; END IF;
  IF p_project IS NOT NULL AND NOT EXISTS (SELECT 1 FROM projects WHERE area_slug = p_area AND slug = p_project) THEN RAISE EXCEPTION 'no project "%/%" in the tracker (cli-projects list)', p_area, p_project; END IF;
  new_id := coalesce(p_id, board_new_id());
  IF EXISTS (SELECT 1 FROM cards WHERE cards.id = new_id) THEN RAISE EXCEPTION 'card % exists', new_id; END IF;
  FOREACH dep IN ARRAY coalesce(p_deps, '{}') LOOP
    IF NOT EXISTS (SELECT 1 FROM cards WHERE cards.id = dep) THEN RAISE EXCEPTION 'no card % to depend on', dep; END IF;
  END LOOP;
  st := CASE WHEN p_scheduled IS NOT NULL AND p_scheduled > now() THEN 'scheduled'
             WHEN EXISTS (SELECT 1 FROM unnest(coalesce(p_deps, '{}')) d JOIN cards p ON p.id = d WHERE p.status NOT IN ('done', 'archived')) THEN 'todo'
             ELSE 'ready' END;
  INSERT INTO cards (id, board_slug, title, body, contract, status, priority, assignee, created_by, area_slug, project_slug, kind, work_type, needs, ship_now, repo, graph, node, rounds, scheduled_for)
  VALUES (new_id, coalesce(p_board, 'exo'), trim(regexp_replace(p_title, '\s+', ' ', 'g')), nullif(trim(p_body), ''), coalesce(p_contract, '{}'), st, coalesce(p_priority, 3),
          p_assignee, c.name, p_area, p_project, coalesce(p_kind, 'work'), p_work, p_needs, coalesce(p_ship_now, false), p_repo, p_graph, p_node, coalesce(p_rounds, 0), p_scheduled)
  RETURNING * INTO card;
  INSERT INTO card_deps (card_id, depends_on) SELECT new_id, d FROM unnest(coalesce(p_deps, '{}')) d ON CONFLICT DO NOTHING;
  IF p_area IS NOT NULL AND p_project IS NOT NULL AND p_assignee IS NOT NULL AND coalesce(p_kind, 'work') IN ('work', 'build') THEN
    UPDATE projects SET owner = p_assignee WHERE area_slug = p_area AND slug = p_project;
  END IF;
  PERFORM board_event(new_id, 'created', c.name, json_build_object('assignee', p_assignee, 'status', st)::jsonb);
  IF st = 'ready' THEN PERFORM board_wake(new_id); END IF;
  RETURN card;
END
$fn$;
GRANT EXECUTE ON FUNCTION board_card_create(text,text,text,text,jsonb,text,text,text,text,text,text,text,integer,text[],text,text,integer,boolean,text,timestamp with time zone) TO sb_org;

CREATE OR REPLACE FUNCTION board_card_finish(p_by text, p_card text, p_outcome text, p_result text, p_block_kind text, p_verification jsonb, p_tokens bigint, p_turns integer, p_run_id text)
 RETURNS cards
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $fn$
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
  IF p_verification IS NOT NULL AND card.area_slug IS NOT NULL AND card.project_slug IS NOT NULL THEN
    SELECT id INTO fid FROM projects WHERE area_slug = card.area_slug AND slug = card.project_slug;
    IF fid IS NOT NULL THEN
      INSERT INTO verifications (project_id, kind, check_run, result, evidence, by)
      VALUES (fid, coalesce(p_verification ->> 'kind', 'manual'), coalesce(p_verification ->> 'check', 'card ' || p_card),
              CASE WHEN p_verification ->> 'result' = 'fail' THEN 'fail' ELSE 'pass' END, p_verification ->> 'evidence', c.name);
    END IF;
  END IF;
  PERFORM board_event(p_card, CASE WHEN st = 'blocked' THEN 'blocked' ELSE 'finished' END, c.name,
                      json_build_object('outcome', p_outcome, 'result', p_result, 'block_kind', p_block_kind, 'tokens', p_tokens, 'turns', p_turns)::jsonb);
  IF st = 'ready' THEN PERFORM board_wake(p_card); END IF;
  RETURN card;
END
$fn$;

DROP FUNCTION board_card_tag(text,text,text,text);
CREATE OR REPLACE FUNCTION board_card_tag(p_by text, p_card text, p_area text, p_project text)
 RETURNS cards
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $fn$
DECLARE c org_agents; card cards;
BEGIN
  c := board_caller(p_by);
  SELECT * INTO card FROM cards WHERE id = p_card FOR UPDATE;
  IF card.id IS NULL THEN RAISE EXCEPTION 'no card %', p_card; END IF;
  IF c.runtime <> 'human' AND NOT ('dispatch' = ANY (c.capabilities)) AND card.created_by IS DISTINCT FROM c.name AND card.assignee IS DISTINCT FROM c.name THEN
    RAISE EXCEPTION '% can''t tag card %', c.name, p_card;
  END IF;
  IF p_project IS NOT NULL AND p_area IS NULL THEN RAISE EXCEPTION 'a project needs an area'; END IF;
  IF p_area IS NOT NULL AND NOT EXISTS (SELECT 1 FROM areas WHERE slug = p_area) THEN RAISE EXCEPTION 'no area "%" in the tracker (cli-areas list)', p_area; END IF;
  IF p_project IS NOT NULL AND NOT EXISTS (SELECT 1 FROM projects WHERE area_slug = p_area AND slug = p_project) THEN RAISE EXCEPTION 'no project "%/%" in the tracker (cli-projects list)', p_area, p_project; END IF;
  UPDATE cards SET area_slug = p_area, project_slug = p_project WHERE id = p_card RETURNING * INTO card;
  PERFORM board_event(p_card, 'tagged', c.name, json_build_object('area', p_area, 'project', p_project)::jsonb);
  RETURN card;
END
$fn$;
GRANT EXECUTE ON FUNCTION board_card_tag(text,text,text,text) TO sb_org;

CREATE OR REPLACE FUNCTION review_context(p_job bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $fn$
DECLARE j review_jobs; result jsonb;
BEGIN
  PERFORM review_authorize();
  SELECT * INTO STRICT j FROM review_jobs WHERE id=p_job;
  SELECT jsonb_build_object(
    'ticket', (SELECT to_jsonb(c) - 'tsv' - 'updated_at' - 'status' - 'completed_at' - 'block_kind' - 'block_reason' FROM cards c WHERE id=j.card),
    'comments', coalesce((SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM (SELECT * FROM card_comments WHERE card_id=j.card ORDER BY id LIMIT 101) c WHERE NOT EXISTS
      (SELECT 1 FROM review_jobs r WHERE r.card=j.card AND c.author=r.reviewer AND c.body LIKE '[review ' || r.id || ']%')), '[]'::jsonb),
    'dependencies', coalesce((SELECT jsonb_agg(to_jsonb(c) - 'tsv' ORDER BY c.id) FROM (SELECT * FROM card_deps WHERE card_id=j.card ORDER BY depends_on LIMIT 101) d JOIN cards c ON c.id=d.depends_on),'[]'::jsonb),
    'conversations', coalesce((SELECT jsonb_agg(to_jsonb(m) ORDER BY id) FROM (SELECT * FROM org_messages WHERE task_id=j.card OR thread_id IN
      (SELECT coalesce(thread_id,id) FROM org_messages WHERE task_id=j.card) ORDER BY id LIMIT 101) m), '[]'::jsonb),
    'runs', coalesce((SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM (SELECT * FROM card_runs WHERE card_id=j.card ORDER BY id LIMIT 101) r),'[]'::jsonb),
    'earlier_findings', coalesce((SELECT jsonb_agg(jsonb_build_object('round',round,'pr',snapshot->'pr','verdict',left(verdict::text,8000),'truncated',octet_length(verdict::text)>8000) ORDER BY round) FROM (SELECT * FROM review_jobs WHERE card=j.card AND id<j.id ORDER BY round LIMIT 101) history),'[]'::jsonb),
    'area', (SELECT to_jsonb(p) FROM areas p JOIN cards c ON c.area_slug=p.slug WHERE c.id=j.card),
    'project', (SELECT to_jsonb(f) FROM projects f JOIN cards c ON c.area_slug=f.area_slug AND c.project_slug=f.slug WHERE c.id=j.card)
  ) INTO result;
  RETURN result;
END $fn$;

CREATE OR REPLACE FUNCTION review_evidence_lock()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $fn$
DECLARE data jsonb; cid text; ids text[] := '{}'; item text;
BEGIN
  data := CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  IF TG_TABLE_NAME='cards' THEN ids := ARRAY[data->>'id'];
  ELSIF TG_TABLE_NAME IN ('card_comments','card_runs','card_deps') THEN ids := ARRAY[data->>'card_id'];
  ELSIF TG_TABLE_NAME='org_messages' THEN
    ids := ARRAY[data->>'task_id'];
    SELECT array_cat(ids,array_agg(task_id)) INTO ids FROM org_messages
      WHERE id=(data->>'thread_id')::bigint OR thread_id=coalesce((data->>'thread_id')::bigint,(data->>'id')::bigint);
  ELSIF TG_TABLE_NAME='areas' THEN SELECT array_agg(id) INTO ids FROM cards WHERE area_slug=data->>'slug';
  ELSIF TG_TABLE_NAME='projects' THEN SELECT array_agg(id) INTO ids FROM cards WHERE area_slug=data->>'area_slug' AND project_slug=data->>'slug';
  END IF;
  FOR item IN SELECT DISTINCT j.card FROM review_jobs j WHERE
    (j.card=ANY(ids) OR j.card IN (SELECT card_id FROM card_deps WHERE depends_on=ANY(ids))) AND j.state NOT IN ('done','rejected') ORDER BY j.card
  LOOP
    IF NOT pg_try_advisory_xact_lock(hashtextextended('review-content:' || item,0)) THEN
      RAISE EXCEPTION 'review: evidence is locked during review/shipping, retry after worker finishes';
    END IF;
  END LOOP;
  RETURN NULL;
END $fn$;

CREATE OR REPLACE FUNCTION save_summary_memory()
 RETURNS trigger
 LANGUAGE plpgsql
AS $fn$
DECLARE
  summary record;
  existing_id bigint;
  normalized text;
  project text;
BEGIN
  IF NEW.status <> 'proposed' THEN RETURN NEW; END IF;
  normalized := btrim(regexp_replace(NEW.claim, '\s+', ' ', 'g'));
  SELECT s.project, s.host, a.external_id INTO STRICT summary
    FROM agent_summaries s JOIN archive_sessions a ON a.id = s.session_id
    WHERE s.id = NEW.summary_id;
  SELECT slug INTO project FROM areas WHERE slug = summary.project;
  -- Serialise equal scoped claims, including concurrent sessions. Retired facts
  -- count as matches too: rerunning a summarizer must never resurrect a claim.
  PERFORM pg_advisory_xact_lock(hashtextextended(json_build_array(NEW.agent, project, normalized)::text, 0));
  SELECT m.id INTO existing_id FROM memory_facts m
    WHERE m.agent IS NOT DISTINCT FROM NEW.agent
      AND m.area_slug IS NOT DISTINCT FROM project
      AND btrim(regexp_replace(m.claim, '\s+', ' ', 'g')) = normalized
    ORDER BY m.id LIMIT 1;
  IF existing_id IS NULL AND EXISTS (
    SELECT 1 FROM agent_summary_facts f JOIN agent_summaries s ON s.id = f.summary_id
    WHERE f.status = 'rejected' AND f.agent IS NOT DISTINCT FROM NEW.agent
      AND s.project IS NOT DISTINCT FROM summary.project
      AND btrim(regexp_replace(f.claim, '\s+', ' ', 'g')) = normalized
  ) THEN
    NEW.status := 'rejected';
  ELSE
    IF existing_id IS NULL THEN
      INSERT INTO memory_facts (subject, claim, source, author, via, area_slug, agent, confidence)
        VALUES (NEW.subject, normalized,
          left(format('agent-summary:%s (session %s/%s)', NEW.summary_id, summary.host, summary.external_id), 500),
          'summarizer', 'agent-summaries', project, NEW.agent, 'inferred')
        RETURNING id INTO existing_id;
    END IF;
    NEW.status := 'promoted';
    NEW.fact_id := existing_id;
  END IF;
  NEW.decided_by := 'automatic';
  NEW.decided_at := now();
  RETURN NEW;
END;
$fn$;

-- ------------------------------------------------------------------ data
-- The review gate's row triggers take an advisory lock per card under review, and
-- would refuse this migration if a review were open on a linked card. Every table
-- touched below is already locked ACCESS EXCLUSIVE by the renames above, so nothing
-- else can write while the triggers are off; they are back on before the commit.
ALTER TABLE areas DISABLE TRIGGER review_lock_areas;
ALTER TABLE projects DISABLE TRIGGER review_lock_projects;
ALTER TABLE cards DISABLE TRIGGER USER;
ALTER TABLE org_messages DISABLE TRIGGER USER;

-- One note row per area: the stage (and due date) it had, kept in the history and
-- read back by the down migration.
INSERT INTO stage_changes (area_slug, project_id, from_stage, to_stage, by, note)
SELECT slug, NULL, stage, CASE WHEN stage = 'parked' THEN 'parked' ELSE 'active' END, 'migration',
       'para-rename: stage was ' || stage || coalesce(', due ' || to_char(due, 'YYYY-MM-DD'), '')
  FROM areas ORDER BY slug;

-- An area has no end: stage becomes status. Every row that is not parked is active.
ALTER TABLE areas DROP CONSTRAINT projects_stage_check;
ALTER TABLE areas RENAME COLUMN stage TO status;
UPDATE areas SET status = 'active' WHERE status <> 'parked';
ALTER TABLE areas ALTER COLUMN status SET DEFAULT 'active';
ALTER TABLE areas ADD CONSTRAINT areas_status_check CHECK (status IN ('active', 'parked'));
ALTER TABLE areas DROP COLUMN area, DROP COLUMN due;
ALTER TABLE areas ADD COLUMN home_path text, ADD COLUMN archived_at timestamptz;

-- A project is an outcome with an end. The CLI asks for the outcome on new projects.
ALTER TABLE projects ADD COLUMN outcome text, ADD COLUMN next_action text, ADD COLUMN archived_at timestamptz;
UPDATE projects SET outcome = title;

-- Archived rows are hidden from every active view; these serve those views.
CREATE INDEX areas_active_idx ON areas (status) WHERE archived_at IS NULL;
CREATE INDEX projects_active_idx ON projects (area_slug, stage) WHERE archived_at IS NULL;

-- ------------------------------------------------------------------ guards against stale callers
-- The old feature_slug had no foreign key, so a tag may name a feature that is gone
-- (or sit on a row whose project was deleted). Such a tag points at nothing: clear it,
-- or the guards below could not be added.
UPDATE cards c SET project_slug = NULL
 WHERE c.project_slug IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM projects p WHERE p.area_slug = c.area_slug AND p.slug = c.project_slug);
UPDATE org_messages m SET project_slug = NULL
 WHERE m.project_slug IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM projects p WHERE p.area_slug = m.area_slug AND p.slug = m.project_slug);

-- An old caller that still writes an area slug into project_slug alone violates the
-- check; one that writes a pair that is not a project violates the foreign key; one
-- that still names feature_slug hits a missing column. All three are loud.
ALTER TABLE cards
  ADD CONSTRAINT cards_project_needs_area CHECK (project_slug IS NULL OR area_slug IS NOT NULL),
  ADD CONSTRAINT cards_area_project_fkey FOREIGN KEY (area_slug, project_slug)
      REFERENCES projects (area_slug, slug) ON UPDATE CASCADE ON DELETE SET NULL (project_slug);
ALTER TABLE org_messages
  ADD CONSTRAINT org_messages_project_needs_area CHECK (project_slug IS NULL OR area_slug IS NOT NULL),
  ADD CONSTRAINT org_messages_area_project_fkey FOREIGN KEY (area_slug, project_slug)
      REFERENCES projects (area_slug, slug) ON UPDATE CASCADE ON DELETE SET NULL (project_slug);

ALTER TABLE org_messages ENABLE TRIGGER USER;
ALTER TABLE cards ENABLE TRIGGER USER;
ALTER TABLE projects ENABLE TRIGGER review_lock_projects;
ALTER TABLE areas ENABLE TRIGGER review_lock_areas;

-- Deleting an area sets area_slug to NULL on its cards and messages (the old foreign
-- key) and deletes its projects, which clears project_slug (the new one). Postgres
-- does not promise which runs first, and area_slug going first would trip the check.
-- Clearing the project tags before the delete makes the order irrelevant.
CREATE FUNCTION areas_clear_project_tags() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  UPDATE cards SET project_slug = NULL WHERE area_slug = OLD.slug AND project_slug IS NOT NULL;
  UPDATE org_messages SET project_slug = NULL WHERE area_slug = OLD.slug AND project_slug IS NOT NULL;
  RETURN OLD;
END $fn$;
CREATE TRIGGER areas_clear_project_tags BEFORE DELETE ON areas
  FOR EACH ROW EXECUTE FUNCTION areas_clear_project_tags();

-- Down Migration

-- Reverses every rename, restores each area's stage and due date from the note row
-- the up migration wrote (falling back to the newest stage in its history), and drops
-- the columns that have no home in the old schema: outcome, next_action, home_path,
-- archived_at (an archived row becomes visible again). The free-text `area` column
-- comes back empty, as it was. Project tags the up migration cleared stay cleared.

DROP TRIGGER areas_clear_project_tags ON areas;
DROP FUNCTION areas_clear_project_tags();

ALTER TABLE org_messages DROP CONSTRAINT org_messages_area_project_fkey, DROP CONSTRAINT org_messages_project_needs_area;
ALTER TABLE cards DROP CONSTRAINT cards_area_project_fkey, DROP CONSTRAINT cards_project_needs_area;

ALTER VIEW usage_facts RENAME COLUMN project_slug TO feature_slug;
ALTER VIEW usage_facts RENAME COLUMN area_slug TO project_slug;
ALTER VIEW task_links RENAME COLUMN project_slug TO feature_slug;
ALTER VIEW task_links RENAME COLUMN area_slug TO project_slug;

ALTER TABLE memory_facts RENAME CONSTRAINT memory_facts_area_slug_fkey TO memory_facts_project_slug_fkey;
ALTER TABLE memory_facts RENAME COLUMN area_slug TO project_slug;

ALTER TABLE org_messages RENAME CONSTRAINT org_messages_area_slug_fkey TO org_messages_project_slug_fkey;
ALTER TABLE org_messages RENAME COLUMN project_slug TO feature_slug;
ALTER TABLE org_messages RENAME COLUMN area_slug TO project_slug;

ALTER INDEX cards_area_project_idx RENAME TO cards_project_idx;
ALTER TABLE cards RENAME CONSTRAINT cards_area_slug_fkey TO cards_project_slug_fkey;
ALTER TABLE cards RENAME COLUMN project_slug TO feature_slug;
ALTER TABLE cards RENAME COLUMN area_slug TO project_slug;

ALTER INDEX verifications_project_idx RENAME TO verifications_feature_idx;
ALTER TABLE verifications RENAME CONSTRAINT verifications_project_id_fkey TO verifications_feature_id_fkey;
ALTER TABLE verifications RENAME COLUMN project_id TO feature_id;

ALTER INDEX stage_changes_project_idx RENAME TO stage_changes_feature_idx;
ALTER TABLE stage_changes RENAME CONSTRAINT stage_changes_project_id_fkey TO stage_changes_feature_id_fkey;
ALTER TABLE stage_changes RENAME CONSTRAINT stage_changes_area_slug_fkey TO stage_changes_project_slug_fkey;
ALTER TABLE stage_changes RENAME COLUMN project_id TO feature_id;
ALTER TABLE stage_changes RENAME COLUMN area_slug TO project_slug;

-- projects back to features
DROP INDEX projects_active_idx;
DROP INDEX areas_active_idx;
ALTER TABLE projects DROP COLUMN outcome, DROP COLUMN next_action, DROP COLUMN archived_at;
ALTER TRIGGER review_lock_projects ON projects RENAME TO review_lock_features;
ALTER INDEX projects_stage_idx RENAME TO features_stage_idx;
ALTER TABLE projects RENAME CONSTRAINT projects_area_slug_slug_key TO features_project_slug_slug_key;
ALTER TABLE projects RENAME CONSTRAINT projects_area_slug_fkey TO features_project_slug_fkey;
ALTER TABLE projects RENAME CONSTRAINT projects_health_check TO features_health_check;
ALTER TABLE projects RENAME CONSTRAINT projects_stage_check TO features_stage_check;
ALTER TABLE projects RENAME CONSTRAINT projects_slug_check TO features_slug_check;
ALTER TABLE projects RENAME CONSTRAINT projects_pkey TO features_pkey;
ALTER SEQUENCE projects_id_seq RENAME TO features_id_seq;
ALTER TABLE projects RENAME COLUMN area_slug TO project_slug;
ALTER TABLE projects RENAME TO features;

-- areas back to projects
ALTER TABLE areas DISABLE TRIGGER review_lock_areas;
ALTER TABLE areas DROP CONSTRAINT areas_status_check;
ALTER TABLE areas ALTER COLUMN status DROP DEFAULT;
ALTER TABLE areas RENAME COLUMN status TO stage;
ALTER TABLE areas DROP COLUMN home_path, DROP COLUMN archived_at;
ALTER TABLE areas ADD COLUMN area text, ADD COLUMN due date;
UPDATE areas a SET
  stage = CASE WHEN a.stage = 'parked' THEN 'parked' ELSE coalesce(
    (SELECT s.from_stage FROM stage_changes s
      WHERE s.project_slug = a.slug AND s.feature_id IS NULL AND s.by = 'migration' AND s.note LIKE 'para-rename: stage was %'
        AND s.from_stage IN ('idea', 'designing', 'building', 'testing', 'live', 'done')
      ORDER BY s.id DESC LIMIT 1),
    (SELECT s.to_stage FROM stage_changes s
      WHERE s.project_slug = a.slug AND s.feature_id IS NULL
        AND s.to_stage IN ('idea', 'designing', 'building', 'testing', 'live', 'done')
      ORDER BY s.at DESC, s.id DESC LIMIT 1),
    'building') END,
  due = (SELECT substring(s.note FROM 'due (\d{4}-\d{2}-\d{2})')::date FROM stage_changes s
          WHERE s.project_slug = a.slug AND s.feature_id IS NULL AND s.by = 'migration' AND s.note LIKE 'para-rename: stage was %'
          ORDER BY s.id DESC LIMIT 1);
DELETE FROM stage_changes WHERE feature_id IS NULL AND by = 'migration' AND note LIKE 'para-rename: stage was %';
ALTER TABLE areas ADD CONSTRAINT projects_stage_check
  CHECK (stage IN ('idea', 'designing', 'building', 'testing', 'live', 'parked', 'done'));
ALTER TABLE areas ENABLE TRIGGER review_lock_areas;
ALTER TRIGGER review_lock_areas ON areas RENAME TO review_lock_projects;
ALTER TABLE areas RENAME CONSTRAINT areas_division_slug_fkey TO projects_division_slug_fkey;
ALTER TABLE areas RENAME CONSTRAINT areas_team_slug_fkey TO projects_team_slug_fkey;
ALTER TABLE areas RENAME CONSTRAINT areas_priority_check TO projects_priority_check;
ALTER TABLE areas RENAME CONSTRAINT areas_health_check TO projects_health_check;
ALTER TABLE areas RENAME CONSTRAINT areas_slug_check TO projects_slug_check;
ALTER TABLE areas RENAME CONSTRAINT areas_pkey TO projects_pkey;
ALTER TABLE areas RENAME TO projects;

-- The functions as they were before this migration.

DROP FUNCTION board_card_assign(text,text,text,text,text,text,text,text);
CREATE OR REPLACE FUNCTION board_card_assign(p_by text, p_card text, p_assignee text, p_project text, p_feature text, p_work text, p_needs text, p_repo text)
 RETURNS cards
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $fn$
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
         work_type = coalesce(p_work, work_type), needs = coalesce(p_needs, needs), repo = coalesce(p_repo, repo)
   WHERE id = p_card RETURNING * INTO card;
  IF card.project_slug IS NOT NULL AND card.feature_slug IS NOT NULL AND p_assignee IS NOT NULL AND card.kind IN ('work', 'build') THEN
    UPDATE features SET owner = p_assignee WHERE project_slug = card.project_slug AND slug = card.feature_slug;
  END IF;
  PERFORM board_event(p_card, 'assigned', c.name, json_build_object('assignee', p_assignee, 'repo', p_repo)::jsonb);
  IF card.status = 'ready' THEN PERFORM board_wake(p_card); END IF;
  RETURN card;
END
$fn$;
GRANT EXECUTE ON FUNCTION board_card_assign(text,text,text,text,text,text,text,text) TO sb_org;

DROP FUNCTION board_card_create(text,text,text,text,jsonb,text,text,text,text,text,text,text,integer,text[],text,text,integer,boolean,text,timestamp with time zone);
CREATE OR REPLACE FUNCTION board_card_create(p_by text, p_board text, p_title text, p_body text, p_contract jsonb, p_assignee text, p_project text, p_feature text, p_kind text, p_work text, p_needs text, p_repo text, p_priority integer, p_deps text[], p_graph text, p_node text, p_rounds integer, p_ship_now boolean, p_id text DEFAULT NULL::text, p_scheduled timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS cards
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $fn$
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
$fn$;
GRANT EXECUTE ON FUNCTION board_card_create(text,text,text,text,jsonb,text,text,text,text,text,text,text,integer,text[],text,text,integer,boolean,text,timestamp with time zone) TO sb_org;

CREATE OR REPLACE FUNCTION board_card_finish(p_by text, p_card text, p_outcome text, p_result text, p_block_kind text, p_verification jsonb, p_tokens bigint, p_turns integer, p_run_id text)
 RETURNS cards
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $fn$
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
$fn$;

DROP FUNCTION board_card_tag(text,text,text,text);
CREATE OR REPLACE FUNCTION board_card_tag(p_by text, p_card text, p_project text, p_feature text)
 RETURNS cards
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $fn$
DECLARE c org_agents; card cards;
BEGIN
  c := board_caller(p_by);
  SELECT * INTO card FROM cards WHERE id = p_card FOR UPDATE;
  IF card.id IS NULL THEN RAISE EXCEPTION 'no card %', p_card; END IF;
  IF c.runtime <> 'human' AND NOT ('dispatch' = ANY (c.capabilities)) AND card.created_by IS DISTINCT FROM c.name AND card.assignee IS DISTINCT FROM c.name THEN
    RAISE EXCEPTION '% can''t tag card %', c.name, p_card;
  END IF;
  IF p_feature IS NOT NULL AND p_project IS NULL THEN RAISE EXCEPTION 'a feature needs a project'; END IF;
  IF p_project IS NOT NULL AND NOT EXISTS (SELECT 1 FROM projects WHERE slug = p_project) THEN RAISE EXCEPTION 'no project "%" in the tracker (cli-projects list)', p_project; END IF;
  IF p_feature IS NOT NULL AND NOT EXISTS (SELECT 1 FROM features WHERE project_slug = p_project AND slug = p_feature) THEN RAISE EXCEPTION 'no feature "%/%" in the tracker', p_project, p_feature; END IF;
  UPDATE cards SET project_slug = p_project, feature_slug = p_feature WHERE id = p_card RETURNING * INTO card;
  PERFORM board_event(p_card, 'tagged', c.name, json_build_object('project', p_project, 'feature', p_feature)::jsonb);
  RETURN card;
END
$fn$;
GRANT EXECUTE ON FUNCTION board_card_tag(text,text,text,text) TO sb_org;

CREATE OR REPLACE FUNCTION review_context(p_job bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $fn$
DECLARE j review_jobs; result jsonb;
BEGIN
  PERFORM review_authorize();
  SELECT * INTO STRICT j FROM review_jobs WHERE id=p_job;
  SELECT jsonb_build_object(
    'ticket', (SELECT to_jsonb(c) - 'tsv' - 'updated_at' - 'status' - 'completed_at' - 'block_kind' - 'block_reason' FROM cards c WHERE id=j.card),
    'comments', coalesce((SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM (SELECT * FROM card_comments WHERE card_id=j.card ORDER BY id LIMIT 101) c WHERE NOT EXISTS
      (SELECT 1 FROM review_jobs r WHERE r.card=j.card AND c.author=r.reviewer AND c.body LIKE '[review ' || r.id || ']%')), '[]'::jsonb),
    'dependencies', coalesce((SELECT jsonb_agg(to_jsonb(c) - 'tsv' ORDER BY c.id) FROM (SELECT * FROM card_deps WHERE card_id=j.card ORDER BY depends_on LIMIT 101) d JOIN cards c ON c.id=d.depends_on),'[]'::jsonb),
    'conversations', coalesce((SELECT jsonb_agg(to_jsonb(m) ORDER BY id) FROM (SELECT * FROM org_messages WHERE task_id=j.card OR thread_id IN
      (SELECT coalesce(thread_id,id) FROM org_messages WHERE task_id=j.card) ORDER BY id LIMIT 101) m), '[]'::jsonb),
    'runs', coalesce((SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM (SELECT * FROM card_runs WHERE card_id=j.card ORDER BY id LIMIT 101) r),'[]'::jsonb),
    'earlier_findings', coalesce((SELECT jsonb_agg(jsonb_build_object('round',round,'pr',snapshot->'pr','verdict',left(verdict::text,8000),'truncated',octet_length(verdict::text)>8000) ORDER BY round) FROM (SELECT * FROM review_jobs WHERE card=j.card AND id<j.id ORDER BY round LIMIT 101) history),'[]'::jsonb),
    'project', (SELECT to_jsonb(p) FROM projects p JOIN cards c ON c.project_slug=p.slug WHERE c.id=j.card),
    'feature', (SELECT to_jsonb(f) FROM features f JOIN cards c ON c.project_slug=f.project_slug AND c.feature_slug=f.slug WHERE c.id=j.card)
  ) INTO result;
  RETURN result;
END $fn$;

CREATE OR REPLACE FUNCTION review_evidence_lock()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $fn$
DECLARE data jsonb; cid text; ids text[] := '{}'; item text;
BEGIN
  data := CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  IF TG_TABLE_NAME='cards' THEN ids := ARRAY[data->>'id'];
  ELSIF TG_TABLE_NAME IN ('card_comments','card_runs','card_deps') THEN ids := ARRAY[data->>'card_id'];
  ELSIF TG_TABLE_NAME='org_messages' THEN
    ids := ARRAY[data->>'task_id'];
    SELECT array_cat(ids,array_agg(task_id)) INTO ids FROM org_messages
      WHERE id=(data->>'thread_id')::bigint OR thread_id=coalesce((data->>'thread_id')::bigint,(data->>'id')::bigint);
  ELSIF TG_TABLE_NAME='projects' THEN SELECT array_agg(id) INTO ids FROM cards WHERE project_slug=data->>'slug';
  ELSIF TG_TABLE_NAME='features' THEN SELECT array_agg(id) INTO ids FROM cards WHERE project_slug=data->>'project_slug' AND feature_slug=data->>'slug';
  END IF;
  FOR item IN SELECT DISTINCT j.card FROM review_jobs j WHERE
    (j.card=ANY(ids) OR j.card IN (SELECT card_id FROM card_deps WHERE depends_on=ANY(ids))) AND j.state NOT IN ('done','rejected') ORDER BY j.card
  LOOP
    IF NOT pg_try_advisory_xact_lock(hashtextextended('review-content:' || item,0)) THEN
      RAISE EXCEPTION 'review: evidence is locked during review/shipping, retry after worker finishes';
    END IF;
  END LOOP;
  RETURN NULL;
END $fn$;

CREATE OR REPLACE FUNCTION save_summary_memory()
 RETURNS trigger
 LANGUAGE plpgsql
AS $fn$
DECLARE
  summary record;
  existing_id bigint;
  normalized text;
  project text;
BEGIN
  IF NEW.status <> 'proposed' THEN RETURN NEW; END IF;
  normalized := btrim(regexp_replace(NEW.claim, '\s+', ' ', 'g'));
  SELECT s.project, s.host, a.external_id INTO STRICT summary
    FROM agent_summaries s JOIN archive_sessions a ON a.id = s.session_id
    WHERE s.id = NEW.summary_id;
  SELECT slug INTO project FROM projects WHERE slug = summary.project;
  -- Serialise equal scoped claims, including concurrent sessions. Retired facts
  -- count as matches too: rerunning a summarizer must never resurrect a claim.
  PERFORM pg_advisory_xact_lock(hashtextextended(json_build_array(NEW.agent, project, normalized)::text, 0));
  SELECT m.id INTO existing_id FROM memory_facts m
    WHERE m.agent IS NOT DISTINCT FROM NEW.agent
      AND m.project_slug IS NOT DISTINCT FROM project
      AND btrim(regexp_replace(m.claim, '\s+', ' ', 'g')) = normalized
    ORDER BY m.id LIMIT 1;
  IF existing_id IS NULL AND EXISTS (
    SELECT 1 FROM agent_summary_facts f JOIN agent_summaries s ON s.id = f.summary_id
    WHERE f.status = 'rejected' AND f.agent IS NOT DISTINCT FROM NEW.agent
      AND s.project IS NOT DISTINCT FROM summary.project
      AND btrim(regexp_replace(f.claim, '\s+', ' ', 'g')) = normalized
  ) THEN
    NEW.status := 'rejected';
  ELSE
    IF existing_id IS NULL THEN
      INSERT INTO memory_facts (subject, claim, source, author, via, project_slug, agent, confidence)
        VALUES (NEW.subject, normalized,
          left(format('agent-summary:%s (session %s/%s)', NEW.summary_id, summary.host, summary.external_id), 500),
          'summarizer', 'agent-summaries', project, NEW.agent, 'inferred')
        RETURNING id INTO existing_id;
    END IF;
    NEW.status := 'promoted';
    NEW.fact_id := existing_id;
  END IF;
  NEW.decided_by := 'automatic';
  NEW.decided_at := now();
  RETURN NEW;
END;
$fn$;
