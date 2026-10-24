import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from '@earendil-works/pi-ai';
import { skillBody } from '../skills.js';
import { clipOutput, text, tool, type ToolContext } from './index.js';

export function skillTools(ctx: ToolContext): AgentTool<any>[] {
  if (!ctx.skills.length) return [];
  const read_skill = tool({
    name: 'read_skill',
    label: 'Read skill',
    description: 'Load the full instructions of a skill listed in the system prompt. Its folder path is returned for scripts it ships.',
    parameters: Type.Object({ name: Type.String() }),
    execute: async (a) => {
      const s = ctx.skills.find((k) => k.name === a.name);
      if (!s) throw new Error(`no skill "${a.name}"; the system prompt lists the available ones`);
      return text(`Skill folder: ${s.dir}\n\n${clipOutput(skillBody(s), 40_000)}`, { name: s.name, dir: s.dir });
    },
  });
  return [read_skill];
}
