-- Up Migration

-- The extension has to be created by the migration, not by hand: the test
-- harness drops and recreates schema public on every run, which takes the
-- extension with it.
CREATE EXTENSION IF NOT EXISTS vector;

-- Chunks are derived data, exactly like vault_files.body — drop the table,
-- re-embed, lose nothing. The FK cascade is the whole reason these live in
-- Postgres rather than a separate vector store: deleting a note deletes its
-- embeddings in the same transaction, so the index cannot drift.
CREATE TABLE vault_chunks (
  id             serial PRIMARY KEY,
  file_id        integer NOT NULL REFERENCES vault_files(id) ON DELETE CASCADE,
  chunk_index    integer NOT NULL,
  -- "Note Title > Section > Subsection" at the point the chunk starts.
  heading_path   text NOT NULL DEFAULT '',
  -- What was actually embedded, context prefix included. Stored verbatim so a
  -- semantic hit can show the exact text the vector came from.
  content        text NOT NULL,
  token_estimate integer NOT NULL,
  char_start     integer NOT NULL,
  char_end       integer NOT NULL,
  -- The parent file's content_hash at embed time. This, not mtime, is what
  -- makes a no-change re-embed free.
  content_hash   text NOT NULL,
  model          text NOT NULL,
  embedding      vector(1024) NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (file_id, chunk_index)
);

CREATE INDEX vault_chunks_file_idx ON vault_chunks (file_id);
CREATE INDEX vault_chunks_hash_idx ON vault_chunks (content_hash);
CREATE INDEX vault_chunks_model_idx ON vault_chunks (model);

-- HNSW over cosine distance. Cosine because bge-large-en-v1.5 is trained for
-- it and its outputs are normalised; with normalised vectors cosine and inner
-- product rank identically, so this stays correct if the model is swapped for
-- another normalised one. IVFFlat was rejected: it needs a representative
-- sample to train its lists and degrades badly on an index that grows a note
-- at a time.
CREATE INDEX vault_chunks_embedding_idx ON vault_chunks
  USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);

-- multilingual-e5-large-instruct rather than bge-large: as of 2026-08-27 it is
-- the only embedding model Together still serves serverless, and it is also
-- 1024-wide, so the column above fits it exactly. Its 512-token window is what
-- sets max_chunk_tokens at 400: these notes tokenize at ~2.2 chars/token, not
-- the 4 that English prose averages, so 400 leaves real margin.
INSERT INTO sources (kind, name, config) VALUES
  ('embeddings', 'Embeddings',
   '{"provider":"together","model":"intfloat/multilingual-e5-large-instruct","dimensions":1024,
     "max_chunk_tokens":400,"overlap_tokens":60,"batch_size":32}');

-- Down Migration

DROP TABLE IF EXISTS vault_chunks;
DELETE FROM sources WHERE kind = 'embeddings';
