import { basename, dirname, sep } from 'node:path';

/** <project>/<sid>.jsonl is a session; <project>/<sid>/subagents/<agent>.jsonl is one of its subagents. */
export function transcriptIds(path: string): { sessionExternalId: string; parentSid: string | null; project: string } {
  const parts = path.split(sep);
  const i = parts.lastIndexOf('subagents');
  if (i > 1) {
    return { sessionExternalId: basename(path, '.jsonl'), parentSid: parts[i - 1]!, project: parts[i - 2]! };
  }
  return { sessionExternalId: basename(path, '.jsonl'), parentSid: null, project: basename(dirname(path)) };
}
