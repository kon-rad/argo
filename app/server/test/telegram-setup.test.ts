import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type Env, type Exec, type Fs, botsOf, formatStatus, parseAllow, removeBotConfig, renderTemplate, setEnvLine, status,
  TelegramSetup, tokenFileOf, tokenOf, unitOf, upsertBotConfig,
} from '../src/telegram/setup.js';

// The command against a fake filesystem and shell: what it writes, what it runs, what it refuses.
const TEMPLATES = join(import.meta.dirname, '..', '..', 'deploy', 'telegram');
const BRIDGE_UNIT = join(import.meta.dirname, '..', '..', '..', 'addons', 'telegram-bridge', 'telegram-bridge.service');

class FakeFs implements Fs {
  files = new Map<string, { text: string; mode: number }>();
  dirs = new Set<string>();
  constructor() {
    for (const f of ['claude-telegram.service', 'claude-telegram-clear.service', 'claude-telegram-clear.timer', 'claude-telegram-check.sh',
      'claude-telegram-clear.sh', 'telegram-settings.json', 'telegram-prompt.md']) this.files.set(`${TEMPLATES}/${f}`, { text: readFileSync(join(TEMPLATES, f), 'utf8'), mode: 0o644 });
    this.files.set(BRIDGE_UNIT, { text: readFileSync(BRIDGE_UNIT, 'utf8'), mode: 0o644 });
  }
  exists(p: string) { return this.files.has(p) || this.dirs.has(p); }
  read(p: string) { const f = this.files.get(p); if (!f) throw new Error(`ENOENT ${p}`); return f.text; }
  write(p: string, text: string, mode = 0o644) { this.files.set(p, { text, mode: this.files.get(p)?.mode ?? mode }); }
  remove(p: string) { this.files.delete(p); }
  chmod(p: string, mode: number) { const f = this.files.get(p); if (f) f.mode = mode; }
  mkdir(p: string) { this.dirs.add(p); }
  text(p: string) { return this.read(p); }
}
class FakeExec implements Exec {
  calls: string[] = [];
  constructor(private readonly sudo = true, private readonly active = new Set<string>()) {}
  run(cmd: string, args: string[]) {
    this.calls.push([cmd, ...args].join(' '));
    if (cmd === 'sudo' && args[0] === '-n' && args[1] === 'true') return { code: this.sudo ? 0 : 1, out: this.sudo ? '' : 'a password is required' };
    if (cmd === 'systemctl' && args[0] === 'is-active') return this.active.has(args[1]!) ? { code: 0, out: 'active\n' } : { code: 3, out: 'inactive\n' };
    if (cmd === 'pgrep') return { code: this.active.has('plugin') ? 0 : 1, out: '' };
    return { code: 0, out: '' };
  }
}
const env: Env = {
  home: '/home/agent', user: 'agent', vaultDir: '/home/agent/vault', templateDir: TEMPLATES, stateDir: '/home/agent/.local/share/secondbrain/telegram',
  settingsFile: '/home/agent/vault/secondbrain.json', claudeBin: '/home/agent/.local/bin/claude', bridgeUnitTemplate: BRIDGE_UNIT,
};
const TOKEN = '123456:AAfake-token-for-tests';

describe('pieces', () => {
  it('renders templates and refuses leftovers', () => {
    expect(renderTemplate('a @X@ b @Y@', { X: '1', Y: '2' })).toBe('a 1 b 2');
    expect(() => renderTemplate('a @X@ @Z@', { X: '1' })).toThrow('@Z@');
  });
  it('reads and sets env lines', () => {
    expect(tokenOf('A=1\nTELEGRAM_BOT_TOKEN="t:1"\n')).toBe('t:1');
    expect(tokenOf('A=1\n')).toBeNull();
    expect(setEnvLine('A=1\nTELEGRAM_BOT_TOKEN=old\n', 'TELEGRAM_BOT_TOKEN', 'new')).toBe('A=1\nTELEGRAM_BOT_TOKEN=new\n');
    expect(setEnvLine('', 'K', 'v')).toBe('K=v\n');
  });
  it('validates user ids', () => {
    expect(parseAllow(['1, 22', '333'])).toEqual(['1', '22', '333']);
    expect(() => parseAllow(['@someone'])).toThrow('not a Telegram user id');
  });
  it('edits only telegram.bots in secondbrain.json', () => {
    const start = JSON.stringify({ chat: { x: 1 }, telegram: { bots: [{ name: 'zen', agent: 'zen-agent' }] } });
    const next = upsertBotConfig(start, { name: 'claude', agent: 'claude-code', username: '@mybot' });
    expect(JSON.parse(next)).toEqual({ chat: { x: 1 }, telegram: { bots: [{ name: 'zen', agent: 'zen-agent' }, { name: 'claude', agent: 'claude-code', username: 'mybot' }] } });
    expect(botsOf(removeBotConfig(next, 'zen')).map((b) => b.name)).toEqual(['claude']);
    expect(botsOf(upsertBotConfig(null, { name: 'h', agent: 'hermes', profile: 'main' }))).toEqual([{ name: 'h', agent: 'hermes', profile: 'main' }]);
  });
  it('names units and token files per agent', () => {
    expect(unitOf({ name: 'claude', agent: 'claude-code' })).toBe('claude-telegram');
    expect(unitOf({ name: 'desk', agent: 'claude-code' })).toBe('claude-telegram-desk');
    expect(unitOf({ name: 'zen', agent: 'zen-agent' })).toBe('telegram-bridge');
    expect(unitOf({ name: 'h', agent: 'hermes' })).toBe('hermes-gateway');
    expect(tokenFileOf({ name: 'claude', agent: 'claude-code' }, env)).toBe('/home/agent/.claude/channels/telegram/.env');
    expect(tokenFileOf({ name: 'h', agent: 'hermes', profile: 'writer' }, env)).toBe('/home/agent/.hermes/profiles/writer/.env');
    expect(tokenFileOf({ name: 'zen', agent: 'zen-agent' }, env)).toBe('/home/agent/.zen/telegram-bridge.env');
  });
});

