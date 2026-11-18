/**
 * `secondbrain telegram`: connect a Telegram bot to an agent (Claude Code, Hermes or zen-agent), check it, change
 * its allowlist, remove it (docs/onboarding/11-telegram.md). This module is the logic with every side effect
 * behind an interface, so tests run it against a fake filesystem and shell; cli-telegram.ts wires the real ones.
 *
 * What a bot is made of, per agent:
 *   claude-code  the channel plugin's folder ~/.claude/channels/telegram/ (.env with the token, access.json with the
 *                allowlist), a settings file and a prompt file rendered from deploy/telegram/, a systemd unit running
 *                Claude Code in its own tmux server, and a nightly /clear timer. One bot per user: the plugin reads one folder.
 *   hermes       the token in the Hermes home's .env; the gateway's own config holds the allowlist (its keys move
 *                between Hermes versions, so this prints the snippet rather than editing YAML).
 *   zen-agent    ~/.zen/telegram-bridge.env and the add-on's unit (addons/telegram-bridge).
 * All three are registered in secondbrain.json `telegram.bots`, which is what labels their sessions on /usage.
 */
import type { TelegramBotSetting } from '../settings.js';

export type Agent = TelegramBotSetting['agent'];

export interface Fs {
  exists(path: string): boolean;
  read(path: string): string;
  /** Writes the file (parents created); `mode` is the octal mode for a new file. */
  write(path: string, text: string, mode?: number): void;
  remove(path: string): void;
  chmod(path: string, mode: number): void;
  mkdir(path: string, mode?: number): void;
}

export interface Exec {
  /** Runs a command; never throws. */
  run(cmd: string, args: string[]): { code: number; out: string };
}

export interface Env {
  home: string;
  user: string;
  vaultDir: string;
  /** app/deploy/telegram */
  templateDir: string;
  /** addons/telegram-bridge/telegram-bridge.service (next to the app in a checkout, or under the vault's .secondbrain) */
  bridgeUnitTemplate: string;
  /** Where rendered units and scripts go before systemd: ~/.local/share/secondbrain/telegram/<bot>/ */
  stateDir: string;
  settingsFile: string;
  /** Claude Code binary for the unit; unset: `claude` on the unit's PATH. */
  claudeBin?: string;
  hermesHome?: string;
}

export interface AddOptions {
  name: string;
  agent: Agent;
  token: string;
  allow: string[];
  username?: string;
  persona?: string;
  profile?: string;
  /** HH:MM UTC for the nightly /clear (Claude Code). Default 19:00. */
  clearAt?: string;
  /** Render and write files, but do not touch systemd. */
  noInstall?: boolean;
}

export interface Step { what: string; ok: boolean; detail?: string }

export const NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;
const USER_ID_RE = /^[0-9]{1,20}$/;
const CLEAR_RE = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

export function renderTemplate(text: string, vars: Record<string, string>): string {
  const out = text.replace(/@([A-Z_]+)@/g, (m, k: string) => (k in vars ? vars[k]! : m));
  const left = out.match(/@[A-Z_]+@/g);
  if (left) throw new Error(`template still has ${[...new Set(left)].join(', ')}`);
  return out;
}

/** The TELEGRAM_BOT_TOKEN line of an env file, unquoted; null when absent. */
export function tokenOf(envText: string | null): string | null {
  if (!envText) return null;
  const m = envText.split('\n').find((l) => l.startsWith('TELEGRAM_BOT_TOKEN='));
  if (!m) return null;
  const v = m.slice('TELEGRAM_BOT_TOKEN='.length).trim().replace(/^"(.*)"$/, '$1');
  return v || null;
}

/** Sets or replaces one KEY=value line, keeping the rest of the file. */
export function setEnvLine(envText: string, key: string, value: string): string {
  const lines = envText ? envText.replace(/\n$/, '').split('\n') : [];
  const i = lines.findIndex((l) => l.startsWith(`${key}=`));
  if (i >= 0) lines[i] = `${key}=${value}`; else lines.push(`${key}=${value}`);
  return lines.join('\n') + '\n';
}

export function parseAllow(values: string[]): string[] {
  const ids = values.flatMap((v) => v.split(',')).map((s) => s.trim()).filter(Boolean);
  for (const id of ids) if (!USER_ID_RE.test(id)) throw new Error(`"${id}" is not a Telegram user id (digits only; ask @userinfobot)`);
  return [...new Set(ids)];
}

