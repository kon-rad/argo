-- Up Migration

-- An agent's portrait (docs/org-yaml.md "Avatars"): `avatar` is the vault-relative path of the image the app serves
-- at /api/org/avatar/<name>; `avatar_prompt` is the text `cli-org avatar generate` sends to the image model. Both come
-- from the org file through `cli-org import`; NULL means no portrait, and the pages fall back to the name chip.
ALTER TABLE org_agents ADD COLUMN avatar text;
ALTER TABLE org_agents ADD COLUMN avatar_prompt text;

-- Down Migration

ALTER TABLE org_agents DROP COLUMN avatar_prompt;
ALTER TABLE org_agents DROP COLUMN avatar;
