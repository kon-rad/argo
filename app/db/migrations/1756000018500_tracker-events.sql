-- Up Migration

-- Change history for areas and projects: one append-only log, written by triggers, so no
-- writer (CLI, API, a bot through the board functions, psql) can forget to log.
--
--   tracker_events  one row per changed column of `areas` and `projects`, plus one row per
--                   insert, per frontmatter key the scanner saw change on a home note, and
--                   per KPI reading. Who and how come from two transaction settings the
--                   writer sets: app.actor and app.source ('unknown' when unset). app.note
--                   carries the writer's --note onto the rows of that transaction.
--   stage_changes   was a table the application wrote next to each stage change. Its rows
--                   are copied into tracker_events with their ids, and the name becomes a
--                   view with the same columns, so every reader keeps working unchanged.
--   kpi_readings    KPI values over time. The definitions stay in the area home note's
--                   `kpis:` frontmatter; a reading also lands in tracker_events.

CREATE TABLE tracker_events (
  id          bigserial PRIMARY KEY,
  at          timestamptz NOT NULL DEFAULT now(),
  actor       text NOT NULL DEFAULT 'unknown',
  source      text NOT NULL DEFAULT 'unknown',      -- cli | api | board | scanner | kpi | migration | unknown
  area_slug   text NOT NULL REFERENCES areas(slug) ON UPDATE CASCADE ON DELETE CASCADE,
  project_id  bigint REFERENCES projects(id) ON DELETE CASCADE,   -- NULL = the area itself
  kind        text NOT NULL CHECK (kind IN ('created', 'changed', 'stage', 'archived', 'unarchived', 'frontmatter', 'kpi_reading')),
  field       text,                                 -- the column, the frontmatter key or the KPI key
  from_value  jsonb,
  to_value    jsonb,
  note        text
);
CREATE INDEX tracker_events_at_idx ON tracker_events (at DESC);
CREATE INDEX tracker_events_area_idx ON tracker_events (area_slug, at DESC);
CREATE INDEX tracker_events_project_idx ON tracker_events (project_id, at DESC);

-- ------------------------------------------------------------------ stage_changes: table to view
-- The ids are kept, so a reader that remembered one still finds its row. A row that
-- recorded an archive (to_stage 'archived' or 'unarchived', no from_stage) takes that kind;
-- every other row is a stage row. `by` was nullable: NULL becomes the actor 'unknown',
-- which the view turns back into NULL.
INSERT INTO tracker_events (id, at, actor, source, area_slug, project_id, kind, field, from_value, to_value, note)
SELECT id, at, coalesce(by, 'unknown'), 'migration', area_slug, project_id,
       CASE WHEN from_stage IS NULL AND to_stage IN ('archived', 'unarchived') THEN to_stage ELSE 'stage' END,
       CASE WHEN from_stage IS NULL AND to_stage IN ('archived', 'unarchived') THEN 'archived_at' ELSE 'stage' END,
       to_jsonb(from_stage), to_jsonb(to_stage), note
  FROM stage_changes ORDER BY id;
SELECT setval(pg_get_serial_sequence('tracker_events', 'id'), coalesce(max(id), 1), max(id) IS NOT NULL) FROM tracker_events;

DO $check$
BEGIN
  IF (SELECT count(*) FROM stage_changes) <> (SELECT count(*) FROM tracker_events) THEN
    RAISE EXCEPTION 'tracker_events: copied % rows of %, refusing to drop stage_changes',
      (SELECT count(*) FROM tracker_events), (SELECT count(*) FROM stage_changes);
  END IF;
END $check$;

DROP TABLE stage_changes;

-- Same columns, same order, same types as the table had. A created row reads as the first
-- stage (NULL to the stage or status the row was inserted with), as the application wrote it.
CREATE VIEW stage_changes AS
SELECT id, area_slug, project_id,
       CASE WHEN kind = 'stage' THEN from_value #>> '{}' END AS from_stage,
       CASE kind WHEN 'stage' THEN to_value #>> '{}'
                 WHEN 'created' THEN coalesce(to_value ->> 'stage', to_value ->> 'status')
                 ELSE kind END AS to_stage,
       at, nullif(actor, 'unknown') AS by, note
  FROM tracker_events
 WHERE kind IN ('created', 'stage', 'archived', 'unarchived');

-- ------------------------------------------------------------------ the triggers that write the log

