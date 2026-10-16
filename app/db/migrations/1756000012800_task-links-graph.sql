-- Up Migration

-- Graph templates: a card knows which template and node it came from and its
-- type (spec, build, review, verify, doc, status, work). `rounds` is written
-- by the review loop (cli-org task redo). Design: work-graph-plan.md, loops.

ALTER TABLE task_links
  ADD COLUMN graph text,
  ADD COLUMN node  text,
  ADD COLUMN kind  text NOT NULL DEFAULT 'work';

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

-- The seven-argument form stays for callers that know nothing of graphs.
CREATE OR REPLACE FUNCTION org_task_link(p_task text, p_board text, p_title text, p_project text, p_feature text, p_assignee text, p_by text)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT org_task_link(p_task, p_board, p_title, p_project, p_feature, p_assignee, p_by, NULL, NULL, 'work', 0)
$$;

-- Down Migration

DROP FUNCTION org_task_link(text, text, text, text, text, text, text, text, text, text, integer);
CREATE OR REPLACE FUNCTION org_task_link(p_task text, p_board text, p_title text, p_project text, p_feature text, p_assignee text, p_by text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF org_me() IS NOT NULL AND org_me() <> p_by THEN
    RAISE EXCEPTION 'task link: caller is %, not %', org_me(), p_by;
  END IF;
  INSERT INTO task_links (task_id, board, title, project_slug, feature_slug, assignee, created_by)
  VALUES (p_task, p_board, p_title, p_project, p_feature, p_assignee, p_by)
  ON CONFLICT (task_id) DO UPDATE SET project_slug = EXCLUDED.project_slug, feature_slug = EXCLUDED.feature_slug, assignee = EXCLUDED.assignee, title = EXCLUDED.title;
  IF p_project IS NOT NULL AND p_feature IS NOT NULL THEN
    UPDATE features SET owner = p_assignee WHERE project_slug = p_project AND slug = p_feature;
  END IF;
END
$$;
ALTER TABLE task_links DROP COLUMN kind, DROP COLUMN node, DROP COLUMN graph;
