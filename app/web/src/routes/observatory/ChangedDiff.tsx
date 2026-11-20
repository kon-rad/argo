export interface DiffDetail {
  format: 'replacement' | 'changed-lines'; truncated: boolean; reason?: string;
  before?: string; after?: string;
  hunks?: { oldStart: number; newStart: number; deleted: string[]; added: string[] }[];
}
/** Observed changed lines with zero context, never an applyable full-file patch. */
export function ChangedDiff({ diff }: { diff: DiffDetail }) {
  return <section aria-label="Observed diff detail">
    <p>Unattributed snapshot comparison. Concurrent writers may be included; this is not proof that this tool owned the transition.</p>
    {diff.truncated ? <p>Observed diff text unavailable ({diff.reason ?? 'truncated source'}). Original hashes remain available.</p>
      : diff.format === 'changed-lines' ? <>
        <p>Changed lines only, zero unchanged context. Sensitive lines are redacted. Line numbers refer to original bytes; this is not a full-file replacement.</p>
        {diff.hunks?.map((h, i) => <pre key={i} className="max-h-72 overflow-auto whitespace-pre-wrap break-all">{`@@ old line ${h.oldStart}, new line ${h.newStart} @@\n` + h.deleted.map(line => `- ${line}${line.endsWith('\n') ? '' : '\n'}`).join('') + h.added.map(line => `+ ${line}${line.endsWith('\n') ? '' : '\n'}`).join('')}</pre>)}
      </> : <><p>Legacy full-file replacement, redacted source.</p><pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all">{`Before:\n${diff.before ?? ''}\nAfter:\n${diff.after ?? ''}`}</pre></>}
  </section>;
}
