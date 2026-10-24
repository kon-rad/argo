import type { AgentEvent } from '@earendil-works/pi-agent-core';
import type { Models } from '@earendil-works/pi-ai';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { ZenAgent } from './agent.js';
import { THINKING_LEVELS, type Budget, type ThinkingLevel, type ZenConfig } from './config.js';
import { availableProviders, buildModels, pickModel } from './models.js';
import { listPersonas, loadPersona } from './persona.js';
import { newSessionId, Session, ZERO_USAGE, type SessionLine, type UsageTotals } from './session.js';
import { discoverSkills } from './skills.js';
import { TOOL_SETS } from './tools/index.js';

/**
 * `zen-agent serve`: the chat transport. A long-lived process that keeps one live ZenAgent per open chat and speaks
 * a small HTTP API over loopback (bearer token), so a browser, through the second brain's allowlisted proxy, can
 * start a session, send and steer messages, stop a run, and follow its trace live: every line the session file gets
 * (meta, message, tool, blocked, compaction, end) plus text and thinking deltas while the model types.
 *
 * A chat's persona, model, tool sets and thinking level are fixed when it is created; to change them, a new chat is
 * made, optionally continuing an old one (`from`): the old messages replay into a new session with its own trace.
 * The process holds nothing a restart cannot rebuild: chat records are JSON files next to the sessions folder, and a
 * chat's event log is read back from its trace (the deltas, which only matter live, are not kept).
 */
export type ChatStatus = 'idle' | 'working' | 'error';

export interface ChatRecord {
  id: string;
  title: string;
  session_id: string;
  persona: string | null;
  /** `provider/model`, resolved. */
  model: string;
  tools: string[];
  thinking: ThinkingLevel;
  budget: Budget;
  /** The chat this one continues (its messages replayed into this session), or null. */
  from: string | null;
  created_at: string;
  updated_at: string;
  status: ChatStatus;
  error: string | null;
  turns: number;
  usage: UsageTotals;
}

/** One line of a chat's event log: a trace line, a live delta, a steer, or a host-side error. */
export type ChatEvent =
  | SessionLine
  | { type: 'delta'; at: string; text?: string; thinking?: string }
  | { type: 'steer'; at: string; text: string }
  | { type: 'error'; at: string; text: string };

export interface CreateChat {
  persona?: string | null;
  model?: string;
  /** Tool set names (fs, shell, skills, knowledge, kanban, org, subagent), or `read-only` for skills + knowledge. */
  tools?: string[] | 'full' | 'read-only';
  thinking?: ThinkingLevel;
  budget?: Partial<Budget>;
  title?: string;
  from?: string;
}

export interface ServeOptions {
  config: ZenConfig;
  token: string;
  host?: string;
  port?: number;
  models?: Models;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  /** Where chat records live; default `<sessionsDir>/../chats`. */
  chatsDir?: string;
  /** Milliseconds a model's reachability probe may take; the catalogue is cached for ten of these. */
  probeMs?: number;
}

export interface ModelRow { provider: string; id: string; name: string; context_window: number; reasoning: boolean; configured: boolean; reachable: boolean | null }
export interface ProviderRow { id: string; name: string; custom: boolean; configured: boolean; key_env: string | null; key_name: string | null; base_url: string | null; reachable: boolean | null }

/** A chat has no budget to speak of: the person stops it. */
export const CHAT_BUDGET: Budget = { turns: 10_000, tokens: 50_000_000, minutes: 100_000 };
export const READ_ONLY_TOOL_SETS = ['skills', 'knowledge'];
const DELTA_FLUSH_MS = 150;
const PAGE = 500;

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

interface Live {
  record: ChatRecord;
  agent: ZenAgent | null;
  events: ChatEvent[] | null;
  pending: { text: string; thinking: string; timer: ReturnType<typeof setTimeout> | null };
}

const now = (): string => new Date().toISOString();