describe('add', () => {
  it('sets up a Claude Code bot: token folder, rendered units with no placeholders left, systemd, config', () => {
    const fs = new FakeFs(); const ex = new FakeExec();
    const steps = new TelegramSetup(fs, ex, env).add({ name: 'claude', agent: 'claude-code', token: ` ${TOKEN}\n`, allow: ['12345'], username: 'mybot', clearAt: '03:30' });
    expect(steps.every((s) => s.ok)).toBe(true);
    expect(fs.text('/home/agent/.claude/channels/telegram/.env')).toBe(`TELEGRAM_BOT_TOKEN=${TOKEN}\n`);
    expect(fs.files.get('/home/agent/.claude/channels/telegram/.env')!.mode).toBe(0o600);
    expect(JSON.parse(fs.text('/home/agent/.claude/channels/telegram/access.json'))).toEqual({ allowFrom: ['12345'] });
    const dir = '/home/agent/.local/share/secondbrain/telegram/claude';
    const unit = fs.text(`${dir}/claude-telegram.service`);
    expect(unit).toContain('User=agent');
    expect(unit).toContain('WorkingDirectory=/home/agent/vault');
    expect(unit).toContain(`tmux -L tg new-session -d -s tg -x 160 -y 50 -c /home/agent/vault "/home/agent/.local/bin/claude --channels plugin:telegram@claude-plugins-official --settings ${dir}/telegram-settings.json`);
    expect(unit).toContain(`ExecStartPost=${dir}/claude-telegram-check.sh`);
    expect(unit).not.toMatch(/@[A-Z_]+@/);
    expect(fs.text(`${dir}/claude-telegram-clear.timer`)).toContain('OnCalendar=*-*-* 03:30:00 UTC');
    expect(fs.text(`${dir}/claude-telegram-clear.timer`)).toContain('Unit=claude-telegram-clear.service');
    expect(fs.text(`${dir}/telegram-settings.json`)).toContain('"Read(//home/agent/.claude/channels/telegram/.env)"');
    expect(fs.text(`${dir}/telegram-prompt.md`)).toContain(`${dir}/claude-telegram-clear.sh --later`);
    expect(fs.files.get(`${dir}/claude-telegram-clear.sh`)!.mode).toBe(0o755);
    expect(ex.calls).toEqual([
      'sudo -n true',
      `sudo install -m 644 ${dir}/claude-telegram.service /etc/systemd/system/claude-telegram.service`,
      `sudo install -m 644 ${dir}/claude-telegram-clear.service /etc/systemd/system/claude-telegram-clear.service`,
      `sudo install -m 644 ${dir}/claude-telegram-clear.timer /etc/systemd/system/claude-telegram-clear.timer`,
      'sudo systemctl daemon-reload', 'sudo systemctl enable --now claude-telegram', 'sudo systemctl enable --now claude-telegram-clear.timer',
    ]);
    expect(botsOf(fs.text(env.settingsFile))).toEqual([{ name: 'claude', agent: 'claude-code', username: 'mybot' }]);
    // Nothing printed holds the token.
    expect(JSON.stringify(steps)).not.toContain(TOKEN);
  });

  it('without sudo it writes everything and hands back the commands; --no-install never asks', () => {
    const fs = new FakeFs(); const ex = new FakeExec(false);
    const steps = new TelegramSetup(fs, ex, env).add({ name: 'claude', agent: 'claude-code', token: TOKEN, allow: ['12345'] });
    const sys = steps.find((s) => s.what.startsWith('systemd'))!;
    expect(sys.ok).toBe(false);
    expect(sys.detail).toContain('sudo systemctl enable --now claude-telegram');
    expect(fs.text('/home/agent/.local/share/secondbrain/telegram/claude/claude-telegram-clear.timer')).toContain('19:00:00 UTC');
    const ex2 = new FakeExec();
    new TelegramSetup(new FakeFs(), ex2, env).add({ name: 'claude', agent: 'claude-code', token: TOKEN, allow: ['12345'], noInstall: true });
    expect(ex2.calls).toEqual([]);
  });

  it('sets up the zen bridge from the add-on unit, and names the bot for the usage page', () => {
    const fs = new FakeFs(); const ex = new FakeExec();
    fs.write('/home/agent/.zen/telegram-bridge.env', 'ZEN_TOOLS=fs\nBRIDGE_MAX_TURNS=10\n');
    const steps = new TelegramSetup(fs, ex, env).add({ name: 'zen', agent: 'zen-agent', token: TOKEN, allow: ['12345', '67890'], persona: 'sol' });
    expect(steps.every((s) => s.ok)).toBe(true);
    const envText = fs.text('/home/agent/.zen/telegram-bridge.env');
    expect(envText).toBe(`ZEN_TOOLS=fs\nBRIDGE_MAX_TURNS=10\nTELEGRAM_BOT_TOKEN=${TOKEN}\nTELEGRAM_ALLOWED_USERS=12345,67890\nBRIDGE_WORKDIR=/home/agent/vault\nBRIDGE_BOT_NAME=zen\nZEN_PERSONA=sol\n`);
    const unit = fs.text('/home/agent/.local/share/secondbrain/telegram/zen/telegram-bridge.service');
    expect(unit).toContain('User=agent');
    expect(unit).toContain('EnvironmentFile=/home/agent/.zen/telegram-bridge.env');
    expect(unit).toContain('ExecStart=/usr/bin/python3 /home/agent/vault/.secondbrain/addons/telegram-bridge/bridge.py');
    expect(unit).not.toContain('<user>');
    expect(ex.calls).toContain('sudo systemctl enable --now telegram-bridge');
    expect(botsOf(fs.text(env.settingsFile))).toEqual([{ name: 'zen', agent: 'zen-agent', persona: 'sol' }]);
  });

  it('puts a Hermes token in its home and explains the rest, and needs a Hermes home', () => {
    const fs = new FakeFs(); const ex = new FakeExec();
    expect(() => new TelegramSetup(fs, ex, env).add({ name: 'hermes', agent: 'hermes', token: TOKEN, allow: ['12345'] })).toThrow('no Hermes home');
    fs.mkdir('/home/agent/.hermes');
    fs.write('/home/agent/.hermes/.env', 'OPENROUTER_API_KEY=x\n');
    const steps = new TelegramSetup(fs, ex, env).add({ name: 'hermes', agent: 'hermes', token: TOKEN, allow: ['12345'] });
    expect(fs.text('/home/agent/.hermes/.env')).toBe(`OPENROUTER_API_KEY=x\nTELEGRAM_BOT_TOKEN=${TOKEN}\n`);
    expect(steps.find((s) => s.what.startsWith('Hermes allowlist'))!.detail).toContain('12345');
    expect(ex.calls).toEqual([]);
  });

  it('refuses an empty allowlist, a reused token, a second Claude Code bot and a bad name', () => {
    const fs = new FakeFs(); const ex = new FakeExec();
    const s = new TelegramSetup(fs, ex, env);
    expect(() => s.add({ name: 'claude', agent: 'claude-code', token: TOKEN, allow: [] })).toThrow('--allow');
    expect(() => s.add({ name: 'Bad Name', agent: 'claude-code', token: TOKEN, allow: ['1'] })).toThrow('bot name');
    expect(() => s.add({ name: 'claude', agent: 'claude-code', token: 'has space', allow: ['1'] })).toThrow('spaces');
    s.add({ name: 'claude', agent: 'claude-code', token: TOKEN, allow: ['12345'] });
    expect(() => s.add({ name: 'zen', agent: 'zen-agent', token: TOKEN, allow: ['12345'] })).toThrow('already uses this token');
    expect(() => s.add({ name: 'desk', agent: 'claude-code', token: 'other:tok', allow: ['12345'] })).toThrow('already answers bot "claude"');
  });
});

