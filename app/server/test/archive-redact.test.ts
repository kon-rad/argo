import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRedactor, PATTERNS } from '../src/archive/redact.js';

// Fake keys are built at runtime so secret scanners never see a key-shaped literal in this file.
const fake = (prefix: string, n = 40, ch = 'A') => prefix + ch.repeat(n);

describe('buildRedactor', () => {
  const env = {
    GEMINI_API_KEY: 'gemini-value-0123456789',
    SHORT_TOKEN: 'abc123',                       // too short to redact
    PUBLIC_ORIGIN: 'https://brain.example.com',  // not a secret name
    KEY_FILE_PATH: '/home/agent/.config/key.pem', // a path, not a value
    DB_URL: 'postgres://app:hunter2-but-longer@127.0.0.1/db',
  };
  const r = buildRedactor({ env });

  it('replaces env secret values by name, in text and inside nested raw JSON', () => {
    expect(r.text('key is gemini-value-0123456789!')).toBe('key is [redacted:GEMINI_API_KEY]!');
    const raw = { message: { content: [{ type: 'tool_result', content: 'export X=gemini-value-0123456789' }] }, n: 3, ok: true, none: null };
    expect(r.deep(raw)).toEqual({ message: { content: [{ type: 'tool_result', content: 'export X=[redacted:GEMINI_API_KEY]' }] }, n: 3, ok: true, none: null });
  });

  it('leaves short values, non-secret names and paths alone', () => {
    expect(r.text('abc123 https://brain.example.com /home/agent/.config/key.pem')).toBe('abc123 https://brain.example.com /home/agent/.config/key.pem');
    expect(r.values.map((v) => v.name).sort()).toEqual(['DB_URL', 'GEMINI_API_KEY']);
  });

  it('catches key formats with no env value', () => {
    const p = buildRedactor({ env: {} });
    const cases: Array<[string, string]> = [
      [fake('sk-ant-api03-', 40), 'anthropic'], [fake('sk-proj-', 40), 'openai'], [fake('ghp_', 36), 'github'],
      [fake('github_pat_', 40), 'github'], [fake('xoxb-', 30, '1'), 'slack'], [fake('AKIA', 16), 'aws'], [fake('AIza', 35), 'google'],
    ];
    for (const [key, name] of cases) expect(p.text(`use ${key} now`)).toBe(`use [redacted:${name}] now`);
    expect(p.text(`Authorization: Bearer ${'t'.repeat(32)}`)).toBe('Authorization: Bearer [redacted:bearer]');
    expect(p.text('postgres://user:pa55word-long@db.example.com/x')).toBe('postgres://user:[redacted:url-password]@db.example.com/x');
  });

  it('does not touch ordinary words that contain a prefix', () => {
    const p = buildRedactor({ env: {} });
    const s = `task-${'a'.repeat(30)} risk-${'b'.repeat(30)} desk-ops`;
    expect(p.text(s)).toBe(s);
  });

  it('keeps raw valid JSON when a private key spans escaped newlines', () => {
    const p = buildRedactor({ env: {} });
    const pem = `-----BEGIN ${'OPENSSH'} PRIVATE KEY-----\nAAAA\nBBBB\n-----END ${'OPENSSH'} PRIVATE KEY-----`;
    const out = p.deep({ content: `before ${pem} after`, list: [pem] });
    expect(out).toEqual({ content: 'before [redacted:private-key] after', list: ['[redacted:private-key]'] });
  });

  it('reads extra values from env files', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'redact-')), 'extra.env');
    writeFileSync(file, '# comment\nexport HERMES_BOT_TOKEN="bot-token-value-987654"\nPLAIN=nothing-secret-here\n');
    const f = buildRedactor({ env: {}, files: [file, join(tmpdir(), 'missing.env')] });
    expect(f.text('t=bot-token-value-987654')).toBe('t=[redacted:HERMES_BOT_TOKEN]');
    expect(f.text('nothing-secret-here')).toBe('nothing-secret-here');
  });

  it('prefers the longer value when one secret contains another', () => {
    const f = buildRedactor({ env: { A_TOKEN: 'abcdefghijkl', B_TOKEN: 'abcdefghijklmnop' } });
    expect(f.text('abcdefghijklmnop')).toBe('[redacted:B_TOKEN]');
  });

  it('has a Postgres prefilter for every pattern', () => {
    for (const p of PATTERNS) expect(p.pg.length).toBeGreaterThan(5);
  });
});
