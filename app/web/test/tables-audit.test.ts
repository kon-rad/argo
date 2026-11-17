import { describe, expect, it } from 'vitest';

/**
 * The route audit, kept true by a test: every table in the web app says what it does on a phone. A data table goes
 * through components/DataTable.tsx and picks `cards` or `scroll`; the few small tables that stay plain are listed
 * here with the reason. A new `<table>` fails this until it is one or the other.
 */

// The source text of every component and route, as Vite reads it.
const SOURCES = import.meta.glob<string>('../src/**/*.tsx', { query: '?raw', import: 'default', eager: true });

/** Plain tables: two or three short columns that fit a phone as they are. */
const PLAIN: Record<string, string> = {
  'components/FileView.tsx': 'Frontmatter: a key and its value; the key stays on one line, the value wraps',
  'components/ShortcutsHelp.tsx': 'Keyboard shortcuts: a key and what it does, in a 288 px panel',
  'routes/Cron.tsx': 'Job list: one cell of text and a state badge; each row is one link',
  'routes/Database.tsx': 'Schema columns in the sidebar: name, type and badges',
  'routes/Fund.tsx': 'Health: skill, when and result, no header',
};

/** Every DataTable in the app and its phone pattern. Changing one is a design decision: change it here too. */
const DATA_TABLES: Record<string, string[]> = {
  'routes/Cron.tsx': ['cards'],
  'routes/Data.tsx': ['cards', 'scroll', 'cards', 'cards'],
  'routes/Database.tsx': ['scroll'],
  'routes/Fund.tsx': ['cards', 'scroll'],
  'routes/Projects.tsx': ['cards', 'cards'],
  'routes/Ring.tsx': ['scroll'],
  'routes/org/Org.tsx': ['cards'],
  'routes/usage/AgentSessions.tsx': ['cards'],
  'routes/usage/Running.tsx': ['cards'],
  'routes/usage/Summaries.tsx': ['scroll'],
  'routes/usage/Usage.tsx': ['scroll', 'cards', 'scroll'],
};

const files = Object.entries(SOURCES)
  .map(([path, code]) => ({ file: path.replace('../src/', ''), code }))
  .filter((f) => f.file !== 'components/DataTable.tsx');

describe('every table in the app has a phone layout', () => {
  it('a plain <table> is on the short list, once per file', () => {
    const plain = Object.fromEntries(files.map((f) => [f.file, (f.code.match(/<table\b/g) ?? []).length]).filter(([, n]) => n));
    expect(plain).toEqual(Object.fromEntries(Object.keys(PLAIN).map((file) => [file, 1])));
  });

  it('every other table is a DataTable with a pattern chosen for it', () => {
    const found = Object.fromEntries(files
      .map((f) => [f.file, [...f.code.matchAll(/<DataTable\b[^>]*?\bphone="(cards|scroll)"/g)].map((m) => m[1])] as const)
      .filter(([, patterns]) => patterns.length));
    expect(found).toEqual(DATA_TABLES);
    // No DataTable slipped past the pattern above (a computed `phone`, say).
    const uses = files.reduce((n, f) => n + (f.code.match(/<DataTable\b/g) ?? []).length, 0);
    expect(uses).toBe(Object.values(DATA_TABLES).flat().length);
  });

  it('no table hides a column on a phone to make the rest fit', () => {
    const hidden = files.flatMap((f) => [...f.code.matchAll(/<t[dh]\b[^>]*className=[^>]*\b(?:max-md:hidden|hidden (?:md|sm|lg):table-cell)\b/g)].map(() => f.file));
    expect(hidden).toEqual([]);
  });
});

// Vitest hands a test an empty string for any .css import, ?raw included, so the stylesheet is read from disk.
// The web tsconfig has no Node types (browser code must not lean on them): the two calls are typed here.
const { readFileSync } = await import('node:fs' as string) as { readFileSync(path: string, encoding: 'utf8'): string };
const css = readFileSync(`${(import.meta as unknown as { dirname: string }).dirname}/../src/index.css`, 'utf8');

describe('index.css', () => {
  /** The text of every top-level `@media (max-width: 767px)` block, and what is left outside them. */
  function split(): { phone: string; rest: string } {
    let phone = '';
    let rest = '';
    let at = 0;
    for (;;) {
      const start = css.indexOf('@media (max-width: 767px)', at);
      if (start < 0) break;
      rest += css.slice(at, start);
      let depth = 0;
      let i = css.indexOf('{', start);
      do { depth += css[i] === '{' ? 1 : css[i] === '}' ? -1 : 0; i += 1; } while (depth > 0);
      phone += css.slice(start, i);
      at = i;
    }
    return { phone, rest: rest + css.slice(at) };
  }
  const { phone, rest } = split();

  it('has no blanket rule that turns every table into a scrolling block', () => {
    const blanket = [...css.matchAll(/(^|[},{]\s*)table\s*\{[^}]*\}/g)].map((m) => m[0].trim());
    expect(blanket).toEqual([]);
  });

  it('keeps every DataTable rule inside the phone breakpoint, so the desktop table is the one it always was', () => {
    for (const hook of ['data-phone', 'data-table-frame', 'data-table-scroll', 'data-table-hint', 'data-more-']) {
      expect(phone, `${hook} is styled for phones`).toContain(hook);
      expect(rest, `${hook} outside the phone breakpoint`).not.toContain(hook);
    }
  });

  it('gives both patterns what they promise', () => {
    // cards: the header stays for screen readers, and each tile prints its label
    expect(phone).toMatch(/table\[data-phone="cards"\] > thead \{[^}]*clip-path/);
    expect(phone).not.toMatch(/table\[data-phone="cards"\][^{]*thead[^{]*\{[^}]*display:\s*none/);
    expect(phone).toMatch(/td\[data-label\]::before \{\s*content: attr\(data-label\)/);
    // scroll: whole words, a pinned first column, a mark on the edge that has more, a visible focus ring
    expect(phone).toMatch(/table\[data-phone="scroll"\] \{[^}]*width: max-content/);
    expect(phone).toMatch(/table\[data-phone="scroll"\] > \* > tr > :first-child \{[^}]*position: sticky; left: 0/);
    expect(phone).toMatch(/\.data-table-frame\[data-more-right\]::after/);
    expect(phone).toMatch(/\.data-table-scroll:focus-visible \{[^}]*outline/);
    // links in a row are thumb-sized
    expect(phone).toMatch(/table\[data-phone\] td a \{[^}]*min-height: 44px/);
  });
});
