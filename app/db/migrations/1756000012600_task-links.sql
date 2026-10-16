-- Up Migration

-- The work graph: a kanban card for a bot carries its tracker project and
-- feature. The kanban (Hermes's SQLite) has no such fields, so the link lives
-- here, beside the tracker, written only by `cli-org task create` through
-- org_task_link(). Every row is visible to every bot (cards are company work);
-- nobody but the function writes it. Design: agent-company/work-graph-plan.md.

CREATE TABLE task_links (
  task_id       text PRIMARY KEY CHECK (task_id ~ '^t_[0-9a-f]{6,32}$'),
  board         text NOT NULL,
  title         text NOT NULL,
  project_slug  text REFERENCES projects(slug) ON UPDATE CASCADE ON DELETE SET NULL,
  feature_slug  text,
  assignee      text NOT NULL,                       -- a name on the roster (org_agents), never a lane
  created_by    text NOT NULL,                       -- the caller: the owner, a lead, or the bot itself
  rounds        integer NOT NULL DEFAULT 0,          -- review rounds (plan step B)
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX task_links_project_idx ON task_links (project_slug, feature_slug);
CREATE INDEX task_links_assignee_idx ON task_links (assignee);

GRANT SELECT ON task_links TO sb_org;
ALTER TABLE task_links ENABLE ROW LEVEL SECURITY;
CREATE POLICY task_links_read ON task_links FOR SELECT TO sb_org USING (true);

-- The one write: the link row, and the feature's owner becomes the assignee.
-- SECURITY DEFINER because sb_org may update neither table; the caller's name
-- must match the connection's identity when there is one.
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

-- Down Migration

DROP FUNCTION org_task_link(text, text, text, text, text, text, text);
DROP POLICY task_links_read ON task_links;
REVOKE ALL ON task_links FROM sb_org;
DROP TABLE task_links;