/** Adds or replaces the bot in secondbrain.json's `telegram.bots`, keeping every other key of the file as it is. */
export function upsertBotConfig(jsonText: string | null, bot: TelegramBotSetting): string {
  const root: Record<string, unknown> = jsonText && jsonText.trim() ? JSON.parse(jsonText) : {};
  const tg = (root.telegram && typeof root.telegram === 'object' ? root.telegram : {}) as Record<string, unknown>;
  const bots = Array.isArray(tg.bots) ? (tg.bots as TelegramBotSetting[]) : [];
  const entry: TelegramBotSetting = { name: bot.name, agent: bot.agent };
  if (bot.username) entry.username = bot.username.replace(/^@/, '');
  if (bot.profile) entry.profile = bot.profile;
  if (bot.persona) entry.persona = bot.persona;
  const i = bots.findIndex((b) => b.name === bot.name);
  if (i >= 0) bots[i] = entry; else bots.push(entry);
  root.telegram = { ...tg, bots };
  return JSON.stringify(root, null, 2) + '\n';
}

export function removeBotConfig(jsonText: string | null, name: string): string {
  const root: Record<string, unknown> = jsonText && jsonText.trim() ? JSON.parse(jsonText) : {};
  const tg = (root.telegram && typeof root.telegram === 'object' ? root.telegram : {}) as Record<string, unknown>;
  const bots = (Array.isArray(tg.bots) ? (tg.bots as TelegramBotSetting[]) : []).filter((b) => b.name !== name);
  root.telegram = { ...tg, bots };
  return JSON.stringify(root, null, 2) + '\n';
}

export function botsOf(jsonText: string | null): TelegramBotSetting[] {
  if (!jsonText || !jsonText.trim()) return [];
  try {
    const root = JSON.parse(jsonText) as { telegram?: { bots?: TelegramBotSetting[] } };
    return Array.isArray(root.telegram?.bots) ? root.telegram.bots : [];
  } catch { return []; }
}

/** The systemd unit a bot runs under. The first Claude Code bot keeps the historical name `claude-telegram`. */
export function unitOf(bot: TelegramBotSetting): string | null {
  if (bot.agent === 'claude-code') return bot.name === 'claude' ? 'claude-telegram' : `claude-telegram-${bot.name}`;
  if (bot.agent === 'zen-agent') return bot.name === 'zen' ? 'telegram-bridge' : `telegram-bridge-${bot.name}`;
  return 'hermes-gateway';
}

/** Where each agent keeps the bot token (an env file with TELEGRAM_BOT_TOKEN=). */
export function tokenFileOf(bot: TelegramBotSetting, env: Env): string {
  if (bot.agent === 'claude-code') return `${env.home}/.claude/channels/telegram/.env`;
  if (bot.agent === 'zen-agent') return bot.name === 'zen' ? `${env.home}/.zen/telegram-bridge.env` : `${env.home}/.zen/telegram-bridge-${bot.name}.env`;
  const hermes = env.hermesHome ?? `${env.home}/.hermes`;
  return bot.profile && bot.profile !== 'main' ? `${hermes}/profiles/${bot.profile}/.env` : `${hermes}/.env`;
}

function tmuxSocket(name: string): string {
  return name === 'claude' ? 'tg' : `tg-${name}`;
}

export class TelegramSetup {
  constructor(private readonly fs: Fs, private readonly exec: Exec, private readonly env: Env) {}

  private settingsText(): string | null {
    return this.fs.exists(this.env.settingsFile) ? this.fs.read(this.env.settingsFile) : null;
  }

  bots(): TelegramBotSetting[] { return botsOf(this.settingsText()); }

