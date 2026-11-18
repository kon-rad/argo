import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from '@earendil-works/pi-ai';
import { text, tool, type ToolContext } from './index.js';

/**
 * Delegation with a contract: an objective, what to return, a budget. The
 * child runs in its own session file with its own context, and only its final
 * answer comes back, so a long investigation costs the parent one tool result.
 * One level deep: a child cannot delegate.
 */
export function subagentTools(ctx: ToolContext): AgentTool<any>[] {
  if (ctx.depth > 0 || !ctx.delegate) return [];
  const delegate = tool({
    name: 'delegate',
    label: 'Delegate',
    description:
      'Run a sub-agent on a self-contained objective and get its final report back. Say exactly what it must return. ' +
      'Use it for a long read, a review, or a verification you want kept out of your own context.',
    parameters: Type.Object({
      objective: Type.String({ description: 'The task, what done means, and what to return' }),
      persona: Type.Optional(Type.String({ description: 'A roster name to run it as (default: you)' })),
      turns: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: 'Turn budget (default 15)' })),
    }),
    executionMode: 'sequential',
    execute: async (a) => {
      const r = await ctx.delegate!({ objective: a.objective, persona: a.persona, budget: { turns: a.turns ?? 15 } });
      const note = r.stopped === 'done' ? '' : `\n[sub-agent stopped: ${r.stopped}]`;
      return text(`${r.text || '(no final text)'}${note}\n[session ${r.sessionId}]`, { sessionId: r.sessionId, stopped: r.stopped });
    },
  });
  return [delegate];
}
