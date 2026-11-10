-- Up Migration
ALTER TABLE social_metric_tokens
  ADD COLUMN token_kind text NOT NULL DEFAULT 'instagram-login' CHECK (token_kind IN ('instagram-login', 'facebook-user')),
  ADD COLUMN asset_id text;
ALTER TABLE social_metric_tokens ADD CONSTRAINT social_metric_token_asset CHECK (token_kind = 'instagram-login' OR asset_id IS NOT NULL);

-- Hashes only. Session revocation invalidates outstanding attempts too.
CREATE TABLE instagram_login_states (
  state_hash text PRIMARY KEY,
  binding_hash text NOT NULL,
  session_hash text NOT NULL REFERENCES auth_sessions(token_hash) ON DELETE CASCADE,
  account text NOT NULL,
  asset_id text NOT NULL,
  redirect_uri text NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX instagram_login_states_expiry ON instagram_login_states(expires_at);
-- Down Migration
DROP TABLE instagram_login_states;
ALTER TABLE social_metric_tokens DROP CONSTRAINT social_metric_token_asset;
ALTER TABLE social_metric_tokens DROP COLUMN asset_id, DROP COLUMN token_kind;
