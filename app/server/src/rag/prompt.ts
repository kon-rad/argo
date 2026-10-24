import type { Passage } from './retrieve.js';

export interface PromptParts {
  /** The base system prompt from the settings (the presets' default unless edited). */
  base: string;
  /** The selected persona's definition, appended after the base prompt. */
  persona?: { name: string; role: string; prompt: string | null } | null;
  passages: Passage[];
  today?: string;
}

/**
 * The system prompt for one answer. Order matters for prompt caching on
 * providers that support it: the stable part (base prompt, persona) comes
 * first and the per-turn passages last.
 */
export function buildSystemPrompt(p: PromptParts): string {
  const today = p.today ?? new Date().toISOString().slice(0, 10);
  const parts: string[] = [p.base.trim()];
  if (p.persona) {
    parts.push(
      [
        `You answer as ${p.persona.name} (${p.persona.role}), one of the owner's agents. Keep that identity's voice and priorities, but the notes are still the source of truth.`,
        p.persona.prompt ? `Your definition:\n${p.persona.prompt.trim()}` : '',
      ]
        .filter(Boolean)
        .join('\n\n'),
    );
  }
  parts.push(
    [
      'How to answer:',
      '- Use the passages below. Cite the ones a sentence rests on as [1], [2]; several as [1][3].',
      '- When the passages do not answer the question, say so and name the closest notes, rather than filling the gap from general knowledge. General knowledge is fine when clearly marked as such.',
      '- Refer to notes by their title; the reader can open them from the citations.',
      '- Markdown is rendered; tables and lists are fine; no front matter.',
      `- Today is ${today}.`,
    ].join('\n'),
  );
  parts.push(
    p.passages.length === 0
      ? 'No passages were retrieved for this question: the vault may not be embedded yet, or the notes do not cover it. Say so.'
      : [
          '<passages>',
          ...p.passages.map((x) =>
            [`[${x.n}] ${x.title} (${x.path}${x.heading_path ? ` › ${x.heading_path}` : ''})`, x.content.trim(), ''].join('\n'),
          ),
          '</passages>',
        ].join('\n'),
  );
  return parts.join('\n\n');
}
