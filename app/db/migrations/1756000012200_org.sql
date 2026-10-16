-- Up Migration

-- The agent company's message board: named agents on teams, channels, DMs,
-- messages, read cursors and the wakeups that tell the dispatcher whom to run.
-- (org module)
--
-- Rules the schema carries: an author is always an org agent (the CLI sets it
-- from ORG_AGENT, never from the body); a DM is a channel of kind 'dm' named
-- dm:<a>:<b> (sorted); the owner (runtime human) never gets a wakeup row, their
-- items go to the stand-up. Teams reuse the tracker's `teams` table so the org
-- chart and the project tracker agree. Numbered 12200: after the usage ledger
-- (12000) and provider credits (12100), which the droplet had already run.

CREATE TABLE org_agents (
  name            text PRIMARY KEY CHECK (name ~ '^[a-z0-9][a-z0-9-]{0,31}$'),
  team_slug       text REFERENCES teams(slug) ON UPDATE CASCADE ON DELETE SET NULL,
  runtime         text NOT NULL CHECK (runtime IN ('claude-code','hermes','codex','human')),
  role            text NOT NULL,
  reports_to      text REFERENCES org_agents(name) ON UPDATE CASCADE ON DELETE SET NULL,
  model           text,
  expertise       text,
  session_id      text,                      -- last claude/hermes session, resumed on the next wake
  session_started date,
  org_version     text NOT NULL,             -- hash of org.yaml at import time
  retired_at      timestamptz,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE org_channels (
  slug            text PRIMARY KEY CHECK (slug ~ '^[a-z0-9][a-z0-9:-]{0,79}$'),
  kind            text NOT NULL CHECK (kind IN ('team','shared','dm')),
  team_slug       text REFERENCES teams(slug) ON UPDATE CASCADE ON DELETE SET NULL,
  purpose         text,
  classification  text,                      -- from the privacy spike; NULL until levels land
  compartments    text[] NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE org_channel_members (
  channel_slug    text NOT NULL REFERENCES org_channels(slug) ON UPDATE CASCADE ON DELETE CASCADE,
  agent_name      text NOT NULL REFERENCES org_agents(name) ON UPDATE CASCADE ON DELETE CASCADE,
  can_post        boolean NOT NULL DEFAULT true,
  PRIMARY KEY (channel_slug, agent_name)
);
CREATE INDEX org_channel_members_agent_idx ON org_channel_members (agent_name);

CREATE TABLE org_messages (
  id              bigserial PRIMARY KEY,
  channel_slug    text NOT NULL REFERENCES org_channels(slug) ON UPDATE CASCADE,
  thread_id       bigint REFERENCES org_messages(id) ON DELETE SET NULL,
  author          text NOT NULL REFERENCES org_agents(name) ON UPDATE CASCADE,
  kind            text NOT NULL CHECK (kind IN ('message','status','decision','handoff','question-for-owner','standup','reflection','reply')),
  body            text NOT NULL CHECK (length(body) BETWEEN 1 AND 8000),
  mentions        text[] NOT NULL DEFAULT '{}',
  urgent          boolean NOT NULL DEFAULT false,  -- question-for-owner also sent to the owner's phone, not only the stand-up
  task_id         text,                      -- kanban t_…
  project_slug    text REFERENCES projects(slug) ON UPDATE CASCADE ON DELETE SET NULL,
  feature_slug    text,
  run_id          text,                      -- cc-runs file or Hermes session
  created_at      timestamptz NOT NULL DEFAULT now(),
  tsv             tsvector GENERATED ALWAYS AS (to_tsvector('simple', body)) STORED
);
CREATE INDEX org_messages_channel_idx ON org_messages (channel_slug, id);
CREATE INDEX org_messages_thread_idx ON org_messages (thread_id) WHERE thread_id IS NOT NULL;
CREATE INDEX org_messages_kind_idx ON org_messages (kind, created_at DESC);
CREATE INDEX org_messages_tsv_idx ON org_messages USING gin (tsv);

CREATE TABLE org_reads (
  agent_name      text NOT NULL REFERENCES org_agents(name) ON UPDATE CASCADE ON DELETE CASCADE,
  channel_slug    text NOT NULL REFERENCES org_channels(slug) ON UPDATE CASCADE ON DELETE CASCADE,
  last_read_id    bigint NOT NULL DEFAULT 0,
  read_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_name, channel_slug)
);

CREATE TABLE org_wakeups (
  id              bigserial PRIMARY KEY,
  agent_name      text NOT NULL REFERENCES org_agents(name) ON UPDATE CASCADE ON DELETE CASCADE,
  reason          text NOT NULL CHECK (reason IN ('task','dm','handoff','mention','routine','owner')),
  ref             text,                      -- message id, task id or routine name
  created_at      timestamptz NOT NULL DEFAULT now(),
  claimed_at      timestamptz,
  claimed_by      text,
  done_at         timestamptz,
  result          text
);
CREATE INDEX org_wakeups_open_idx ON org_wakeups (agent_name, created_at) WHERE done_at IS NULL;
-- One open wakeup per agent, reason and ref: a message never wakes the same agent twice.
CREATE UNIQUE INDEX org_wakeups_dedupe_idx ON org_wakeups (agent_name, reason, ref) WHERE done_at IS NULL;

-- Who a message wakes. Only channel members, never the author, never a human:
--   dm                      the other member(s)                         reason dm (owner when the human wrote it)
--   handoff                 each mentioned agent, plus that agent's lead
--                           when the author is on another team           reason handoff
--   any other kind          each mentioned agent                         reason mention (owner when the human wrote it)
-- question-for-owner wakes nobody: the stand-up carries it. Every insert
-- also sends NOTIFY org_board with the message id so a dispatcher can LISTEN.
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
$$ LANGUAGE plpgsql;

CREATE TRIGGER org_messages_wake AFTER INSERT ON org_messages
  FOR EACH ROW EXECUTE FUNCTION org_messages_wake();

-- Down Migration

DROP TRIGGER org_messages_wake ON org_messages;
DROP FUNCTION org_messages_wake();
DROP TABLE org_wakeups;
DROP TABLE org_reads;
DROP TABLE org_messages;
DROP TABLE org_channel_members;
DROP TABLE org_channels;
DROP TABLE org_agents;
