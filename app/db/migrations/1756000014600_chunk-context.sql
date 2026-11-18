-- Up Migration

-- Retrieval for the chat works at chunk level on both arms (docs/rag.md):
--
--  * `context` is the optional one-line description of where the chunk sits in
--    its note, written by a model at embed time (contextual retrieval). Empty
--    when that step is off. It is embedded together with the content and
--    indexed for keyword search, so a chunk that says "we chose option B" can
--    be found by the name of the project it belongs to.
--  * `tsv` gives the lexical arm of hybrid retrieval the same unit as the
--    vector arm. Searching whole notes and fusing with chunk vectors ranked
--    notes well but could not say which passage to show the model.
ALTER TABLE vault_chunks ADD COLUMN context text NOT NULL DEFAULT '';
ALTER TABLE vault_chunks ADD COLUMN tsv tsvector GENERATED ALWAYS AS (
  to_tsvector('english', coalesce(context, '') || ' ' || content)
) STORED;
CREATE INDEX vault_chunks_tsv_idx ON vault_chunks USING GIN (tsv);
CREATE INDEX vault_chunks_file_chunk_idx ON vault_chunks (file_id, chunk_index);

-- Down Migration

DROP INDEX IF EXISTS vault_chunks_file_chunk_idx;
DROP INDEX IF EXISTS vault_chunks_tsv_idx;
ALTER TABLE vault_chunks DROP COLUMN tsv;
ALTER TABLE vault_chunks DROP COLUMN context;
