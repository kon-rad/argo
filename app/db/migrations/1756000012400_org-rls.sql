-- Up Migration

-- Agent company, phase 6: a worker that reaches Postgres directly sees only
-- its own channels. `sb_org` is the role cli-org connects as when ORG_AGENT is
-- set and SB_ORG_DB_URL is in the environment; the agent's name travels in
-- the connection's `org.agent` setting (startup option), and every policy
-- keys on it. The app and the dispatcher keep connecting as the owner
-- (hermes), which bypasses the policies: RLS is not FORCEd.
--
-- The role is global, so on the droplet deploy.sh creates it as postgres
-- (hermes may not CREATE ROLE); here it is created only when missing, which
-- is the test databases. Design: agent-company-design.md §10.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sb_org') THEN
    CREATE ROLE sb_org LOGIN;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO sb_org;
GRANT SELECT ON org_agents, org_channels, org_channel_members, org_messages, org_reads, org_wakeups, teams, projects TO sb_org;
GRANT INSERT ON org_messages TO sb_org;
GRANT INSERT, UPDATE ON org_reads TO sb_org;
GRANT USAGE, SELECT ON SEQUENCE org_messages_id_seq TO sb_org;

-- The caller: NULL for the owner and the app, which set nothing.
CREATE OR REPLACE FUNCTION org_me() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('org.agent', true), '')
$$;

-- The channels the caller may see: everything for a human, memberships for
-- an agent. SECURITY DEFINER so the policies below can ask without recursing
-- into the membership table's own policy.
CREATE OR REPLACE FUNCTION org_my_channels() RETURNS SETOF text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT c.slug FROM org_channels c
   WHERE EXISTS (SELECT 1 FROM org_agents a WHERE a.name = org_me() AND a.runtime = 'human')
  UNION
  SELECT m.channel_slug FROM org_channel_members m WHERE m.agent_name = org_me()
$$;

-- A DM channel and its two memberships, created on first use. The one write
-- to org_channels and org_channel_members an agent needs; it must be a party.
CREATE OR REPLACE FUNCTION org_dm_channel(a text, b text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  slug text := 'dm:' || least(a, b) || ':' || greatest(a, b);
BEGIN
  IF org_me() IS NOT NULL AND org_me() NOT IN (a, b) THEN
    RAISE EXCEPTION 'a DM channel must include the caller (%)', org_me();
  END IF;
  INSERT INTO org_channels (slug, kind, purpose) VALUES (slug, 'dm', 'DM ' || a || ' and ' || b) ON CONFLICT DO NOTHING;
  INSERT INTO org_channel_members (channel_slug, agent_name) VALUES (slug, a), (slug, b) ON CONFLICT DO NOTHING;
  RETURN slug;
END
$$;

-- The wake trigger inserts wakeups for other agents; it runs as the owner.
ALTER FUNCTION org_messages_wake() SECURITY DEFINER SET search_path = public;

ALTER TABLE org_channels        ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_channel_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_messages        ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_reads           ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_wakeups         ENABLE ROW LEVEL SECURITY;

CREATE POLICY org_channels_member ON org_channels FOR SELECT TO sb_org
  USING (slug IN (SELECT org_my_channels()));
CREATE POLICY org_channel_members_member ON org_channel_members FOR SELECT TO sb_org
  USING (channel_slug IN (SELECT org_my_channels()));
CREATE POLICY org_messages_read ON org_messages FOR SELECT TO sb_org
  USING (channel_slug IN (SELECT org_my_channels()));
CREATE POLICY org_messages_write ON org_messages FOR INSERT TO sb_org
  WITH CHECK (author = org_me() AND channel_slug IN (SELECT org_my_channels()));
CREATE POLICY org_reads_own ON org_reads FOR ALL TO sb_org
  USING (agent_name = org_me()) WITH CHECK (agent_name = org_me());
CREATE POLICY org_wakeups_own ON org_wakeups FOR SELECT TO sb_org
  USING (agent_name = org_me());

-- Down Migration

DROP POLICY org_wakeups_own ON org_wakeups;
DROP POLICY org_reads_own ON org_reads;
DROP POLICY org_messages_write ON org_messages;
DROP POLICY org_messages_read ON org_messages;
DROP POLICY org_channel_members_member ON org_channel_members;
DROP POLICY org_channels_member ON org_channels;
ALTER TABLE org_wakeups         DISABLE ROW LEVEL SECURITY;
ALTER TABLE org_reads           DISABLE ROW LEVEL SECURITY;
ALTER TABLE org_messages        DISABLE ROW LEVEL SECURITY;
ALTER TABLE org_channel_members DISABLE ROW LEVEL SECURITY;
ALTER TABLE org_channels        DISABLE ROW LEVEL SECURITY;
ALTER FUNCTION org_messages_wake() SECURITY INVOKER RESET search_path;
DROP FUNCTION org_dm_channel(text, text);
DROP FUNCTION org_my_channels();
DROP FUNCTION org_me();
REVOKE ALL ON SEQUENCE org_messages_id_seq FROM sb_org;
REVOKE ALL ON org_agents, org_channels, org_channel_members, org_messages, org_reads, org_wakeups, teams, projects FROM sb_org;
REVOKE USAGE ON SCHEMA public FROM sb_org;
-- The role itself is global and stays; drop it by hand if nothing else uses it.
