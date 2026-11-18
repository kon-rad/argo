import { z } from 'zod';
const name = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/);
const label = z.string().min(1).max(100);
/** Producer supplied before spawn, with the native session identity bound as soon as known.
 * Host is always supplied by the authenticated transport, never this envelope. */
export const launchSchema = z.object({
  v: z.literal(1), runId: z.string().min(1).max(200), source: name, runtime: name,
  sessionId: z.string().min(1).max(200).nullable(), entrypoint: label.nullable(),
  trigger: label.nullable(), channel: label.nullable(), persona: name.nullable(),
  personaOrigin: label.nullable(), taskIds: z.array(z.string().regex(/^t_[0-9a-f]{6,32}$/)).max(100),
}).strict().refine(v => v.source === v.runtime, 'native source must equal runtime');
export type LaunchEnvelope = z.infer<typeof launchSchema>;
/** Only a leading envelope heading, never a prose mention, quote, URL or assistant message. */
export function boardEnvelope(text: string): { id: string; title: string } | null {
  const direct = /^Board card (t_[0-9a-f]{6,32}): ([^\r\n]+)(?:\r?\n|$)/.exec(text);
  // Exclude quoted and fenced examples inside an otherwise valid compiled persona.
  let fenced = false;
  const unquoted = text.split('\n').filter(line => {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; return false; }
    return !fenced && !/^\s*>/.test(line);
  }).join('\n');
  const compiled = /^\s*(?:#[^\n]*\n\s*)?You are \*\*[a-z0-9-]+\*\*/.test(text)
    && /^# How this run works \(cc-card, headless\)\s*$/m.test(unquoted)
    ? /^Board card (t_[0-9a-f]{6,32}): ([^\r\n]+)$/m.exec(unquoted) : null;
  const m = direct ?? compiled;
  return m ? { id: m[1]!, title: m[2]!.trim() } : null;
}
