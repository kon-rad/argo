-- Coordinator only. Supply psql -v from=... -v to=... -v host=... -v session=...
-- Empty host/session means no filter. Use the same effective role as the app.
BEGIN READ ONLY;
SET LOCAL statement_timeout = '3000ms';
SELECT current_user, count(*) AS records,
  count(*) FILTER (WHERE observatory_projection IS NULL) AS missing
FROM archive_messages;
PREPARE observatory_window(timestamptz,timestamptz,text,bigint) AS
WITH active AS MATERIALIZED (
      SELECT a.id, a.host, a.source, a.external_id, a.harness FROM archive_sessions a
      WHERE ($3::text IS NULL OR a.host = $3) AND ($4::bigint IS NULL OR a.id = $4)
        AND (EXISTS (SELECT 1 FROM archive_messages w WHERE w.session_id = a.id AND w.ts >= $1 AND w.ts < $2)
          OR EXISTS (SELECT 1 FROM usage_runs r WHERE r.host = a.host AND r.session_id = a.external_id
            AND coalesce(r.runtime, 'claude-code') = a.source AND r.started_at < $2 AND r.ended_at > $1))),
      budget AS (
        SELECT EXISTS (SELECT 1 FROM archive_messages u JOIN active a ON a.id=u.session_id
          WHERE u.observatory_projection IS NULL AND (u.ts < $2 OR u.ts IS NULL)) AS missing,
          (SELECT coalesce(sum(octet_length(m.raw::text)),0) > 4194304
           FROM archive_messages m JOIN active a ON a.id=m.session_id
           WHERE (m.ts >= $1 AND m.ts < $2) OR m.ts IS NULL) AS oversized),
      candidates AS (
        SELECT m.id, m.session_id, m.seq, m.ts, m.role, m.kind, m.observatory_projection FROM archive_messages m JOIN active a ON a.id=m.session_id
          WHERE (m.ts >= $1 AND m.ts < $2) OR m.ts IS NULL
        UNION ALL
        SELECT m.id, m.session_id, m.seq, m.ts, m.role, m.kind, m.observatory_projection FROM archive_messages m JOIN active a ON a.id=m.session_id
          WHERE m.ts < $1 AND (
            m.observatory_projection->'parts' @> '[{"step":"tool_call"}]'::jsonb OR
            m.observatory_projection->'parts' @> '[{"step":"tool_result"}]'::jsonb))
      SELECT m.id, m.session_id, m.seq, m.ts, m.role, m.kind, NULL::jsonb AS raw,
        m.observatory_projection, ''::text AS text, a.host, a.source, a.external_id, a.harness,
        NULL::timestamptz AS observed_at, b.missing, b.oversized
      FROM budget b LEFT JOIN candidates m ON true LEFT JOIN active a ON a.id=m.session_id
      ORDER BY m.session_id, m.seq, m.id LIMIT 5001;
EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) EXECUTE observatory_window(
  :'from'::timestamptz, :'to'::timestamptz, nullif(:'host',''), nullif(:'session','')::bigint);
DEALLOCATE observatory_window;
ROLLBACK;
