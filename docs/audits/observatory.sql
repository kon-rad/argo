-- Coordinator only: run with the app's effective role and restricted source roles.
-- Read-only; do not change roles or use production credentials in an agent sandbox.
-- Keep output private. Replace these synthetic dates with the intended audit window.
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '10s';
SELECT current_user, current_database(), now() AS audited_at;
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
       c.relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user) AS owner,
       has_table_privilege(current_user, c.oid, 'SELECT') AS can_select,
       (SELECT rolbypassrls OR rolsuper FROM pg_roles WHERE rolname = current_user) AS bypass
FROM pg_class c WHERE c.oid IN ('archive_sessions'::regclass, 'archive_messages'::regclass,
  'usage_runs'::regclass, 'usage_calls'::regclass, 'card_events'::regclass, 'org_messages'::regclass);
SELECT tablename, policyname, roles, cmd, qual FROM pg_policies
WHERE tablename IN ('archive_sessions', 'archive_messages', 'usage_runs', 'usage_calls', 'card_events', 'org_messages');
SELECT host, coalesce(runtime, 'claude-code') AS runtime, count(*) AS runs,
       count(*) FILTER (WHERE started_at IS NULL OR ended_at IS NULL OR ended_at <= started_at) AS unknown_intervals,
       min(started_at), max(ended_at), count(*) FILTER (WHERE agent_name IS NULL) AS unknown_persona
FROM usage_runs WHERE started_at >= '2025-01-01' AND started_at < '2025-01-02' GROUP BY 1,2;
SELECT a.host, a.source, a.harness, count(DISTINCT a.id) AS sessions, count(*) AS messages,
       count(*) FILTER (WHERE m.ts IS NULL) AS untimed, max(a.updated_at) AS archive_freshness
FROM archive_messages m JOIN archive_sessions a ON a.id=m.session_id
WHERE m.ts >= '2025-01-01' AND m.ts < '2025-01-02' GROUP BY 1,2,3;
-- Per-message usage cardinality. Do not sum message rows after a fanout join.
SELECT matches, count(*) AS archive_rows FROM (
  SELECT m.id, count(u.id) AS matches
  FROM archive_messages m JOIN archive_sessions a ON a.id=m.session_id
  LEFT JOIN usage_calls u ON u.host=a.host AND u.source=a.source
    AND u.session_external_id=a.external_id AND u.message_external_id=m.external_id
  WHERE m.ts >= '2025-01-01' AND m.ts < '2025-01-02' GROUP BY m.id
) cardinalities GROUP BY matches ORDER BY matches;
SELECT matches, count(*) AS runs FROM (
  SELECT r.host, r.run_id, count(a.id) AS matches FROM usage_runs r
  LEFT JOIN archive_sessions a ON a.host=r.host AND a.source=coalesce(r.runtime,'claude-code') AND a.external_id=r.session_id
  WHERE r.started_at >= '2025-01-01' AND r.started_at < '2025-01-02' GROUP BY r.host,r.run_id
) cardinalities GROUP BY matches ORDER BY matches;
SELECT kind, count(*), min(at), max(at) FROM card_events
WHERE at >= '2025-01-01' AND at < '2025-01-02' GROUP BY kind;
SELECT count(*) AS org_messages, min(created_at), max(created_at), count(*) FILTER (WHERE thread_id IS NOT NULL) AS replies
FROM org_messages WHERE created_at >= '2025-01-01' AND created_at < '2025-01-02';
-- A read-only plan is safe to capture separately; EXPLAIN ANALYZE is intentionally opt-in.
EXPLAIN SELECT m.id FROM archive_messages m JOIN archive_sessions a ON a.id=m.session_id
WHERE m.ts >= '2025-01-01' AND m.ts < '2025-01-02' ORDER BY m.session_id,m.seq,m.id LIMIT 5001;
ROLLBACK;
