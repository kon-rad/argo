-- Up Migration

-- Social posting module (first provider: LinkedIn). See
-- Projects/secondbrain-app/social-linkedin-plan.md in the vault for the design.
-- Tokens are encrypted at rest by the app (social/crypto.ts), not by Postgres;
-- these columns hold ciphertext, never a plaintext bearer token.

CREATE TABLE social_accounts (
  id                        bigserial PRIMARY KEY,
  provider                  text NOT NULL CHECK (provider IN ('linkedin', 'x', 'youtube', 'instagram', 'facebook')),
  provider_account_id       text NOT NULL,
  display_name              text NOT NULL,
  access_token              text NOT NULL,
  access_token_expires_at   timestamptz NOT NULL,
  refresh_token             text,
  refresh_token_expires_at  timestamptz,
  reauth_notified_at        timestamptz,
  connected_at              timestamptz NOT NULL DEFAULT now(),
  disconnected_at           timestamptz,
  UNIQUE (provider, provider_account_id)
);

CREATE TABLE social_posts (
  id             bigserial PRIMARY KEY,
  account_id     bigint NOT NULL REFERENCES social_accounts(id),
  body           text NOT NULL,
  media_paths    text[] NOT NULL DEFAULT '{}',
  status         text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'publishing', 'posted', 'failed', 'canceled')),
  scheduled_for  timestamptz NOT NULL,
  posted_at      timestamptz,
  remote_id      text,
  remote_url     text,
  last_error     text,
  attempt_count  int NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX social_posts_due_idx ON social_posts (scheduled_for) WHERE status = 'queued';

-- Down Migration

DROP TABLE social_posts;
DROP TABLE social_accounts;
