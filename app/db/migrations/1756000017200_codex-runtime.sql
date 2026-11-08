-- Up Migration
-- The dispatcher records ChatGPT subscription Codex runs in the shared usage ledger.
ALTER TABLE usage_runs DROP CONSTRAINT usage_runs_runtime_check;
ALTER TABLE usage_runs ADD CONSTRAINT usage_runs_runtime_check CHECK (runtime IN ('claude-code', 'zen-agent', 'codex'));
ALTER TABLE org_agent_overrides DROP CONSTRAINT org_agent_overrides_runtime_check;
ALTER TABLE org_agent_overrides ADD CONSTRAINT org_agent_overrides_runtime_check CHECK (runtime IN ('claude-code', 'zen-agent', 'hermes', 'codex'));

-- Down Migration
-- Existing codex rows must be archived before a downgrade.
DELETE FROM usage_calls WHERE source = 'codex';
DELETE FROM usage_runs WHERE runtime = 'codex';
DELETE FROM org_agent_overrides WHERE runtime = 'codex';
ALTER TABLE org_agent_overrides DROP CONSTRAINT org_agent_overrides_runtime_check;
ALTER TABLE org_agent_overrides ADD CONSTRAINT org_agent_overrides_runtime_check CHECK (runtime IN ('claude-code', 'zen-agent', 'hermes'));
ALTER TABLE usage_runs DROP CONSTRAINT usage_runs_runtime_check;
ALTER TABLE usage_runs ADD CONSTRAINT usage_runs_runtime_check CHECK (runtime IN ('claude-code', 'zen-agent'));
