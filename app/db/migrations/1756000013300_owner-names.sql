-- Up Migration

-- Owner-neutral names for three values that once named one person: the
-- tracker's "needs the owner" field, the question a lead sends up, and the
-- wakeup reason for a message the human wrote. Databases created from the
-- current migrations already have these names; for one created before, the
-- old names are renamed and existing rows rewritten in place.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'projects' AND column_name = 'needs_konrad') THEN
    ALTER TABLE projects RENAME COLUMN needs_konrad TO needs_owner;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'features' AND column_name = 'needs_konrad') THEN
    ALTER TABLE features RENAME COLUMN needs_konrad TO needs_owner;
  END IF;
END $$;

ALTER TABLE org_messages DROP CONSTRAINT org_messages_kind_check;
UPDATE org_messages SET kind = 'question-for-owner' WHERE kind = 'question-for-konrad';
ALTER TABLE org_messages ADD CONSTRAINT org_messages_kind_check CHECK (kind IN ('message','status','decision','handoff','question-for-owner','standup','reflection','reply'));

ALTER TABLE org_wakeups DROP CONSTRAINT org_wakeups_reason_check;
UPDATE org_wakeups SET reason = 'owner' WHERE reason = 'konrad';
ALTER TABLE org_wakeups ADD CONSTRAINT org_wakeups_reason_check CHECK (reason IN ('task','dm','handoff','mention','routine','owner'));

-- Same trigger with the new names; it still runs as the schema owner (org-rls).
CREATE OR REPLACE FUNCTION org_messages_wake() RETURNS trigger AS $$
DECLARE
  ch_kind      text;
  author_team  text;
  author_human boolean;
  base_reason  text;
BEGIN
  SELECT kind INTO ch_kind FROM org_channels WHERE slug = NEW.channel_slug;
  SELECT team_slug, runtime = 'human' INTO author_team, author_human FROM org_agents WHERE name = NEW.author;
  base_reason := CASE WHEN author_human THEN 'owner' ELSE NULL END;

  IF ch_kind = 'dm' THEN
    INSERT INTO org_wakeups (agent_name, reason, ref)
    SELECT m.agent_name, COALESCE(base_reason, 'dm'), NEW.id::text
      FROM org_channel_members m JOIN org_agents a ON a.name = m.agent_name
     WHERE m.channel_slug = NEW.channel_slug AND m.agent_name <> NEW.author
       AND a.runtime <> 'human' AND a.retired_at IS NULL
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
    ON CONFLICT (agent_name, reason, ref) WHERE done_at IS NULL DO NOTHING;
  ELSIF NEW.kind <> 'question-for-owner' AND cardinality(NEW.mentions) > 0 THEN
    INSERT INTO org_wakeups (agent_name, reason, ref)
    SELECT a.name, COALESCE(base_reason, 'mention'), NEW.id::text
      FROM org_agents a
      JOIN org_channel_members m ON m.channel_slug = NEW.channel_slug AND m.agent_name = a.name
     WHERE a.name = ANY (NEW.mentions) AND a.name <> NEW.author
       AND a.runtime <> 'human' AND a.retired_at IS NULL
    ON CONFLICT (agent_name, reason, ref) WHERE done_at IS NULL DO NOTHING;
  END IF;

  PERFORM pg_notify('org_board', NEW.id::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Down Migration

-- Nothing to undo: the earlier migrations create these values under the new
-- names, so rolling back past this one leaves a consistent schema.
