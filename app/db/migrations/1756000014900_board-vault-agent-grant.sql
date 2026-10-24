-- Up Migration

-- Bug: cardTarget() in org.ts provisions the vault assignee's org_agents row the first time a card goes to
-- it (an UPSERT: insert the row, or clear retired_at if it is back). Under the owner's own database
-- connection that always worked. But `cli-board create --to <vault assignee>` run with ORG_AGENT set (the
-- documented way to run it: ORG_AGENT=konrad cli-org task create ..., and any bot's own wakes) connects as
-- the sb_org row-level-security role instead, which has only SELECT on org_agents -- no INSERT or UPDATE --
-- so the upsert failed with "permission denied for table org_agents" and the card was never created.
--
-- Fix, following the pattern every other RLS-role write in this module already uses (board_caller,
-- board_card_create, ...): move the upsert into a SECURITY DEFINER function and grant sb_org EXECUTE on it,
-- not direct table access. Scoped to rows that are already runtime 'session' or don't exist yet, so it can't
-- be used to revive or relabel an unrelated retired agent.
CREATE OR REPLACE FUNCTION board_ensure_vault_agent(p_name text, p_role text, p_reports_to text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM org_agents WHERE name = p_name AND runtime <> 'session') THEN
    RAISE EXCEPTION '% is not a vault/session agent', p_name;
  END IF;
  INSERT INTO org_agents (name, runtime, role, reports_to, expertise, org_version)
  VALUES (p_name, 'session', p_role, p_reports_to, 'vault code: skills, scripts, hooks, notes', 'board')
  ON CONFLICT (name) DO UPDATE SET runtime = 'session', retired_at = NULL;
END
$$;
GRANT EXECUTE ON FUNCTION board_ensure_vault_agent(text, text, text) TO sb_org;

-- Down Migration

REVOKE EXECUTE ON FUNCTION board_ensure_vault_agent(text, text, text) FROM sb_org;
DROP FUNCTION board_ensure_vault_agent(text, text, text);
