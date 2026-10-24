import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

/**
 * External hook commands, in the Claude Code contract: the payload as JSON on
 * stdin; exit 2 with the reason on stderr blocks, and so does a JSON answer
 * `{"decision": "block", "reason": "..."}` on stdout (Hermes's form). Anything
 * else, including a crash or a timeout, allows: hooks fail open. The engine's
 * `guard.py` and `devlog_gate.py` run here unchanged.
 */
export interface HookResult {
  block: boolean;
  reason?: string;
}

export function runHook(command: string, payload: unknown, cwd: string, timeoutMs = 10_000): Promise<HookResult> {
  return new Promise((done) => {
    let settled = false;
    const finish = (r: HookResult) => {
      if (!settled) {
        settled = true;
        done(r);
      }
    };
    let child;
    try {
      child = spawn('sh', ['-c', command], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch {
      return finish({ block: false });
    }
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ block: false });
    }, timeoutMs);
    child.on('error', () => {
      clearTimeout(timer);
      finish({ block: false });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 2) return finish({ block: true, reason: err.trim() || `blocked by hook: ${command}` });
      try {
        const parsed = JSON.parse(out || '{}') as { decision?: string; reason?: string };
        if (parsed.decision === 'block') return finish({ block: true, reason: parsed.reason || `blocked by hook: ${command}` });
      } catch {
        // Not JSON: an allow.
      }
      finish({ block: false });
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(JSON.stringify(payload));
  });
}

/** Runs the hooks in order; the first block wins. */
export async function runHooks(commands: string[], payload: unknown, cwd: string): Promise<HookResult> {
  for (const c of commands) {
    const r = await runHook(c, payload, cwd);
    if (r.block) return r;
  }
  return { block: false };
}

/**
 * A transcript in Claude Code's JSONL shape, enough for a Stop hook that
 * looks for `tool_use` blocks (the dev-log gate reads which files changed).
 */
export function writeClaudeTranscript(path: string, messages: unknown[]): void {
  const lines: string[] = [];
  for (const m of messages) {
    const msg = m as { role?: string; content?: unknown };
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
    const content = msg.content.map((block) => {
      const b = block as { type?: string; name?: string; arguments?: Record<string, unknown>; text?: string };
      if (b.type !== 'toolCall') return b.type === 'text' ? { type: 'text', text: b.text } : null;
      const a = b.arguments ?? {};
      const name = b.name === 'write_file' ? 'Write' : b.name === 'edit_file' ? 'Edit' : b.name === 'bash' ? 'Bash' : b.name;
      const input = b.name === 'write_file' || b.name === 'edit_file' ? { file_path: a['path'] } : a;
      return { type: 'tool_use', name, input };
    });
    lines.push(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: content.filter(Boolean) } }));
  }
  writeFileSync(path, lines.join('\n') + (lines.length ? '\n' : ''));
}
