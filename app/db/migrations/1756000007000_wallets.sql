-- Up Migration

-- Wallets created from the app. Only public facts live here: the private key
-- is in an encrypted keystore file (data/wallets/<address>.json, mode 600)
-- whose passphrase is never stored by the app. Like inventory_items this is a
-- master copy, not derived data.
CREATE TABLE wallets (
  id            serial PRIMARY KEY,
  label         text NOT NULL,
  address       text NOT NULL UNIQUE CHECK (address ~ '^0x[0-9a-fA-F]{40}$'),
  -- 'hot' today; 'cold' is reserved for a key that never touches a networked box.
  kind          text NOT NULL DEFAULT 'hot' CHECK (kind IN ('hot', 'cold')),
  -- What holds it: 'agent' (an agentic wallet a signer uses on Hermes's behalf) or 'personal'.
  purpose       text NOT NULL DEFAULT 'agent' CHECK (purpose IN ('agent', 'personal')),
  -- Which machine generated the key, so a list on the server and one on the Mac never get confused.
  host          text NOT NULL,
  keystore_file text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Down Migration

DROP TABLE wallets;