export class ChatHost {
  readonly cfg: ZenConfig;
  readonly models: Models;
  readonly chatsDir: string;
  /** Changes when the process starts: a reader whose offset predates it starts over (live deltas are not replayed). */
  readonly epoch = `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetch: typeof fetch;
  private readonly probeMs: number;
  private readonly chats = new Map<string, Live>();
  private catalogue: { at: number; value: { providers: ProviderRow[]; models: ModelRow[] } } | null = null;

  constructor(private readonly opts: Omit<ServeOptions, 'token' | 'host' | 'port'>) {
    this.cfg = opts.config;
    this.env = opts.env ?? process.env;
    this.fetch = opts.fetch ?? fetch;
    this.probeMs = opts.probeMs ?? 2500;
    this.models = opts.models ?? buildModels(this.cfg);
    this.chatsDir = opts.chatsDir ?? join(dirname(this.cfg.sessionsDir), 'chats');
    mkdirSync(this.chatsDir, { recursive: true });
    for (const f of readdirSync(this.chatsDir).filter((f) => f.endsWith('.json')).sort()) {
      try {
        const rec = JSON.parse(readFileSync(join(this.chatsDir, f), 'utf8')) as ChatRecord;
        if (typeof rec.id !== 'string' || typeof rec.session_id !== 'string') continue;
        // A chat that was working when the last process died is idle now; its run cannot be picked up.
        if (rec.status === 'working') rec.status = 'idle';
        this.chats.set(rec.id, { record: rec, agent: null, events: null, pending: { text: '', thinking: '', timer: null } });
      } catch {
        // Not a chat record: leave it.
      }
    }
  }

  // ----- catalogue -----

  /** Providers and models with what the UI needs to grey out: a key in the environment, and for custom endpoints a liveness probe. */
  async catalog(): Promise<{ providers: ProviderRow[]; models: ModelRow[] }> {
    if (this.catalogue && Date.now() - this.catalogue.at < this.probeMs * 10) return this.catalogue.value;
    const configured = new Set(await availableProviders(this.models));
    const reach = new Map<string, boolean>();
    await Promise.all(
      Object.entries(this.cfg.providers).map(async ([id, p]) => {
        reach.set(id, await this.probe(p.baseUrl));
      }),
    );
    const providers: ProviderRow[] = this.models.getProviders().map((p) => {
      const custom = this.cfg.providers[p.id];
      return {
        id: p.id,
        name: p.name,
        custom: Boolean(custom),
        configured: configured.has(p.id),
        key_env: custom ? custom.apiKeyEnv ?? null : null,
        key_name: p.auth.apiKey?.name ?? null,
        base_url: custom ? custom.baseUrl : null,
        reachable: custom ? reach.get(p.id) ?? false : null,
      };
    }).sort((a, b) => a.id.localeCompare(b.id));
    const models: ModelRow[] = this.models.getModels().map((m) => ({
      provider: m.provider,
      id: m.id,
      name: m.name,
      context_window: m.contextWindow,
      reasoning: Boolean(m.reasoning),
      configured: configured.has(m.provider),
      reachable: this.cfg.providers[m.provider] ? reach.get(m.provider) ?? false : null,
    }));
    this.catalogue = { at: Date.now(), value: { providers, models } };
    return this.catalogue.value;
  }

  /** Any HTTP answer counts (a 401 means the server is up); only no answer at all is unreachable. */
  private async probe(baseUrl: string): Promise<boolean> {
    try {
      await this.fetch(`${baseUrl.replace(/\/+$/, '')}/models`, { signal: AbortSignal.timeout(this.probeMs) });
      return true;
    } catch {
      return false;
    }
  }

  personas(): { name: string; role: string; team: string | null; runtime: string }[] {
    return listPersonas(this.cfg);
  }

  skills(): { name: string; description: string }[] {
    return discoverSkills(this.cfg.skills).map((s) => ({ name: s.name, description: s.description }));
  }

  // ----- chats -----

  list(): ChatRecord[] {
    return [...this.chats.values()].map((c) => c.record).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }

  get(id: string): ChatRecord {
    return this.live(id).record;
  }

  private live(id: string): Live {
    const c = this.chats.get(id);
    if (!c) throw new HttpError(404, `no chat ${id}`);
    return c;
  }

  /** A new chat: its config is checked here, so a bad persona or model fails now, not on the first message. */
  create(input: CreateChat): ChatRecord {
    const who = input.persona ? loadPersona(this.cfg, input.persona) : null;
    const persona = who?.name ?? null;
    const model = pickModel(this.models, input.model ?? who?.model ?? this.cfg.model);
    const tools = input.tools === 'read-only' ? READ_ONLY_TOOL_SETS : !input.tools || input.tools === 'full' ? this.cfg.tools : input.tools;
    for (const t of tools) if (!TOOL_SETS[t]) throw new HttpError(400, `unknown tool set "${t}" (have: ${Object.keys(TOOL_SETS).join(', ')})`);
    const thinking = input.thinking ?? this.cfg.thinking;
    if (!(THINKING_LEVELS as readonly string[]).includes(thinking)) throw new HttpError(400, `thinking must be one of ${THINKING_LEVELS.join(', ')}`);
    const from = input.from ? this.live(input.from).record : null;
    if (from && !Session.exists(this.cfg.sessionsDir, from.session_id)) throw new HttpError(409, `chat ${from.id} has no trace to continue from`);
    const budget = { ...CHAT_BUDGET, ...stripUndefined(input.budget ?? {}) };
    const at = now();
    const record: ChatRecord = {
      id: randomBytes(6).toString('hex'),
      title: (input.title ?? '').trim() || (from ? from.title : ''),
      session_id: newSessionId(persona ?? 'chat'),
      persona,
      model: `${model.provider}/${model.id}`,
      tools: [...tools],
      thinking,
      budget,
      from: from?.id ?? null,
      created_at: at,
      updated_at: at,
      status: 'idle',
      error: null,
      turns: 0,
      usage: { ...ZERO_USAGE },
    };
    const live: Live = { record, agent: null, events: [], pending: { text: '', thinking: '', timer: null } };
    this.chats.set(record.id, live);
    try {
      live.agent = this.build(live, from?.session_id);
    } catch (err) {
      this.chats.delete(record.id);
      throw new HttpError(400, (err as Error).message);
    }
    this.save(live);
    return record;
  }

  private build(live: Live, resume: string | undefined): ZenAgent {
    const r = live.record;
    return new ZenAgent({
      config: this.cfg,
      models: this.models,
      env: this.env,
      fetch: this.fetch,
      persona: r.persona,
      model: r.model,
      toolSets: r.tools,
      thinking: r.thinking,
      budget: r.budget,
      sessionId: r.session_id,
      resume,
      onTrace: (line) => this.push(live, line),
      onEvent: (e) => this.onAgentEvent(live, e),
    });
  }

  /** The agent behind a chat, rebuilt from its trace after a restart (the conversation continues; a run in flight then is lost). */
  private agentOf(live: Live): ZenAgent {
    if (!live.agent) {
      this.events(live);
      const resume = Session.exists(this.cfg.sessionsDir, live.record.session_id) ? live.record.session_id : undefined;
      live.agent = this.build(live, resume);
    }
    return live.agent;
  }

  /** Starts a turn; the answer arrives in the event log. One turn at a time per chat. */
  send(id: string, text: string): ChatRecord {
    const live = this.live(id);
    const r = live.record;
    if (!text.trim()) throw new HttpError(400, 'empty message');
    if (r.status === 'working') throw new HttpError(409, 'the chat is working; steer it or stop it first');
    const agent = this.agentOf(live);
    if (!r.title) r.title = text.trim().split('\n')[0]!.slice(0, 80);
    r.status = 'working';
    r.error = null;
    r.updated_at = now();
    this.save(live);
    void agent.run(text).then(
      (res) => {
        r.status = res.stopped === 'error' ? 'error' : 'idle';
        r.error = res.error ?? null;
        r.turns = res.turns;
        r.usage = res.usage;
        r.updated_at = now();
        this.save(live);
      },
      (err) => {
        this.push(live, { type: 'error', at: now(), text: (err as Error).message });
        r.status = 'error';
        r.error = (err as Error).message;
        r.updated_at = now();
        this.save(live);
      },
    );
    return r;
  }

  /** A message read after the current turn, while tools run. */
  steer(id: string, text: string): ChatRecord {
    const live = this.live(id);
    if (!text.trim()) throw new HttpError(400, 'empty message');
    if (live.record.status !== 'working' || !live.agent) throw new HttpError(409, 'the chat is not working; send a message instead');
    live.agent.steer(text);
    this.push(live, { type: 'steer', at: now(), text });
    return live.record;
  }

  interrupt(id: string): ChatRecord {
    const live = this.live(id);
    live.agent?.abort();
    return live.record;
  }

  /** The event log from `offset`, as the browser polls it; `size` is the log's length, so a reader knows when it is caught up. */
  page(id: string, offset: number): { events: ChatEvent[]; offset: number; size: number; epoch: string; chat: ChatRecord } {
    const live = this.live(id);
    const all = this.events(live);
    const from = Math.max(0, Math.min(offset, all.length));
    const events = all.slice(from, from + PAGE);
    return { events, offset: from + events.length, size: all.length, epoch: this.epoch, chat: live.record };
  }

  private events(live: Live): ChatEvent[] {
    if (!live.events) {
      const path = join(this.cfg.sessionsDir, `${live.record.session_id}.jsonl`);
      live.events = existsSync(path)
        ? readFileSync(path, 'utf8').split('\n').filter((l) => l.trim()).flatMap((l) => {
          try {
            return [JSON.parse(l) as ChatEvent];
          } catch {
            return [];
          }
        })
        : [];
    }
    return live.events;
  }

  private push(live: Live, event: ChatEvent): void {
    const events = this.events(live);
    if (event.type !== 'delta') this.flush(live);
    events.push(event);
    live.record.updated_at = now();
  }

  private onAgentEvent(live: Live, e: AgentEvent): void {
    if (e.type !== 'message_update') return;
    const u = e.assistantMessageEvent;
    if (u.type === 'text_delta') live.pending.text += u.delta;
    else if (u.type === 'thinking_delta') live.pending.thinking += u.delta;
    else return;
    // Tokens arrive many times a second; the log gets one line per flush, not one per token.
    live.pending.timer ??= setTimeout(() => this.flush(live), DELTA_FLUSH_MS);
  }

  private flush(live: Live): void {
    const p = live.pending;
    if (p.timer) clearTimeout(p.timer);
    p.timer = null;
    if (!p.text && !p.thinking) return;
    const events = this.events(live);
    if (p.thinking) events.push({ type: 'delta', at: now(), thinking: p.thinking });
    if (p.text) events.push({ type: 'delta', at: now(), text: p.text });
    p.text = '';
    p.thinking = '';
  }

  private save(live: Live): void {
    writeFileSync(join(this.chatsDir, `${live.record.id}.json`), JSON.stringify(live.record, null, 2) + '\n');
  }
}

// ----- HTTP -----

const CHAT = '[0-9a-f]{12}';
type Handler = (host: ChatHost, m: RegExpExecArray, body: Record<string, unknown>, url: URL) => Promise<unknown> | unknown;
const ROUTES: [string, RegExp, Handler][] = [
  ['GET', /^\/health$/, () => ({ ok: true })],
  ['GET', /^\/zen\/models$/, (h) => h.catalog()],
  ['GET', /^\/zen\/personas$/, (h) => ({ personas: h.personas() })],
  ['GET', /^\/zen\/skills$/, (h) => ({ skills: h.skills() })],
  ['GET', /^\/zen\/chats$/, (h) => ({ chats: h.list(), epoch: h.epoch })],
  ['POST', /^\/zen\/chats$/, (h, _m, body) => h.create(parseCreate(body))],
  ['GET', new RegExp(`^/zen/chats/(${CHAT})$`), (h, m) => h.get(m[1]!)],
  ['GET', new RegExp(`^/zen/chats/(${CHAT})/events$`), (h, m, _b, url) => h.page(m[1]!, Math.max(0, Number(url.searchParams.get('offset') ?? 0) || 0))],
  ['POST', new RegExp(`^/zen/chats/(${CHAT})/messages$`), (h, m, body) => h.send(m[1]!, textOf(body))],
  ['POST', new RegExp(`^/zen/chats/(${CHAT})/steer$`), (h, m, body) => h.steer(m[1]!, textOf(body))],
  ['POST', new RegExp(`^/zen/chats/(${CHAT})/interrupt$`), (h, m) => ({ ok: true, chat: h.interrupt(m[1]!) })],
];

function textOf(body: Record<string, unknown>): string {
  if (typeof body['text'] !== 'string') throw new HttpError(400, 'text (a string) is required');
  return body['text'];
}

export function parseCreate(body: Record<string, unknown>): CreateChat {
  const out: CreateChat = {};
  const s = (k: string): string | undefined => {
    const v = body[k];
    if (v === undefined || v === null || v === '') return undefined;
    if (typeof v !== 'string') throw new HttpError(400, `${k} must be a string`);
    return v;
  };
  out.persona = s('persona') ?? null;
  out.model = s('model');
  out.title = s('title');
  out.from = s('from');
  const thinking = s('thinking');
  if (thinking !== undefined) out.thinking = thinking as ThinkingLevel;
  const tools = body['tools'];
  if (tools === 'full' || tools === 'read-only') out.tools = tools;
  else if (Array.isArray(tools)) {
    if (!tools.every((t) => typeof t === 'string')) throw new HttpError(400, 'tools must be a list of tool set names');
    out.tools = tools as string[];
  } else if (tools !== undefined && tools !== null) throw new HttpError(400, 'tools must be "full", "read-only" or a list of tool set names');
  const budget = body['budget'];
  if (budget !== undefined && budget !== null) {
    if (!budget || typeof budget !== 'object' || Array.isArray(budget)) throw new HttpError(400, 'budget must be an object');
    const b = budget as Record<string, unknown>;
    out.budget = {};
    for (const k of ['turns', 'tokens', 'minutes'] as const) {
      if (b[k] === undefined) continue;
      if (typeof b[k] !== 'number' || !(b[k] > 0)) throw new HttpError(400, `budget.${k} must be a positive number`);
      out.budget[k] = b[k];
    }
  }
  return out;
}

function bearerOk(header: string | undefined, token: string): boolean {
  const given = Buffer.from(header?.startsWith('Bearer ') ? header.slice(7) : '');
  const want = Buffer.from(token);
  return given.length === want.length && timingSafeEqual(given, want);
}

function readBody(req: IncomingMessage, max = 1_000_000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c: Buffer) => {
      data += c.toString('utf8');
      if (data.length > max) reject(new HttpError(413, 'body too large'));
    });
    req.on('end', () => {
      if (!data.trim()) return resolve({});
      try {
        const v = JSON.parse(data) as unknown;
        resolve(v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
      } catch {
        reject(new HttpError(400, 'body is not JSON'));
      }
    });
    req.on('error', reject);
  });
}

/** The request handler, separate from the listener so a test can mount it on any port. */
export function requestHandler(host: ChatHost, token: string): (req: IncomingMessage, res: ServerResponse) => void {
  const send = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  return (req, res) => {
    void (async () => {
      try {
        if (!bearerOk(req.headers.authorization, token)) throw new HttpError(401, 'unauthorized');
        const url = new URL(req.url ?? '/', 'http://localhost');
        const method = req.method ?? 'GET';
        for (const [m, re, handler] of ROUTES) {
          const match = re.exec(url.pathname);
          if (!match || m !== method) continue;
          const body = method === 'POST' ? await readBody(req) : {};
          return send(res, 200, await handler(host, match, body, url));
        }
        throw new HttpError(404, `no route ${method} ${url.pathname}`);
      } catch (err) {
        if (err instanceof HttpError) return send(res, err.status, { error: err.message });
        send(res, 500, { error: (err as Error).message });
      }
    })();
  };
}

export function startServer(opts: ServeOptions): Promise<{ server: Server; host: ChatHost; url: string }> {
  if (!opts.token || opts.token.length < 16) throw new Error('serve needs a bearer token of at least 16 characters (ZEN_SERVE_TOKEN)');
  const host = new ChatHost(opts);
  const server = createServer(requestHandler(host, opts.token));
  const bind = opts.host ?? '127.0.0.1';
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 8791, bind, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : opts.port ?? 8791;
      resolve({ server, host, url: `http://${bind}:${port}` });
    });
  });
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