  /** Writes the token file, the allowlist, the rendered files and the config entry. Returns what it did. */
  add(o: AddOptions): Step[] {
    const steps: Step[] = [];
    if (!NAME_RE.test(o.name)) throw new Error(`bot name "${o.name}" must be lowercase letters, digits and dashes`);
    const token = o.token.trim();
    if (!token || /\s/.test(token)) throw new Error('the token is empty or has spaces in it; paste it exactly as BotFather gave it');
    const allow = parseAllow(o.allow);
    if (!allow.length) throw new Error('--allow <your Telegram user id> is required: a bot with an empty allowlist answers everyone');
    const bot: TelegramBotSetting = { name: o.name, agent: o.agent, username: o.username, profile: o.profile, persona: o.persona };
    const existing = this.bots();
    const clash = existing.find((b) => b.name !== o.name && b.agent === o.agent && o.agent === 'claude-code');
    if (clash) throw new Error(`Claude Code already answers bot "${clash.name}" for this user; the channel plugin reads one token folder. Remove it first or use another agent`);
    for (const other of existing) {
      if (other.name === o.name) continue;
      const f = tokenFileOf(other, this.env);
      if (this.fs.exists(f) && tokenOf(this.fs.read(f)) === token) throw new Error(`bot "${other.name}" already uses this token; a token has exactly one poller`);
    }

    const tokenFile = tokenFileOf(bot, this.env);
    if (o.agent === 'claude-code') {
      const dir = `${this.env.home}/.claude/channels/telegram`;
      this.fs.mkdir(dir, 0o700);
      this.fs.write(tokenFile, `TELEGRAM_BOT_TOKEN=${token}\n`, 0o600);
      this.fs.chmod(tokenFile, 0o600);
      this.fs.write(`${dir}/access.json`, JSON.stringify({ allowFrom: allow }, null, 2) + '\n', 0o600);
      this.fs.chmod(`${dir}/access.json`, 0o600);
      steps.push({ what: `token and allowlist in ${dir}/ (mode 600)`, ok: true });
      steps.push(...this.renderClaude(bot, o.clearAt ?? '19:00'));
      steps.push(...this.installUnits(bot, o.noInstall));
    } else if (o.agent === 'zen-agent') {
      this.fs.mkdir(`${this.env.home}/.zen`, 0o700);
      let text = this.fs.exists(tokenFile) ? this.fs.read(tokenFile) : '';
      text = setEnvLine(text, 'TELEGRAM_BOT_TOKEN', token);
      text = setEnvLine(text, 'TELEGRAM_ALLOWED_USERS', allow.join(','));
      text = setEnvLine(text, 'BRIDGE_WORKDIR', this.env.vaultDir);
      text = setEnvLine(text, 'BRIDGE_BOT_NAME', o.name);
      if (o.persona) text = setEnvLine(text, 'ZEN_PERSONA', o.persona);
      if (!/^ZEN_TOOLS=/m.test(text)) text = setEnvLine(text, 'ZEN_TOOLS', 'fs,skills,knowledge,org');
      this.fs.write(tokenFile, text, 0o600);
      this.fs.chmod(tokenFile, 0o600);
      steps.push({ what: `token, allowlist and bridge settings in ${tokenFile} (mode 600)`, ok: true });
      steps.push(...this.renderBridge(bot, tokenFile));
      steps.push(...this.installUnits(bot, o.noInstall));
    } else {
      const hermesHome = this.env.hermesHome ?? `${this.env.home}/.hermes`;
      if (!this.fs.exists(hermesHome)) throw new Error(`no Hermes home at ${hermesHome} (HERMES_HOME); connect Hermes first (docs/onboarding/04-hermes.md)`);
      const text = this.fs.exists(tokenFile) ? this.fs.read(tokenFile) : '';
      this.fs.write(tokenFile, setEnvLine(text, 'TELEGRAM_BOT_TOKEN', token), 0o600);
      this.fs.chmod(tokenFile, 0o600);
      steps.push({ what: `token in ${tokenFile}`, ok: true });
      steps.push({ what: 'Hermes allowlist and platform switch', ok: true, detail:
        `Hermes keeps these in its own config. In ${hermesHome}/config.yaml set gateway.platforms.telegram.enabled: true and its allowed users to ${allow.join(', ')} (key names move between Hermes versions; check its Telegram docs), then: sudo systemctl restart hermes-gateway` });
    }
    this.fs.write(this.env.settingsFile, upsertBotConfig(this.settingsText(), bot));
    steps.push({ what: `secondbrain.json telegram.bots: ${o.name} (${o.agent})`, ok: true });
    return steps;
  }

  private botDir(name: string): string { return `${this.env.stateDir}/${name}`; }

