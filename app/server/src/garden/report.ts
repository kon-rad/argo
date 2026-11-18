import type { ApplyResult } from './apply.js';
import type { Action } from './rules.js';

export type GardenMode = 'shadow' | 'write' | 'apply';

export interface RunResult {
  mode: GardenMode;
  today: string;
  shelves: number;
  created: number;          // shelf notes written for the first time (0 in shadow)
  actions: Action[];
  applied: ApplyResult | null;
  reportPath: string;
  catalogPath: string;
  dirtySkipped: number;
}

function table(rows: string[][], head: string[]): string[] {
  const esc = (s: string) => s.replace(/\|/g, '\\|');
  return [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.map(esc).join(' | ')} |`)];
}

export function renderReport(r: RunResult): string {
  const archives = r.actions.filter((a): a is Extract<Action, { type: 'archive' }> => a.type === 'archive');
  const proposals = r.actions.filter((a): a is Extract<Action, { type: 'propose-archive' }> => a.type === 'propose-archive');
  const renames = r.actions.filter((a): a is Extract<Action, { type: 'rename' }> => a.type === 'rename');
  const reports = r.actions.filter((a): a is Extract<Action, { type: 'report' }> => a.type === 'report');
  const doneSet = new Set((r.applied?.done ?? []).map((a) => JSON.stringify(a)));
  const applied = r.mode === 'apply';
  const lines: string[] = [
    `# Garden report ${r.today}`,
    '',
    `**Mode:** ${r.mode}${r.mode === 'shadow' ? ' (nothing written except this report)' : r.mode === 'write' ? ' (shelf notes and catalog written, nothing moved)' : ''}`,
    '',
    `${r.shelves} shelves, ${r.created} shelf notes created, ${archives.length} archive ${applied ? 'moves' : 'candidates'}, ${proposals.length} proposals, ${renames.length} renames, ${reports.length} for a human.`,
    '',
    `## ${applied ? 'Archived' : 'Would archive'}`,
    '',
  ];
  if (archives.length === 0) lines.push('Nothing.', '');
  else lines.push(...table(archives.map((a) => [a.from, a.to, a.reason, applied ? (doneSet.has(JSON.stringify(a)) ? 'moved' : 'refused') : 'pending']), ['From', 'To', 'Reason', 'Result']), '');
  lines.push('## Proposed (areas)', '');
  if (proposals.length === 0) lines.push('Nothing.', '');
  else { proposals.forEach((p, i) => lines.push(`${i + 1}. \`${p.dir}\` (${p.reason}). Archive it by setting \`status: archived\` in its README, or keep it with \`pin: true\`.`)); lines.push(''); }
  lines.push(`## ${applied ? 'Renamed' : 'Would rename'}`, '');
  if (renames.length === 0) lines.push('Nothing.', '');
  else lines.push(...table(renames.map((a) => [a.from, a.to, applied ? (doneSet.has(JSON.stringify(a)) ? 'renamed' : 'refused') : 'pending']), ['From', 'To', 'Result']), '');
  lines.push('## Needs a human', '');
  const human: string[] = reports.map((a) => `- \`${a.path}\`: ${a.reason}`);
  for (const x of r.applied?.refused ?? []) {
    const where = 'from' in x.action ? x.action.from : 'path' in x.action ? x.action.path : x.action.dir;
    human.push(`- \`${where}\`: refused, ${x.reason}`);
  }
  if (human.length === 0) lines.push('Nothing.', '');
  else lines.push(...human, '');
  lines.push('## Skipped: uncommitted changes', '', `${r.dirtySkipped} files with uncommitted changes were left alone.`, '');
  if (r.applied) lines.push(`Links rewritten: ${r.applied.linksRewritten} in ${r.applied.filesTouched.length} files.`, '');
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}
