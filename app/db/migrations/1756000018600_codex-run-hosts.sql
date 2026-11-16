-- Up Migration

-- Codex may execute on a different registered host from the dispatcher. Match
-- existing runs to their archived native session, then prefer native call rows
-- over the dispatcher's one-row token summary.
DROP TABLE IF EXISTS pg_temp.codex_run_host_repairs;
CREATE TEMP TABLE codex_run_host_repairs ON COMMIT DROP AS
SELECT r.host AS old_host, session_host.host AS new_host, r.run_id, r.session_id
FROM usage_runs r
CROSS JOIN LATERAL (
  SELECT s.host
  FROM archive_sessions s
  WHERE s.source = 'codex' AND s.harness = 'codex'
    AND s.external_id = r.session_id AND s.host <> r.host
  ORDER BY
    CASE WHEN r.started_at BETWEEN s.started_at - interval '2 minutes'
                               AND coalesce(s.ended_at, r.ended_at, now()) + interval '2 minutes'
         THEN 0 ELSE 1 END,
    s.updated_at DESC
  LIMIT 1
) session_host
WHERE r.runtime = 'codex'
  AND NOT EXISTS (
    SELECT 1 FROM usage_runs conflict
    WHERE conflict.host = session_host.host AND conflict.run_id = r.run_id
  );

UPDATE usage_runs r
SET host = repair.new_host
FROM codex_run_host_repairs repair
WHERE r.host = repair.old_host AND r.run_id = repair.run_id;

-- Attach native calls for both repaired and already-correct Codex runs.
UPDATE usage_calls c
SET run_id = r.run_id
FROM usage_runs r
WHERE r.runtime = 'codex' AND c.source = 'codex'
  AND c.host = r.host AND c.run_id IS NULL
  AND c.session_external_id = r.session_id
  AND r.started_at IS NOT NULL
  AND c.ts >= r.started_at - interval '2 minutes'
  AND c.ts <= coalesce(r.ended_at, now()) + interval '2 minutes';

-- A moved summary is still on old_host. Drop it when native rows now represent
-- the run, or when its destination key is already occupied.
DELETE FROM usage_calls summary
USING codex_run_host_repairs repair
WHERE summary.source = 'codex' AND summary.host = repair.old_host
  AND summary.call_id = repair.run_id AND summary.run_id = repair.run_id
  AND (
    EXISTS (
      SELECT 1 FROM usage_calls native
      WHERE native.source = 'codex' AND native.host = repair.new_host
        AND native.run_id = repair.run_id AND native.call_id <> native.run_id
    )
    OR EXISTS (
      SELECT 1 FROM usage_calls conflict
      WHERE conflict.source = summary.source AND conflict.host = repair.new_host
        AND conflict.call_id = summary.call_id
    )
  );

-- With no native calls the summary remains the fallback and follows the run.
UPDATE usage_calls summary
SET host = repair.new_host
FROM codex_run_host_repairs repair
WHERE summary.source = 'codex' AND summary.host = repair.old_host
  AND summary.call_id = repair.run_id AND summary.run_id = repair.run_id;

-- Correctly hosted runs need the same native-over-summary rule.
DELETE FROM usage_calls summary
WHERE summary.source = 'codex' AND summary.call_id = summary.run_id
  AND EXISTS (
    SELECT 1 FROM usage_calls native
    WHERE native.source = 'codex' AND native.host = summary.host
      AND native.run_id = summary.run_id AND native.call_id <> native.run_id
  );

DROP TABLE codex_run_host_repairs;

-- Down Migration

-- Irreversible data repair. The old host was incorrect and is not retained,
-- and deleted summary rows duplicated native token data that remains present.
