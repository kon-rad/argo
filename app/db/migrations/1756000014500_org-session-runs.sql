-- Up Migration

-- How many runs the agent's remembered session has carried. A resumed `claude -p` reloads the whole
-- conversation on every turn, so a session that keeps being resumed grows to hundreds of thousands of
-- input tokens per turn. setSession() drops the session once it has carried ORG_SESSION_MAX_RUNS runs,
-- and the next wake starts fresh.
ALTER TABLE org_agents ADD COLUMN session_runs integer NOT NULL DEFAULT 0;
UPDATE org_agents SET session_runs = 1 WHERE session_id IS NOT NULL;

-- Down Migration

ALTER TABLE org_agents DROP COLUMN session_runs;
