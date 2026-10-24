-- Up Migration

-- Agent persona memory (docs/agent-memory.md): a per-bot memory with three tiers next to the shared memory_facts.
--
-- 1. org_agent_episodes: one row per finished wake, written mechanically by `cli-org wake-done` (no model call).
--    What happened, how it ended, what it cost, and where the full log is. Append-only.
-- 2. org_agent_memory: the semantic layer, first-person lessons distilled from the episodes by the reflect step
--    (`cli-org reflect`). A row is bumped (occurrences) on a repeat, superseded or retired (active = false), never
--    deleted: the same discipline as memory_facts.valid_to. The active rows render into the bot's generated core
--    block, `.agents/org/memory/<name>/core.md`.
-- 3. A row that recurs past the agent's repeat threshold may become one self-improvement card (kind `improve`)
--    addressed to a human; promoted_to_proposal and proposal_task_id record that it did, so a denied proposal does
--    not re-propose without fresh evidence.
--
-- Writes happen on the owner's connection (the dispatcher's wake-done, the app, the owner's CLI). A bot connected as
-- sb_org reads only its own rows: its memory is its own, and nothing here lets it widen what it is.

CREATE TABLE org_agent_episodes (
  id            bigserial PRIMARY KEY,
  agent_name    text NOT NULL REFERENCES org_agents(name) ON UPDATE CASCADE,
  run_id        text NOT NULL,
  wakeup_ids    bigint[] NOT NULL DEFAULT '{}',
  task_id       text,
  reason        text NOT NULL CHECK (reason IN ('task','dm','handoff','mention','routine','owner','chat')),
  outcome       text NOT NULL CHECK (outcome IN ('done','blocked','request_changes','no_report','error')),
  corrected     boolean NOT NULL DEFAULT false,
  turn_count    integer CHECK (turn_count >= 0),
  cost_usd      numeric(8,4) CHECK (cost_usd >= 0),
  duration_s    integer CHECK (duration_s >= 0),
  summary       text NOT NULL CHECK (length(summary) BETWEEN 1 AND 2000),
  log_path      text,
  reflected_at  timestamptz,                    -- when the model step ran; NULL when it was skipped (short run, cap, no model)
  reflect_model text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_name, run_id)                   -- a wake-done run twice records one episode
);
CREATE INDEX org_agent_episodes_agent_idx ON org_agent_episodes (agent_name, created_at DESC);
CREATE INDEX org_agent_episodes_task_idx ON org_agent_episodes (task_id) WHERE task_id IS NOT NULL;

CREATE TABLE org_agent_memory (
  id                   bigserial PRIMARY KEY,
  agent_name           text NOT NULL REFERENCES org_agents(name) ON UPDATE CASCADE,
  kind                 text NOT NULL CHECK (kind IN ('lesson','anti_pattern','preference','friction')),
  content              text NOT NULL CHECK (length(content) BETWEEN 1 AND 500),
  evidence_episode_ids bigint[] NOT NULL DEFAULT '{}',
  occurrences          integer NOT NULL DEFAULT 1 CHECK (occurrences >= 1),
  active               boolean NOT NULL DEFAULT true,
  retired_why          text,
  supersedes           bigint REFERENCES org_agent_memory(id),
  promoted_to_proposal boolean NOT NULL DEFAULT false,
  proposal_task_id     text,
  proposed_at          timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX org_agent_memory_agent_idx ON org_agent_memory (agent_name) WHERE active;
CREATE INDEX org_agent_memory_proposed_idx ON org_agent_memory (agent_name, proposed_at) WHERE proposed_at IS NOT NULL;

ALTER TABLE org_agent_episodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_agent_memory   ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON org_agent_episodes, org_agent_memory TO sb_org;
CREATE POLICY org_agent_episodes_own ON org_agent_episodes FOR SELECT TO sb_org USING (agent_name = org_me());
CREATE POLICY org_agent_memory_own   ON org_agent_memory   FOR SELECT TO sb_org USING (agent_name = org_me());

-- Down Migration

DROP TABLE org_agent_memory;
DROP TABLE org_agent_episodes;
