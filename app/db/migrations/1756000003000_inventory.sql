-- Up Migration

-- Physical gear the owner keeps track of. Unlike vault_* this is NOT derived data: rows here
-- are the master copy, so there is no rescan that could rebuild them. Long-form
-- writeups stay in markdown; notes_path points at the vault note for an item.
CREATE TABLE inventory_items (
  id             serial PRIMARY KEY,
  name           text NOT NULL,
  brand          text,
  model          text,
  category       text NOT NULL,
  quantity       integer NOT NULL DEFAULT 1 CHECK (quantity >= 0),
  status         text NOT NULL DEFAULT 'owned',
  acquired_on    date,
  purchase_price numeric(10,2),
  currency       text,
  location       text,
  -- Vault-relative path of the item's note, e.g. Areas/vr-ar/viture-pro-2-xr-glasses.md
  notes_path     text,
  specs          jsonb NOT NULL DEFAULT '{}',
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX inventory_items_category_idx ON inventory_items (category);

-- Down Migration

DROP TABLE IF EXISTS inventory_items;