  private renderClaude(bot: TelegramBotSetting, clearAt: string): Step[] {
    if (!CLEAR_RE.test(clearAt)) throw new Error(`--clear-at must be HH:MM (UTC), got "${clearAt}"`);
    const unit = unitOf(bot)!;
    const dir = this.botDir(bot.name);
    this.fs.mkdir(dir, 0o755);
    const t = (f: string) => this.fs.read(`${this.env.templateDir}/${f}`);
    const vars: Record<string, string> = {
      BOT_NAME: bot.name, BOT_USER: this.env.user, BOT_HOME: this.env.home, VAULT_DIR: this.env.vaultDir,
      SOCKET: tmuxSocket(bot.name), UNIT: unit, CLEAR_UNIT: `${unit}-clear.service`, CLEAR_AT: clearAt,
      CLAUDE_BIN: this.env.claudeBin ?? 'claude',
      SETTINGS_FILE: `${dir}/telegram-settings.json`, PROMPT_FILE: `${dir}/telegram-prompt.md`,
      CHECK_SCRIPT: `${dir}/claude-telegram-check.sh`, CLEAR_SCRIPT: `${dir}/claude-telegram-clear.sh`,
    };
    this.fs.write(`${dir}/telegram-settings.json`, renderTemplate(t('telegram-settings.json'), vars), 0o644);
    this.fs.write(`${dir}/telegram-prompt.md`, renderTemplate(t('telegram-prompt.md'), vars), 0o644);
    this.fs.write(`${dir}/claude-telegram-check.sh`, t('claude-telegram-check.sh'), 0o755);
    this.fs.chmod(`${dir}/claude-telegram-check.sh`, 0o755);
    this.fs.write(`${dir}/claude-telegram-clear.sh`, t('claude-telegram-clear.sh'), 0o755);
    this.fs.chmod(`${dir}/claude-telegram-clear.sh`, 0o755);
    this.fs.write(`${dir}/${unit}.service`, renderTemplate(t('claude-telegram.service'), vars), 0o644);
    this.fs.write(`${dir}/${unit}-clear.service`, renderTemplate(t('claude-telegram-clear.service'), vars), 0o644);
    this.fs.write(`${dir}/${unit}-clear.timer`, renderTemplate(t('claude-telegram-clear.timer'), vars), 0o644);
    return [{ what: `rendered ${unit}.service, the nightly clear (${clearAt} UTC), settings and prompt into ${dir}/`, ok: true }];
  }

  private renderBridge(bot: TelegramBotSetting, envFile: string): Step[] {
    const unit = unitOf(bot)!;
    const dir = this.botDir(bot.name);
    this.fs.mkdir(dir, 0o755);
    const tpl = this.env.bridgeUnitTemplate;
    if (!this.fs.exists(tpl)) throw new Error(`bridge unit template missing at ${tpl}; is the add-on checked out (addons/telegram-bridge)?`);
    const text = this.fs.read(tpl)
      .replaceAll('<user>', this.env.user)
      .replaceAll('/path/to/vault', this.env.vaultDir)
      .replace(/EnvironmentFile=\/home\/[^\n]*\/\.zen\/telegram-bridge\.env/, `EnvironmentFile=${envFile}`)
      .replace(/^Environment=PATH=.*$/m, `Environment=PATH=${this.env.home}/.local/bin:/usr/local/bin:/usr/bin:/bin`)
      .replaceAll(`/home/${this.env.user}`, this.env.home);
    this.fs.write(`${dir}/${unit}.service`, text, 0o644);
    return [{ what: `rendered ${unit}.service into ${dir}/`, ok: true }];
  }

  /** Copies the rendered units into systemd and enables them; without sudo it prints the commands instead. */
  private installUnits(bot: TelegramBotSetting, noInstall?: boolean): Step[] {
    const unit = unitOf(bot)!;
    const dir = this.botDir(bot.name);
    const files = [`${unit}.service`];
    if (bot.agent === 'claude-code') files.push(`${unit}-clear.service`, `${unit}-clear.timer`);
    const cmds = [
      ...files.map((f) => `sudo install -m 644 ${dir}/${f} /etc/systemd/system/${f}`),
      'sudo systemctl daemon-reload',
      `sudo systemctl enable --now ${unit}`,
      ...(bot.agent === 'claude-code' ? [`sudo systemctl enable --now ${unit}-clear.timer`] : []),
    ];
    if (noInstall) return [{ what: 'systemd (not installed, --no-install)', ok: true, detail: cmds.join('\n') }];
    const probe = this.exec.run('sudo', ['-n', 'true']);
    if (probe.code !== 0) return [{ what: 'systemd (no sudo without a password here)', ok: false, detail: `run these yourself:\n${cmds.join('\n')}` }];
    for (const c of cmds) {
      const [, ...rest] = c.split(' ');
      const r = this.exec.run('sudo', rest);
      if (r.code !== 0) return [{ what: `systemd: ${c}`, ok: false, detail: r.out.trim() }];
    }
    return [{ what: `systemd: ${unit} enabled and started${bot.agent === 'claude-code' ? `, ${unit}-clear.timer on` : ''}`, ok: true }];
  }

