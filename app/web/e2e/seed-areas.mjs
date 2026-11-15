// Seeds a scratch database with made-up areas and projects, so the mobile-overflow check has
// an area page with every section (links, style guide, images, goals, KPIs, roadmap, history)
// and one with none. Run it from app/ after `npm run build`, against a database you can wipe:
//
//   DATABASE_URL=postgres://localhost:5432/<scratch>_test VAULT_ROOT=/tmp/e2e-vault node web/e2e/seed-areas.mjs
//
// It writes the notes into VAULT_ROOT, indexes them, and prints the slugs to pass on as
// E2E_AREA and E2E_PROJECT. It refuses a database whose name does not end in _test.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const url = process.env.DATABASE_URL ?? '';
const root = process.env.VAULT_ROOT ?? '';
if (!/_test$/.test(new URL(url || 'postgres://x/x').pathname) || !root) {
  console.error('seed-areas: set DATABASE_URL to a scratch database ending in _test, and VAULT_ROOT to an empty folder');
  process.exit(2);
}

const { query, pool } = await import('../../server/dist/db.js');
const { scanVault } = await import('../../server/dist/connectors/vault/scan.js');
const t = await import('../../server/dist/projects.js');

const write = (rel, text) => {
  mkdirSync(join(root, rel, '..'), { recursive: true });
  writeFileSync(join(root, rel), text);
};
// A 1x1 PNG: enough for an <img> to load.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

write('Areas/example/README.md', `---
area: example
kind: area
description: An example area with a description long enough to wrap on a phone screen without widening the page at all
goals: [Reach 100 paying users, Keep the response time under 200 ms]
links:
  websites: [https://brain.example.com/a/very/long/path/that/keeps/going/and/going/and/going/index.html, brain.example.com]
  repos: [example-org/example-repository-with-a-long-name]
  socials: Areas/example/social-channels-with-a-very-long-file-name-for-wrapping.md
style:
  guide: Areas/example/brand/style-guide.md
  assets: Areas/example/brand/assets/
  system: Serif headings on ink
kpis:
  - {key: paying-users, name: Paying users, unit: users, target: 100, by: 2027-03-31}
  - {key: response-ms, name: Response time, unit: ms, target: 200, direction: down}
  - {key: posts, name: Posts}
---

# Example

The example area exists so the pages have something to draw. \`a_very_long_inline_code_token_that_cannot_wrap_on_its_own_without_help_from_the_stylesheet\`

## Standards

Not shown.
`);
write('Areas/example/brand/style-guide.md', `# Style guide

Use the serif for headings.

| Token | Value | Use | Notes that are long enough to push a table past a phone screen |
|---|---|---|---|
| ink | #16181d | text | the default colour of every paragraph on every page of the product |
| paper | #ffffff | background | never pure white in the dark theme, where it becomes a deep grey |

\`\`\`
a code block with one very long line that does not wrap: 0123456789 0123456789 0123456789 0123456789 0123456789 0123456789
\`\`\`
`);
for (const name of ['logo.png', 'wordmark-with-a-very-long-file-name-for-truncation.png', 'icon.png']) write(`Areas/example/brand/assets/${name}`, PNG);
write('Areas/example/brand/assets/mark.svg', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>');
write('Areas/example/projects/example-project/README.md', '---\nkind: project\narea: example\nproject: example-project\n---\n\n# Example project\n\nTwo devices show the same entries after a sync.\n');

await query('TRUNCATE verifications, kpi_readings, tracker_events, projects, areas, teams, divisions, vault_files RESTART IDENTITY CASCADE');
const by = 'e2e';
await t.upsertDivision('product', { name: 'Product' });
await t.upsertTeam('apps', { name: 'Apps', lead: 'ada', members: ['ada', 'lin'] });
await t.upsertArea('example', { title: 'Example area', division: 'product', team: 'apps', health: 'green', home_path: 'Areas/example', needs_owner: 'Decide the price before the next release goes out' }, by, { create: true });
await t.upsertArea('quiet', { title: 'Quiet area with no home note' }, by, { create: true });
await t.upsertArea('resting', { title: 'Resting', status: 'parked' }, by, { create: true });
await t.upsertArea('closed', { title: 'Closed' }, by, { create: true });
await t.setAreaArchived('closed', true, by, 'e2e');
await t.upsertProject('example', 'example-project', {
  title: 'Example project', outcome: 'Two devices show the same entries after a sync, including the long ones that wrap', stage: 'building', due: '2026-12-20',
  next_action: 'Write the merge test for entries edited on both devices at once', owner: 'lin',
}, by, { create: true });
await t.upsertProject('example', 'export', { title: 'Export', outcome: 'A zip of every entry', due: '2026-11-01' }, by, { create: true });
await t.upsertProject('quiet', 'tidy', { title: 'Tidy up', stage: 'testing' }, by, { create: true });
await t.upsertProject('example', 'example-project', { stage: 'testing', note: 'merge works on two devices' }, by);
await t.addVerification('example', 'example-project', { kind: 'test', check: 'npm test', result: 'pass', evidence: 'Test Files  3 passed (3)\n     Tests  41 passed (41) in a line that is long enough to need wrapping on a phone' }, by);

const { rows } = await query(`SELECT id FROM sources WHERE kind = 'vault' LIMIT 1`);
await scanVault({ root, sourceId: rows[0].id });
for (const [key, value, at] of [['paying-users', 40, '2026-11-01'], ['paying-users', 75, '2026-11-08'], ['paying-users', 120], ['response-ms', 350]]) {
  await t.recordKpi(root, 'example', { key, value, ...(at ? { at } : {}) }, by);
}
await pool.end();
console.log('seeded. E2E_AREA=example E2E_PROJECT=example-project');
