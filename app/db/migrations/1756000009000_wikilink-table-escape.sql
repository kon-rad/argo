-- Up Migration

-- `[[target\|alias]]` is how an aliased wikilink is written inside a table.
-- The scanner used to keep the backslash in target_raw, so those links never
-- resolved. parse.ts now drops it; this fixes rows from notes that haven't
-- changed since (the scan only re-parses changed content). The next scan's
-- resolve pass links them.
UPDATE vault_links SET target_raw = left(target_raw, -1) WHERE right(target_raw, 1) = '\';

-- Down Migration

-- Nothing to undo: the old value was a parsing bug.
