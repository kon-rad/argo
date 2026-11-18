-- Up Migration

-- t_f67fa0ca: retain the complete verdict allowed by review_jobs (100000 bytes).
-- Patch only these limits so authorization, history bounds and context fields stay
-- intact. CREATE OR REPLACE also retains the function's owner and existing grants.
DO $migration$
DECLARE
  definition text := pg_get_functiondef('public.review_context(bigint)'::regprocedure);
  old_fragment constant text := '''verdict'',left(verdict::text,8000),''truncated'',octet_length(verdict::text)>8000';
  new_fragment constant text := '''verdict'',left(verdict::text,100000),''truncated'',octet_length(verdict::text)>100000';
BEGIN
  IF (length(definition) - length(replace(definition, old_fragment, ''))) <> length(old_fragment) THEN
    RAISE EXCEPTION 'review_context: expected exactly one prior-verdict limit fragment; refusing unexpected function source';
  END IF;
  EXECUTE replace(definition, old_fragment, new_fragment);
END
$migration$;

-- Down Migration
-- Forward only.
