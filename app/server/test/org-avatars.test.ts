import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { avatarPrompt, avatarTarget, DEFAULT_AVATAR_STYLE, generateAvatar, resolveVaultFile, subjectsFromOrgFile, type FetchLike } from '../src/org-avatars.js';

/** Portrait generation without a network: the prompt, the vault gate, and a fake image model. */

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const SETTINGS = { dir: '.agents/org/avatars', model: 'fake-image-model', reference: undefined, style: undefined };

function vault(): string {
  const root = mkdtempSync(join(tmpdir(), 'sb-avatar-'));
  mkdirSync(join(root, 'pics'), { recursive: true });
  return root;
}

const fakeModel = (calls: { url: string; body: unknown }[], mime = 'image/png'): FetchLike => async (url, init) => {
  calls.push({ url, body: JSON.parse(init.body) });
  return { ok: true, status: 200, text: async () => JSON.stringify({ candidates: [{ content: { parts: [{ text: 'here you go' }, { inlineData: { mimeType: mime, data: PNG.toString('base64') } }] } }] }) };
};

describe('avatar prompts and paths', () => {
  it('puts the shared style before the agent prompt, and falls back to the role', () => {
    const p = avatarPrompt({ name: 'rune', role: 'Platform engineer', avatar_prompt: 'A bust holding a wrench.' });
    expect(p.startsWith(DEFAULT_AVATAR_STYLE)).toBe(true);
    expect(p).toContain('This character: rune, Platform engineer.');
    expect(p.endsWith('A bust holding a wrench.')).toBe(true);
    expect(avatarPrompt({ name: 'vera', role: 'Reviewer', expertise: 'diffs' }, 'House style.')).toBe('House style.\n\nThis character: vera, Reviewer.\nA portrait that says "Reviewer": diffs.');
  });

  it('keeps files inside the vault', () => {
    const root = vault();
    expect(resolveVaultFile(root, 'pics/a.jpg')).toBe(join(root, 'pics', 'a.jpg'));
    expect(resolveVaultFile(root, '../a.jpg')).toBeNull();
    expect(resolveVaultFile(root, 'pics/../../a.jpg')).toBeNull();
    expect(resolveVaultFile(root, '/etc/passwd')).toBeNull();
    expect(resolveVaultFile(root, '')).toBeNull();
    expect(resolveVaultFile(root, null)).toBeNull();
  });

  it('names the file after the agent, next to the old one or in the settings folder', () => {
    expect(avatarTarget({ name: 'sol', role: 'x', avatar: 'Areas/team/avatars/sol.jpg' }, 'image/png')).toBe('Areas/team/avatars/sol.png');
    expect(avatarTarget({ name: 'sol', role: 'x' }, 'image/jpeg', '.agents/org/avatars')).toBe('.agents/org/avatars/sol.jpg');
  });

  it('reads bots from a compiled org file and skips humans', () => {
    const doc = { agents: { owner: { runtime: 'human', role: 'CEO' }, rune: { role: 'Platform engineer', avatar_prompt: 'wrench' }, m4: { runtime: 'session', role: 'vault' } } };
    expect(subjectsFromOrgFile(doc).map((a) => a.name)).toEqual(['rune']);
    expect(() => subjectsFromOrgFile(doc, ['owner'])).toThrow(/no bot named/);
  });
});

describe('generateAvatar', () => {
  it('skips an agent whose file exists unless forced', async () => {
    const root = vault();
    writeFileSync(join(root, 'pics', 'sol.jpg'), PNG);
    const calls: { url: string; body: unknown }[] = [];
    const r = await generateAvatar({ name: 'sol', role: 'Chief of Staff', avatar: 'pics/sol.jpg' }, { vaultRoot: root, apiKey: 'k', fetchImpl: fakeModel(calls), settings: SETTINGS });
    expect(r.skipped).toBe('exists');
    expect(calls).toHaveLength(0);
    const forced = await generateAvatar({ name: 'sol', role: 'Chief of Staff', avatar: 'pics/sol.jpg' }, { vaultRoot: root, apiKey: 'k', force: true, fetchImpl: fakeModel(calls), settings: SETTINGS });
    expect(forced.skipped).toBeNull();
    expect(forced.path).toBe('pics/sol.png');
    expect(readFileSync(join(root, 'pics', 'sol.png'))).toEqual(PNG);
    expect(calls).toHaveLength(1);
  });

  it('sends the style, the prompt and the reference image, writes to the settings folder, and records the note', async () => {
    const root = vault();
    writeFileSync(join(root, 'pics', 'ref.jpg'), Buffer.from('ffd8ffe0', 'hex'));
    const calls: { url: string; body: { contents: { parts: { text?: string; inlineData?: { mimeType: string } }[] }[] } }[] = [];
    const r = await generateAvatar(
      { name: 'rune', role: 'Platform engineer', avatar_prompt: 'A bust holding a wrench.' },
      { vaultRoot: root, apiKey: 'k', fetchImpl: fakeModel(calls as never, 'image/jpeg'), settings: { ...SETTINGS, reference: 'pics/ref.jpg', style: 'Gold low-poly.' } },
    );
    expect(r.path).toBe('.agents/org/avatars/rune.jpg');
    expect(existsSync(join(root, '.agents', 'org', 'avatars', 'rune.jpg'))).toBe(true);
    expect(r.note).toBe('here you go');
    expect(calls[0]!.url).toContain('/models/fake-image-model:generateContent');
    const parts = calls[0]!.body.contents[0]!.parts;
    expect(parts[0]!.text).toBe('Gold low-poly.\n\nThis character: rune, Platform engineer.\nA bust holding a wrench.');
    expect(parts[1]!.inlineData?.mimeType).toBe('image/jpeg');
  });

  it('dry-run prints the prompt and writes nothing; no key is an error', async () => {
    const root = vault();
    const r = await generateAvatar({ name: 'rune', role: 'Platform engineer' }, { vaultRoot: root, dryRun: true, settings: SETTINGS });
    expect(r.skipped).toBe('dry-run');
    expect(r.note).toContain('This character: rune');
    expect(existsSync(join(root, '.agents'))).toBe(false);
    delete process.env['GEMINI_API_KEY'];
    await expect(generateAvatar({ name: 'rune', role: 'Platform engineer' }, { vaultRoot: root, settings: SETTINGS })).rejects.toThrow(/GEMINI_API_KEY/);
  });

  it('reports a model that returns no image', async () => {
    const root = vault();
    const empty: FetchLike = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ candidates: [{ content: { parts: [{ text: 'cannot draw that' }] } }] }) });
    await expect(generateAvatar({ name: 'rune', role: 'x' }, { vaultRoot: root, apiKey: 'k', fetchImpl: empty, settings: SETTINGS })).rejects.toThrow(/no image.*cannot draw that/);
    const http: FetchLike = async () => ({ ok: false, status: 429, text: async () => 'quota' });
    await expect(generateAvatar({ name: 'rune', role: 'x' }, { vaultRoot: root, apiKey: 'k', fetchImpl: http, settings: SETTINGS })).rejects.toThrow(/HTTP 429 quota/);
  });
});
