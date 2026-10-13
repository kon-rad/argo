-- Up Migration

-- Server-side sessions for the remote deployment. Only a SHA-256 of the cookie
-- token is stored, so a leaked database dump cannot be replayed as a login.
-- Server-side rather than signed cookies because a lost phone has to be
-- revocable: deleting the row ends the session everywhere, immediately.
CREATE TABLE auth_sessions (
  token_hash   text PRIMARY KEY,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  ip           text,
  user_agent   text
);

CREATE INDEX auth_sessions_expires_idx ON auth_sessions (expires_at);

-- The last TOTP time-step that was accepted. A code is valid for ~90 seconds
-- (the ±1 step window), so without this a shoulder-surfed or proxied code could
-- be replayed within that window. Persisted, not in memory, so a restart does
-- not reopen it.
CREATE TABLE auth_totp_state (
  id        boolean PRIMARY KEY DEFAULT true CHECK (id),
  last_step bigint NOT NULL
);

-- Down Migration

DROP TABLE IF EXISTS auth_totp_state;
DROP TABLE IF EXISTS auth_sessions;