CREATE FUNCTION tracker_setting(p_name text) RETURNS text LANGUAGE sql STABLE AS $fn$
  SELECT nullif(current_setting(p_name, true), '')
$fn$;

-- SECURITY DEFINER: a writer that reaches areas or projects through a definer function
-- (the board functions, called by the agents' role) has no right to insert here itself.
CREATE FUNCTION tracker_log() RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $fn$
DECLARE
  n jsonb := to_jsonb(NEW) - 'updated_at' - 'updated_by';
  o jsonb;
  is_area boolean := TG_TABLE_NAME = 'areas';
  v_area text := CASE WHEN TG_TABLE_NAME = 'areas' THEN n ->> 'slug' ELSE n ->> 'area_slug' END;
  v_project bigint := CASE WHEN TG_TABLE_NAME = 'areas' THEN NULL ELSE (n ->> 'id')::bigint END;
  v_actor text := coalesce(tracker_setting('app.actor'), 'unknown');
  v_source text := coalesce(tracker_setting('app.source'), 'unknown');
  v_note text := tracker_setting('app.note');
  k text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO tracker_events (actor, source, area_slug, project_id, kind, to_value, note)
    VALUES (v_actor, v_source, v_area, v_project, 'created', jsonb_strip_nulls(n), v_note);
    RETURN NULL;
  END IF;
  o := to_jsonb(OLD) - 'updated_at' - 'updated_by';
  FOR k IN SELECT key FROM jsonb_object_keys(n) AS key WHERE (o -> key) IS DISTINCT FROM (n -> key) ORDER BY key LOOP
    INSERT INTO tracker_events (actor, source, area_slug, project_id, kind, field, from_value, to_value, note)
    VALUES (v_actor, v_source, v_area, v_project,
            CASE WHEN k = CASE WHEN is_area THEN 'status' ELSE 'stage' END THEN 'stage'
                 WHEN k = 'archived_at' AND o -> k = 'null'::jsonb THEN 'archived'
                 WHEN k = 'archived_at' AND n -> k = 'null'::jsonb THEN 'unarchived'
                 ELSE 'changed' END,
            k, nullif(o -> k, 'null'::jsonb), nullif(n -> k, 'null'::jsonb), v_note);
  END LOOP;
  RETURN NULL;
END
$fn$;

CREATE TRIGGER tracker_log AFTER INSERT OR UPDATE ON areas FOR EACH ROW EXECUTE FUNCTION tracker_log();
CREATE TRIGGER tracker_log AFTER INSERT OR UPDATE ON projects FOR EACH ROW EXECUTE FUNCTION tracker_log();

-- ------------------------------------------------------------------ append-only
-- The app connects as the owner of these tables, so grants alone would not stop it. This
-- refuses an UPDATE or DELETE issued as a statement by any role. The two foreign keys still
-- work (purging an area or a project takes its events with it, renaming a slug follows):
-- their actions run inside a trigger, one level deeper than a statement.
CREATE FUNCTION tracker_events_append_only() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF pg_trigger_depth() > 1 THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'tracker_events is append-only: % is refused', TG_OP;
END
$fn$;
CREATE TRIGGER tracker_events_append_only BEFORE UPDATE OR DELETE ON tracker_events
  FOR EACH ROW EXECUTE FUNCTION tracker_events_append_only();

-- ------------------------------------------------------------------ KPI readings

CREATE TABLE kpi_readings (
  id          bigserial PRIMARY KEY,
  area_slug   text NOT NULL REFERENCES areas(slug) ON UPDATE CASCADE ON DELETE CASCADE,
  project_id  bigint REFERENCES projects(id) ON DELETE CASCADE,
  kpi_key     text NOT NULL CHECK (kpi_key <> ''),
  value       numeric NOT NULL,
  at          timestamptz NOT NULL DEFAULT now(),
  source      text NOT NULL DEFAULT coalesce(nullif(current_setting('app.source', true), ''), 'unknown'),
  actor       text NOT NULL DEFAULT coalesce(nullif(current_setting('app.actor', true), ''), 'unknown'),
  note        text
);
CREATE INDEX kpi_readings_key_idx ON kpi_readings (area_slug, kpi_key, at DESC);

-- Every reading is also one row of the log, so a review reads one stream. from_value is
-- the reading it follows in time, when there is one.
CREATE FUNCTION kpi_reading_log() RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $fn$
BEGIN
  INSERT INTO tracker_events (actor, source, area_slug, project_id, kind, field, from_value, to_value, note)
  VALUES (NEW.actor, 'kpi', NEW.area_slug, NEW.project_id, 'kpi_reading', NEW.kpi_key,
          (SELECT to_jsonb(r.value) FROM kpi_readings r
            WHERE r.area_slug = NEW.area_slug AND r.project_id IS NOT DISTINCT FROM NEW.project_id AND r.kpi_key = NEW.kpi_key
              AND r.id <> NEW.id AND r.at <= NEW.at
            ORDER BY r.at DESC, r.id DESC LIMIT 1),
          to_jsonb(NEW.value), NEW.note);
  RETURN NULL;
END
$fn$;
CREATE TRIGGER kpi_reading_log AFTER INSERT ON kpi_readings FOR EACH ROW EXECUTE FUNCTION kpi_reading_log();

-- ------------------------------------------------------------------ grants
-- The agents' role reads the history and cannot change it. It gets no INSERT either: the
-- triggers above are definer functions, so it needs none, and a bot that could insert here
-- could write history that never happened.
REVOKE ALL ON tracker_events, kpi_readings, stage_changes FROM PUBLIC;
GRANT SELECT ON tracker_events, kpi_readings, stage_changes TO sb_org;

-- ------------------------------------------------------------------ the board's own write
-- Giving a card with a project to an agent makes that agent the project's owner. That
-- UPDATE runs inside these two functions, so they name the actor themselves. Nothing else
-- in them changes (see 1756000018400 for the bodies).

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
    PERFORM set_config('app.actor', c.name, true), set_config('app.source', 'board', true), set_config('app.note', 'card ' || p_card, true);
    UPDATE projects SET owner = p_assignee WHERE area_slug = card.area_slug AND slug = card.project_slug;
  END IF;
  PERFORM board_event(p_card, 'assigned', c.name, json_build_object('assignee', p_assignee, 'repo', p_repo)::jsonb);
  IF card.status = 'ready' THEN PERFORM board_wake(p_card); END IF;
  RETURN card;
END
$fn$;
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
    PERFORM set_config('app.actor', c.name, true), set_config('app.source', 'board', true), set_config('app.note', 'card ' || new_id, true);
    UPDATE projects SET owner = p_assignee WHERE area_slug = p_area AND slug = p_project;
  END IF;
  PERFORM board_event(new_id, 'created', c.name, json_build_object('assignee', p_assignee, 'status', st)::jsonb);
  IF st = 'ready' THEN PERFORM board_wake(new_id); END IF;
  RETURN card;
END
$fn$;

-- Down Migration

-- stage_changes becomes a table again, filled from the view (so it holds every stage,
-- creation and archive row, old and new, with the same ids). What has no home in the old
-- schema is dropped: the per-column, frontmatter and KPI events, and the KPI readings.
-- board_card_assign and board_card_create keep their three set_config calls: with no
-- trigger left to read the settings they do nothing.

DROP TRIGGER tracker_log ON projects;
DROP TRIGGER tracker_log ON areas;
DROP TABLE kpi_readings;
DROP FUNCTION kpi_reading_log();

ALTER VIEW stage_changes RENAME TO stage_changes_view;
CREATE TABLE stage_changes (
  id          bigserial PRIMARY KEY,
  area_slug   text NOT NULL CONSTRAINT stage_changes_area_slug_fkey REFERENCES areas(slug) ON UPDATE CASCADE ON DELETE CASCADE,
  project_id  bigint CONSTRAINT stage_changes_project_id_fkey REFERENCES projects(id) ON DELETE CASCADE,   -- NULL = the area itself
  from_stage  text,
  to_stage    text NOT NULL,
  at          timestamptz NOT NULL DEFAULT now(),
  by          text,
  note        text
);
INSERT INTO stage_changes (id, area_slug, project_id, from_stage, to_stage, at, by, note)
SELECT id, area_slug, project_id, from_stage, to_stage, at, by, note FROM stage_changes_view ORDER BY id;
SELECT setval('stage_changes_id_seq', coalesce(max(id), 1), max(id) IS NOT NULL) FROM stage_changes;
CREATE INDEX stage_changes_at_idx ON stage_changes (at DESC);
CREATE INDEX stage_changes_project_idx ON stage_changes (project_id, at DESC);

DROP VIEW stage_changes_view;
DROP TABLE tracker_events;
DROP FUNCTION tracker_events_append_only();
DROP FUNCTION tracker_log();
DROP FUNCTION tracker_setting(text);
