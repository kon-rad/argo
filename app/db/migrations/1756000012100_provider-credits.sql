-- db/migrations/1756000012100_provider-credits.sql
-- Up Migration

-- Prepaid API credit balances over time: OpenRouter and fal from their APIs (credits-sync
-- timer on the droplet), Gemini by hand (`secondbrain credits set gemini <balance>`) because
-- Google has no balance API. Amounts are in `currency` as the provider reports them; never
-- converted. A failed reading is a row with status 'error' and no amounts, never a made-up 0.
CREATE TABLE provider_credit_snapshots (
  id            bigserial PRIMARY KEY,
  provider      text NOT NULL CHECK (provider IN ('openrouter', 'fal', 'gemini')),
  origin        text NOT NULL CHECK (origin IN ('api', 'manual')),
  status        text NOT NULL CHECK (status IN ('ok', 'error', 'unsupported')),
  observed_at   timestamptz NOT NULL DEFAULT now(),
  balance       numeric(14, 4),                -- what is left
  total_credits numeric(14, 4),                -- bought to date (OpenRouter)
  total_usage   numeric(14, 4),                -- spent to date (OpenRouter)
  currency      text NOT NULL DEFAULT 'USD',
  error         text,                          -- why there is no amount
  note          text,
  UNIQUE (provider, observed_at)
);
CREATE INDEX provider_credit_observed_idx ON provider_credit_snapshots (observed_at);

-- Down Migration
DROP TABLE provider_credit_snapshots;