describe('allow and remove', () => {
  it('edits the allowlist in place and restarts the unit; never empties it', () => {
    const fs = new FakeFs(); const ex = new FakeExec();
    const s = new TelegramSetup(fs, ex, env);
    s.add({ name: 'claude', agent: 'claude-code', token: TOKEN, allow: ['12345'] });
    s.add({ name: 'zen', agent: 'zen-agent', token: 'tok:2', allow: ['12345', '67890'] });
    ex.calls = [];
    s.allow('claude', 'add', ['777']);
    expect(JSON.parse(fs.text('/home/agent/.claude/channels/telegram/access.json'))).toEqual({ allowFrom: ['12345', '777'] });
    expect(ex.calls).toEqual(['sudo -n systemctl restart claude-telegram']);
    s.allow('zen', 'remove', ['12345', '1']);
    expect(fs.text('/home/agent/.zen/telegram-bridge.env')).toContain('TELEGRAM_ALLOWED_USERS=67890\n');
    expect(() => s.allow('claude', 'remove', ['12345', '777'])).toThrow('empty');
    expect(() => s.allow('nope', 'add', ['1'])).toThrow('no bot "nope"');
  });

  it('removes a bot: units, token files and the config entry', () => {
    const fs = new FakeFs(); const ex = new FakeExec();
    const s = new TelegramSetup(fs, ex, env);
    s.add({ name: 'claude', agent: 'claude-code', token: TOKEN, allow: ['12345'] });
    ex.calls = [];
    const steps = s.remove('claude');
    expect(steps.every((st) => st.ok)).toBe(true);
    expect(ex.calls).toEqual(['sudo -n true', 'sudo systemctl disable --now claude-telegram', 'sudo systemctl disable --now claude-telegram-clear.timer',
      'sudo rm -f /etc/systemd/system/claude-telegram.service', 'sudo rm -f /etc/systemd/system/claude-telegram-clear.service',
      'sudo rm -f /etc/systemd/system/claude-telegram-clear.timer', 'sudo systemctl daemon-reload']);
    expect(fs.exists('/home/agent/.claude/channels/telegram/.env')).toBe(false);
    expect(fs.exists('/home/agent/.claude/channels/telegram/access.json')).toBe(false);
    expect(botsOf(fs.text(env.settingsFile))).toEqual([]);
  });
});

