-- db/migrations/1756000016200_uploads.sql
-- Up Migration

-- Large uploads (uploads module). The browser sends a big file to the bucket's plain `inbox/` prefix in
-- multipart chunks with presigned URLs; the server then streams it into its final, encrypted vault path
-- and writes a `.b2.md` stub. One row per upload; the file itself lives in B2, never here.
CREATE TABLE uploads (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  filename       text NOT NULL,                    -- sanitised leaf name the browser sent
  size_bytes     bigint NOT NULL CHECK (size_bytes > 0),
  content_type   text,
  dest_dir       text NOT NULL,                    -- vault-relative folder, e.g. Areas/x/vlogs
  description    text NOT NULL DEFAULT '',
  tags           text[] NOT NULL DEFAULT '{}',
  part_size      integer NOT NULL,
  s3_upload_id   text,                             -- the multipart upload while status = 'uploading'
  inbox_key      text NOT NULL,                    -- inbox/<id>/<filename>
  status         text NOT NULL DEFAULT 'uploading'
                 CHECK (status IN ('uploading', 'uploaded', 'ingesting', 'stored', 'failed', 'aborted')),
  b2_path        text,                             -- vault/<dest_dir>/<name> once stored
  stub_path      text,                             -- vault-relative path of the .b2.md stub
  error          text,
  to_m1          boolean NOT NULL DEFAULT false,   -- also pull a working copy onto the M1
  m1_status      text CHECK (m1_status IN ('pending', 'pulling', 'done', 'failed')),
  m1_path        text,
  m1_error       text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  completed_at   timestamptz
);

CREATE INDEX uploads_status_idx ON uploads (status, updated_at);
CREATE INDEX uploads_m1_pending_idx ON uploads (m1_status) WHERE m1_status IS NOT NULL AND m1_status <> 'done';
CREATE INDEX uploads_created_idx ON uploads (created_at DESC);
