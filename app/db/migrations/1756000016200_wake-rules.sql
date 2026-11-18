-- Up Migration

-- Wake rules: the choices org_messages_wake() used to hardcode now live in one row, written by `cli-org import`
-- from the `wake_rules:` block of the org file. Defaults reproduce the old behaviour exactly, except that an
-- owner's untagged post in a channel can now wake that channel's lead (owner_channel_post = 'wake_lead').

CREATE TABLE IF NOT EXISTS org_wake_rules (
  id          boolean PRIMARY KEY DEFAULT true CHECK (id),   -- one row, ever
  rules       jsonb NOT NULL DEFAULT '{}'::jsonb,
  org_version text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
INSERT INTO org_wake_rules (id, rules) VALUES (true, '{}'::jsonb) ON CONFLICT (id) DO NOTHING;

-- Keys in rules (all optional; a missing key means the default shown):
--   dm                              true    a DM wakes the other member
--   mention                         true    @name in a channel wakes that member
--   handoff                         true    a handoff wakes the named bot (and its lead, across teams)
--   bot_wakes_per_target_per_day    3       one bot may wake one other bot this many times a day
--   owner_channel_post              'none'  'wake_lead': an owner message with no @mention in a non-DM channel wakes
--                                           that channel's lead (team channel: the team lead; else channel_leads)
--   channel_leads                   {}      {"build-room": "atlas"}: the lead for a shared channel

CREATE OR REPLACE FUNCTION org_messages_wake() RETURNS trigger AS $$
DECLARE
  ch_kind      text;
  ch_team      text;
  author_team  text;
  author_human boolean;
  base_reason  text;
  r            jsonb;
  bot_cap      integer;
  lead_name    text;
BEGIN
  SELECT rules INTO r FROM org_wake_rules WHERE id;
  r := coalesce(r, '{}'::jsonb);
  bot_cap := coalesce((r->>'bot_wakes_per_target_per_day')::integer, 3);

  SELECT kind, team_slug INTO ch_kind, ch_team FROM org_channels WHERE slug = NEW.channel_slug;
  SELECT team_slug, runtime = 'human' INTO author_team, author_human FROM org_agents WHERE name = NEW.author;
  base_reason := CASE WHEN author_human THEN 'owner' ELSE NULL END;

  -- An acknowledgement never wakes anyone, whoever wrote it; a bot's status or reply neither.
  IF NEW.kind = 'ack' OR (NEW.kind IN ('status', 'reply') AND NOT coalesce(author_human, false)) THEN
    PERFORM pg_notify('org_board', NEW.id::text);
    RETURN NEW;
  END IF;

  IF ch_kind = 'dm' THEN
    IF coalesce((r->>'dm')::boolean, true) THEN
      INSERT INTO org_wakeups (agent_name, reason, ref)
      SELECT m.agent_name, COALESCE(base_reason, 'dm'), NEW.id::text
        FROM org_channel_members m JOIN org_agents a ON a.name = m.agent_name
       WHERE m.channel_slug = NEW.channel_slug AND m.agent_name <> NEW.author
         AND a.runtime <> 'human' AND a.retired_at IS NULL
         AND (coalesce(author_human, false) OR org_bot_wakes_today(NEW.author, m.agent_name) < bot_cap)
      ON CONFLICT (agent_name, reason, ref) WHERE done_at IS NULL DO NOTHING;
    END IF;
  ELSIF NEW.kind = 'handoff' THEN
    IF coalesce((r->>'handoff')::boolean, true) THEN
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
    END IF;
  ELSIF NEW.kind <> 'question-for-owner' AND cardinality(NEW.mentions) > 0 THEN
    IF coalesce((r->>'mention')::boolean, true) THEN
      INSERT INTO org_wakeups (agent_name, reason, ref)
      SELECT a.name, COALESCE(base_reason, 'mention'), NEW.id::text
        FROM org_agents a
        JOIN org_channel_members m ON m.channel_slug = NEW.channel_slug AND m.agent_name = a.name
       WHERE a.name = ANY (NEW.mentions) AND a.name <> NEW.author
         AND a.runtime <> 'human' AND a.retired_at IS NULL
         AND (coalesce(author_human, false) OR org_bot_wakes_today(NEW.author, a.name) < bot_cap)
      ON CONFLICT (agent_name, reason, ref) WHERE done_at IS NULL DO NOTHING;
    END IF;
  ELSIF NEW.kind = 'message' AND coalesce(author_human, false) AND coalesce(r->>'owner_channel_post', 'none') = 'wake_lead' THEN
    -- The owner wrote to a channel and tagged nobody: the channel's lead picks it up and routes it.
    SELECT coalesce(r->'channel_leads'->>NEW.channel_slug, (SELECT t.lead FROM teams t WHERE t.slug = ch_team))
      INTO lead_name;
    IF lead_name IS NOT NULL THEN
      INSERT INTO org_wakeups (agent_name, reason, ref)
      SELECT a.name, 'owner', NEW.id::text
        FROM org_agents a
        JOIN org_channel_members m ON m.channel_slug = NEW.channel_slug AND m.agent_name = a.name
       WHERE a.name = lead_name AND a.name <> NEW.author
         AND a.runtime <> 'human' AND a.retired_at IS NULL
      ON CONFLICT (agent_name, reason, ref) WHERE done_at IS NULL DO NOTHING;
    END IF;
  END IF;

  PERFORM pg_notify('org_board', NEW.id::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
