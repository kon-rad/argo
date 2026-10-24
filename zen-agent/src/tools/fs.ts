import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from '@earendil-works/pi-ai';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { clipOutput, text, tool, type ToolContext } from './index.js';

/**
 * Files, under the configured roots (the working directory and the vault by
 * default). The guard decides what is a secret; this decides what is in scope.
 */
export function resolveIn(roots: string[], p: string, cwd: string): string {
  const abs = isAbsolute(p) ? resolve(p) : resolve(cwd, p);
  const inside = roots.some((r) => {
    const rel = relative(r, abs);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  });
  if (!inside) throw new Error(`${p} is outside the agent's roots (${roots.join(', ')}); use bash for anything else`);
  return abs;
}

export function fsTools(ctx: ToolContext): AgentTool<any>[] {
  const roots = ctx.cfg.fs.roots;
  const cwd = ctx.cfg.workdir;
  const at = (p: string) => resolveIn(roots, p, cwd);

  const read_file = tool({
    name: 'read_file',
    label: 'Read file',
    description: 'Read a text file. Use offset and limit (line numbers) for anything longer than a few hundred lines.',
    parameters: Type.Object({
      path: Type.String({ description: 'Path, relative to the working directory or absolute' }),
      offset: Type.Optional(Type.Integer({ minimum: 1, description: 'First line to return (1-based)' })),
      limit: Type.Optional(Type.Integer({ minimum: 1, description: 'Number of lines to return' })),
    }),
    execute: async (a) => {
      const abs = at(a.path);
      const st = statSync(abs);
      if (st.isDirectory()) throw new Error(`${a.path} is a directory; use list_dir`);
      if (st.size > ctx.cfg.fs.maxRead && !a.limit) throw new Error(`${a.path} is ${st.size} bytes; read it with offset and limit`);
      const lines = readFileSync(abs, 'utf8').split('\n');
      const start = (a.offset ?? 1) - 1;
      const slice = lines.slice(start, a.limit ? start + a.limit : undefined);
      const body = slice.map((l, i) => `${String(start + i + 1).padStart(5)}\t${l}`).join('\n');
      return text(clipOutput(body, ctx.cfg.shell.maxOutput * 2), { path: abs, lines: lines.length });
    },
  });

  const write_file = tool({
    name: 'write_file',
    label: 'Write file',
    description: 'Create or overwrite a text file (parent folders are created).',
    parameters: Type.Object({ path: Type.String(), content: Type.String() }),
    execute: async (a) => {
      const abs = at(a.path);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, a.content);
      return text(`wrote ${a.content.length} characters to ${a.path}`, { path: abs });
    },
  });

  const edit_file = tool({
    name: 'edit_file',
    label: 'Edit file',
    description: 'Replace one exact occurrence of `old` with `new` in a file. Fails when `old` is missing or ambiguous.',
    parameters: Type.Object({ path: Type.String(), old: Type.String(), new: Type.String() }),
    execute: async (a) => {
      const abs = at(a.path);
      const cur = readFileSync(abs, 'utf8');
      const first = cur.indexOf(a.old);
      if (first < 0) throw new Error(`old text not found in ${a.path}`);
      if (cur.indexOf(a.old, first + 1) >= 0) throw new Error(`old text occurs more than once in ${a.path}; include more context`);
      writeFileSync(abs, cur.slice(0, first) + a.new + cur.slice(first + a.old.length));
      return text(`edited ${a.path}`, { path: abs });
    },
  });

  const list_dir = tool({
    name: 'list_dir',
    label: 'List directory',
    description: 'List a folder: names, with / after directories. Skips node_modules, dist, .git and hidden files unless asked.',
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: 'Folder; default the working directory' })),
      all: Type.Optional(Type.Boolean({ description: 'Include hidden and build folders' })),
    }),
    execute: async (a) => {
      const abs = at(a.path ?? '.');
      const skip = new Set(['node_modules', 'dist', 'build', '.git', '.venv', '__pycache__']);
      const names = readdirSync(abs, { withFileTypes: true })
        .filter((e) => a.all || (!skip.has(e.name) && !e.name.startsWith('.')))
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        .sort();
      return text(clipOutput(names.join('\n') || '(empty)', ctx.cfg.shell.maxOutput), { path: abs, count: names.length });
    },
  });

  return [read_file, write_file, edit_file, list_dir];
}
