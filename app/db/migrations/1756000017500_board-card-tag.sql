-- Up Migration
-- Set, change or clear a card's project and feature, and nothing else. board_card_assign coalesces the project
-- (it can't clear one) and always rewrites the assignee and wakes a ready card, so the board page's project
-- picker needs its own write. Who may tag: a human, a dispatcher, the card's giver or its assignee.
CREATE OR REPLACE FUNCTION board_card_tag(p_by text, p_card text, p_project text, p_feature text)
RETURNS cards LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
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
$$;
GRANT EXECUTE ON FUNCTION board_card_tag(text, text, text, text) TO sb_org;

-- Down Migration

DROP FUNCTION IF EXISTS board_card_tag(text, text, text, text);
