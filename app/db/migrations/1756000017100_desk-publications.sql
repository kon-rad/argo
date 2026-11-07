-- Up Migration
-- Private publication checkpoints. A checkpoint is never chain confirmation.
CREATE TABLE desk_publications (
  idempotency_key text PRIMARY KEY CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  claim_ref text NOT NULL CHECK (length(claim_ref) BETWEEN 1 AND 500),
  artifact_hash text NOT NULL CHECK (artifact_hash ~ '^sha256:[0-9a-f]{64}$'),
  media_type text NOT NULL CHECK (media_type = 'text/markdown'),
  public_destination text NOT NULL CHECK (length(public_destination) BETWEEN 1 AND 500),
  public_ref text CHECK (public_ref ~ '^[0-9a-f]{64}$'),
  delivery_ref text UNIQUE CHECK (length(delivery_ref) BETWEEN 1 AND 500),
  status text NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved', 'uploaded', 'delivered')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'reserved' AND public_ref IS NULL AND delivery_ref IS NULL)
      OR (status = 'uploaded' AND public_ref IS NOT NULL AND delivery_ref IS NULL)
      OR (status = 'delivered' AND public_ref IS NOT NULL AND delivery_ref IS NOT NULL))
);

-- Down Migration
DROP TABLE desk_publications;
