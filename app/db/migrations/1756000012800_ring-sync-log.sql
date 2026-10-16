-- Up Migration

-- One row per run of the server's ring sync (the ring module's client script and its
-- timer), so the Ring page and the stand-up can see when the ring last synced from
-- Ultrahuman and whether the token still works. The script creates the same table with
-- IF NOT EXISTS on connect (it runs as the schema owner); keep both identical.
-- Design: Projects/wearable-body-track/ring-sync-design.md §3a.
CREATE TABLE IF NOT EXISTS ring_sync_log (
  id BIGSERIAL PRIMARY KEY, ran_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  days INTEGER NOT NULL, changed INTEGER NOT NULL, error TEXT
);

-- Down Migration

DROP TABLE IF EXISTS ring_sync_log;