describe('status', () => {
  it('checks each bot and the token rule, counts its sessions, and says what to do', async () => {
    const fs = new FakeFs();
    const s = new TelegramSetup(fs, new FakeExec(), env);
    s.add({ name: 'claude', agent: 'claude-code', token: TOKEN, allow: ['12345'] });
    s.add({ name: 'zen', agent: 'zen-agent', token: 'tok:2', allow: ['12345'] });
    fs.write(env.settingsFile, upsertBotConfig(fs.text(env.settingsFile), { name: 'ghost', agent: 'zen-agent' }));   // registered, no files
    const ex = new FakeExec(true, new Set(['claude-telegram', 'plugin']));
    const r = await status({ fs, exec: ex, env }, {
      getMe: async (t) => (t === TOKEN ? 'mybot' : t === 'tok:2' ? null : undefined),
      sessions: async (bot) => (bot === 'claude' ? { n: 18, last: '2026-10-30 19:05 UTC' } : { n: 0, last: null }),
    });
    expect(r.bots.map((b) => [b.name, b.token, b.username, b.unitActive, b.processUp, b.sessions?.n])).toEqual([
      ['claude', 'valid', 'mybot', true, true, 18], ['zen', 'invalid', null, false, null, 0], ['ghost', 'missing', null, false, null, 0],
    ]);
    expect(r.bots[0]!.problems).toEqual([]);
    expect(r.bots[1]!.problems[0]).toContain('rejects the token');
    expect(r.bots[2]!.problems[0]).toContain('no TELEGRAM_BOT_TOKEN');
    const text = formatStatus(r, 'https://example.test');
    expect(text).toContain('✓ claude (claude-code, @mybot)  token valid  claude-telegram: active, plugin up  sessions on /usage: 18, last 2026-10-30 19:05 UTC');
    expect(text).toContain('https://example.test/usage?s_channel=telegram');
    expect(text).not.toContain(TOKEN);
  });

  it('flags two bots on one token', async () => {
    const fs = new FakeFs();
    fs.write(env.settingsFile, upsertBotConfig(upsertBotConfig(null, { name: 'claude', agent: 'claude-code' }), { name: 'zen', agent: 'zen-agent' }));
    fs.write('/home/agent/.claude/channels/telegram/.env', `TELEGRAM_BOT_TOKEN=${TOKEN}\n`);
    fs.write('/home/agent/.zen/telegram-bridge.env', `TELEGRAM_BOT_TOKEN=${TOKEN}\n`);
    const r = await status({ fs, exec: new FakeExec(), env }, { getMe: async () => 'mybot', sessions: async () => null });
    expect(r.problems).toEqual(['bots claude and zen share one token: two pollers on one bot break both']);
    expect(formatStatus(r, null)).toContain('sessions: no database from here');
  });
});
