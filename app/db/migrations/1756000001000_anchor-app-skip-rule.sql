-- Up Migration

-- `app` as a bare name rule prunes EVERY directory called app at any depth,
-- which silently swallowed Areas/school/video-editor/app. Anchoring it
-- to the vault root with a leading slash excludes only this app's own source.
UPDATE sources
SET config = jsonb_set(
      config,
      '{skip_dirs}',
      (SELECT jsonb_agg(CASE WHEN d = '"app"'::jsonb THEN '"/app"'::jsonb ELSE d END)
       FROM jsonb_array_elements(config -> 'skip_dirs') d)
    )
WHERE kind = 'vault' AND config -> 'skip_dirs' @> '["app"]';

-- Down Migration

UPDATE sources
SET config = jsonb_set(
      config,
      '{skip_dirs}',
      (SELECT jsonb_agg(CASE WHEN d = '"/app"'::jsonb THEN '"app"'::jsonb ELSE d END)
       FROM jsonb_array_elements(config -> 'skip_dirs') d)
    )
WHERE kind = 'vault' AND config -> 'skip_dirs' @> '["/app"]';