  allow(name: string, op: 'add' | 'remove', ids: string[]): Step[] {
    const bot = this.bots().find((b) => b.name === name);
    if (!bot) throw new Error(`no bot "${name}" in secondbrain.json telegram.bots (secondbrain telegram status lists them)`);
    const change = parseAllow(ids);
    const apply = (cur: string[]) => op === 'add' ? [...new Set([...cur, ...change])] : cur.filter((x) => !change.includes(x));
    if (bot.agent === 'claude-code') {
      const f = `${this.env.home}/.claude/channels/telegram/access.json`;
      const cur = this.fs.exists(f) ? (JSON.parse(this.fs.read(f)) as { allowFrom?: string[] }).allowFrom ?? [] : [];
      const next = apply(cur.map(String));
      if (!next.length) throw new Error('that would leave the allowlist empty; remove the bot instead');
      this.fs.write(f, JSON.stringify({ allowFrom: next }, null, 2) + '\n', 0o600);
      return [{ what: `${f}: ${next.length} user(s)`, ok: true }, ...this.restart(bot)];
    }
    if (bot.agent === 'zen-agent') {
      const f = tokenFileOf(bot, this.env);
      const text = this.fs.exists(f) ? this.fs.read(f) : '';
      const cur = (text.match(/^TELEGRAM_ALLOWED_USERS=(.*)$/m)?.[1] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      const next = apply(cur);
      if (!next.length) throw new Error('that would leave the allowlist empty; remove the bot instead');
      this.fs.write(f, setEnvLine(text, 'TELEGRAM_ALLOWED_USERS', next.join(',')), 0o600);
      return [{ what: `${f}: ${next.length} user(s)`, ok: true }, ...this.restart(bot)];
    }
    return [{ what: 'Hermes allowlist', ok: true, detail: `edit the allowed users in Hermes's config.yaml (${op} ${change.join(', ')}) and restart hermes-gateway` }];
  }

  private restart(bot: TelegramBotSetting): Step[] {
    const unit = unitOf(bot)!;
    const r = this.exec.run('sudo', ['-n', 'systemctl', 'restart', unit]);
    return [r.code === 0 ? { what: `${unit} restarted`, ok: true } : { what: `restart ${unit} yourself: sudo systemctl restart ${unit}`, ok: false, detail: r.out.trim() || undefined }];
  }

  remove(name: string, keepToken = false): Step[] {
    const bot = this.bots().find((b) => b.name === name);
    if (!bot) throw new Error(`no bot "${name}" in secondbrain.json telegram.bots`);
    const steps: Step[] = [];
    const unit = unitOf(bot)!;
    if (bot.agent !== 'hermes') {
      const files = [`${unit}.service`, ...(bot.agent === 'claude-code' ? [`${unit}-clear.service`, `${unit}-clear.timer`] : [])];
      const cmds = [`sudo systemctl disable --now ${unit}`, ...(bot.agent === 'claude-code' ? [`sudo systemctl disable --now ${unit}-clear.timer`] : []),
        ...files.map((f) => `sudo rm -f /etc/systemd/system/${f}`), 'sudo systemctl daemon-reload'];
      const probe = this.exec.run('sudo', ['-n', 'true']);
      if (probe.code === 0) {
        for (const c of cmds) this.exec.run('sudo', c.split(' ').slice(1));
        steps.push({ what: `systemd: ${unit} stopped and removed`, ok: true });
      } else steps.push({ what: 'systemd (no sudo here)', ok: false, detail: `run these yourself:\n${cmds.join('\n')}` });
    } else steps.push({ what: 'Hermes', ok: true, detail: 'set gateway.platforms.telegram.enabled: false in its config.yaml and restart hermes-gateway' });
    if (!keepToken) {
      const f = tokenFileOf(bot, this.env);
      if (bot.agent === 'hermes') {
        if (this.fs.exists(f)) this.fs.write(f, this.fs.read(f).split('\n').filter((l) => !l.startsWith('TELEGRAM_BOT_TOKEN=')).join('\n'), 0o600);
      } else if (this.fs.exists(f)) this.fs.remove(f);
      if (bot.agent === 'claude-code') { const a = `${this.env.home}/.claude/channels/telegram/access.json`; if (this.fs.exists(a)) this.fs.remove(a); }
      steps.push({ what: `token removed from ${f}`, ok: true, detail: 'revoke it in BotFather too (/revoke), or /deletebot' });
    }
    this.fs.write(this.env.settingsFile, removeBotConfig(this.settingsText(), name));
    steps.push({ what: `secondbrain.json telegram.bots: ${name} removed`, ok: true });
    return steps;
  }
}

/** One bot's line on `secondbrain telegram status`. `username` comes from Telegram's getMe when the token is valid. */
export interface BotStatus {
  name: string; agent: Agent; unit: string | null;
  tokenFile: string; token: 'missing' | 'invalid' | 'valid' | 'unchecked';
  username: string | null;
  unitActive: boolean | null;
  processUp: boolean | null;
  sessions: { n: number; last: string | null } | null;
  problems: string[];
}

export interface StatusProbes {
  /** Telegram getMe for a token: the bot's username, null when the token is rejected, undefined when unreachable. */
  getMe(token: string): Promise<string | null | undefined>;
  /** archive_sessions with channel = 'telegram' for this bot name (null bot: any); null when no database here. */
  sessions(bot: string | null): Promise<{ n: number; last: string | null } | null>;
}

export async function status(setup: { fs: Fs; exec: Exec; env: Env }, probes: StatusProbes): Promise<{ bots: BotStatus[]; problems: string[] }> {
  const { fs, exec, env } = setup;
  const bots = botsOf(fs.exists(env.settingsFile) ? fs.read(env.settingsFile) : null);
  const out: BotStatus[] = [];
  const tokens = new Map<string, string[]>();
  for (const b of bots) {
    const unit = unitOf(b);
    const tokenFile = tokenFileOf(b, env);
    const token = fs.exists(tokenFile) ? tokenOf(fs.read(tokenFile)) : null;
    const s: BotStatus = { name: b.name, agent: b.agent, unit, tokenFile, token: token ? 'unchecked' : 'missing', username: null,
      unitActive: null, processUp: null, sessions: null, problems: [] };
    if (token) {
      tokens.set(token, [...(tokens.get(token) ?? []), b.name]);
      const me = await probes.getMe(token);
      if (me === null) { s.token = 'invalid'; s.problems.push('Telegram rejects the token (revoked? pasted with a space?)'); }
      else if (me === undefined) s.problems.push('could not reach api.telegram.org to check the token');
      else { s.token = 'valid'; s.username = me; }
    } else s.problems.push(`no TELEGRAM_BOT_TOKEN in ${tokenFile}`);
    if (unit) {
      const r = exec.run('systemctl', ['is-active', unit]);
      s.unitActive = r.code === 0 && r.out.trim() === 'active';
      if (!s.unitActive) s.problems.push(`${unit} is not active (systemctl status ${unit})`);
    }
    if (b.agent === 'claude-code' && s.unitActive) {
      const p = exec.run('pgrep', ['-u', env.user, '-f', 'bun server.ts']);
      s.processUp = p.code === 0;
      if (!s.processUp) s.problems.push('the Telegram plugin process is not running inside the session (/mcp in the tmux pane; restart the unit)');
    }
    s.sessions = await probes.sessions(b.name);
    out.push(s);
  }
  const problems: string[] = [];
  for (const [, names] of tokens) if (names.length > 1) problems.push(`bots ${names.join(' and ')} share one token: two pollers on one bot break both`);
  if (!bots.length) problems.push('no bots in secondbrain.json telegram.bots: secondbrain telegram add --agent claude-code --name claude --allow <your user id>');
  return { bots: out, problems };
}

export function formatStatus(r: { bots: BotStatus[]; problems: string[] }, usageUrl: string | null): string {
  const lines: string[] = [];
  for (const b of r.bots) {
    const head = `${b.name} (${b.agent}${b.username ? `, @${b.username}` : ''})`;
    const unit = b.unit ? `${b.unit}: ${b.unitActive === null ? '?' : b.unitActive ? 'active' : 'down'}` : 'gateway';
    const proc = b.processUp === null ? '' : b.processUp ? ', plugin up' : ', plugin down';
    const sess = b.sessions === null ? 'sessions: no database from here' : `sessions on /usage: ${b.sessions.n}${b.sessions.last ? `, last ${b.sessions.last}` : ''}`;
    lines.push(`${b.problems.length ? '✗' : '✓'} ${head}  token ${b.token}  ${unit}${proc}  ${sess}`);
    for (const p of b.problems) lines.push(`    ! ${p}`);
  }
  for (const p of r.problems) lines.push(`! ${p}`);
  if (usageUrl) lines.push(`Telegram chats: ${usageUrl}/usage?s_channel=telegram`);
  return lines.join('\n');
}
