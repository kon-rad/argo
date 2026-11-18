import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import DataTable from '../../components/DataTable.js';
import { skillsApi, type AssignmentCell, type AssignmentState, type MatrixResponse } from './api.js';
import { button, Chip, Empty, ErrorState, input, Loading, Reasons, STATE_GLYPH, STATE_LABEL, STATE_TONE, StateChip } from './ui.js';

const TONE_CLASS = { ok: 'text-green-700 dark:text-green-400', bad: 'text-[var(--warn)]', dim: 'text-[var(--ink-faint)]', warn: 'text-amber-700 dark:text-amber-400', accent: 'text-[var(--accent)]' } as const;

/** The cell for an agent x skill pair; absent pairs take the default the server documents. */
export function cellFor(data: MatrixResponse, agent: string, skill: string, index: Map<string, AssignmentCell>): AssignmentCell {
  return index.get(`${agent}\0${skill}`) ?? {
    agent, skill, state: data.mode === 'managed' ? 'not-assigned' : 'legacy', reasons: [], reference: false, deprecated: false, loaded: null,
  };
}

/** Agents (rows) x skills (columns): the effective assignment and why. */
export default function Matrix() {
  const matrix = useQuery({ queryKey: ['skills', 'matrix'], queryFn: skillsApi.matrix });
  const [params, setParams] = useSearchParams();
  const agentFilter = params.get('agent') ?? '';
  const [skillQ, setSkillQ] = useState('');
  const [all, setAll] = useState(false);
  const [open, setOpen] = useState<AssignmentCell | null>(null);

  const index = useMemo(() => new Map((matrix.data?.cells ?? []).map((c) => [`${c.agent}\0${c.skill}`, c])), [matrix.data]);
  const agents = useMemo(() => (matrix.data?.agents ?? []).filter((a) => !agentFilter || a.name === agentFilter), [matrix.data, agentFilter]);
  const skills = useMemo(() => {
    const data = matrix.data;
    if (!data) return [];
    const used = new Set(data.cells.filter((c) => !agentFilter || c.agent === agentFilter).map((c) => c.skill));
    return data.skills.filter((s) => (all || used.has(s)) && (!skillQ || s.includes(skillQ.toLowerCase())));
  }, [matrix.data, all, skillQ, agentFilter]);

  if (matrix.isPending) return <Loading what="the agent matrix" />;
  if (matrix.isError) return <ErrorState error={matrix.error} retry={() => void matrix.refetch()} />;
  const data = matrix.data;

  return (
    <div className="space-y-3 p-3 md:p-4">
      {data.mode === 'legacy' && (
        <p className="rounded border border-[var(--rule)] p-2 text-sm"><Chip tone="accent">No managed policy</Chip> Each agent sees every skill its runtime finds, as before. Cells marked “Visible (no policy)” are not grants.</p>
      )}
      {data.rosterError && <p role="alert" className="text-sm text-[var(--warn)]">The org roster could not be read: {data.rosterError}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <select aria-label="Agent" className={input} value={agentFilter} onChange={(e) => setParams(e.target.value ? { agent: e.target.value } : {})}>
          <option value="">all agents</option>
          {data.agents.map((a) => <option key={a.name} value={a.name}>{a.name}</option>)}
        </select>
        <input aria-label="Filter skills" type="search" className={`${input} min-w-0 flex-1 basis-40`} placeholder="filter skills" value={skillQ} onChange={(e) => setSkillQ(e.target.value)} />
        <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> all skills</label>
        {agentFilter && <Link className="text-xs text-[var(--accent)]" to={`/skills/agents/${encodeURIComponent(agentFilter)}`}>{agentFilter}'s skills</Link>}
      </div>
      <Legend />
      {data.agents.length === 0 ? (
        <Empty>No agents on the org roster. Add agents to the org config to see who gets which skill.</Empty>
      ) : skills.length === 0 ? (
        <Empty>{data.mode === 'managed' ? 'No skill is assigned, denied or referenced for these agents. Tick “all skills” to see every column.' : 'Nothing to show for this filter. Tick “all skills” to see every column.'}</Empty>
      ) : (
        <DataTable label="Agents and skills" phone="scroll" className="border-collapse text-xs">
            <thead>
              <tr>
                <th className="sticky left-0 bg-[var(--paper)] p-1 text-left">Agent</th>
                {skills.map((s) => (
                  <th key={s} className="p-1 align-bottom font-normal">
                    <Link className="inline-block max-w-[7rem] truncate text-[var(--accent)] [writing-mode:vertical-rl] md:max-h-40" title={s} to={`/skills/s/${encodeURIComponent(s)}`}>{s}</Link>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {agents.map((a) => (
                <tr key={a.name} className="border-t border-[var(--rule)]">
                  <th scope="row" className="sticky left-0 bg-[var(--paper)] p-1 text-left font-normal">
                    <Link className="font-medium text-[var(--accent)]" to={`/skills/agents/${encodeURIComponent(a.name)}`}>{a.name}</Link>
                    <span className="block text-[var(--ink-faint)]" title={a.supportNote}>{a.runtime} · {a.support}</span>
                  </th>
                  {skills.map((s) => {
                    const c = cellFor(data, a.name, s, index);
                    return (
                      <td key={s} className="p-0 text-center">
                        <button
                          type="button"
                          className={`min-h-9 min-w-9 ${TONE_CLASS[STATE_TONE[c.state]]} ${open?.agent === a.name && open.skill === s ? 'bg-[var(--paper-sunk)]' : ''}`}
                          aria-label={`${a.name}, ${s}: ${STATE_LABEL[c.state]}${c.reference ? ', named in knowledge' : ''}`}
                          title={STATE_LABEL[c.state]}
                          onClick={() => setOpen(c)}
                        >
                          {STATE_GLYPH[c.state]}{c.reference ? '*' : ''}
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
        </DataTable>
      )}
      {open && <Explain cell={open} support={data.agents.find((a) => a.name === open.agent)?.supportNote ?? ''} onClose={() => setOpen(null)} />}
    </div>
  );
}

function Legend() {
  const states: AssignmentState[] = ['assigned', 'denied', 'unavailable', 'not-assigned', 'legacy'];
  return (
    <p className="flex flex-wrap gap-3 text-xs text-[var(--ink-dim)]">
      {states.map((s) => <span key={s}><span className={TONE_CLASS[STATE_TONE[s]]}>{STATE_GLYPH[s]}</span> {STATE_LABEL[s]}</span>)}
      <span>* named in knowledge (not a grant)</span>
    </p>
  );
}

function Explain({ cell, support, onClose }: { cell: AssignmentCell; support: string; onClose: () => void }) {
  return (
    <section aria-label="Why" className="space-y-1 rounded border border-[var(--accent)] p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <strong>{cell.agent}</strong> × <Link className="text-[var(--accent)]" to={`/skills/s/${encodeURIComponent(cell.skill)}`}>{cell.skill}</Link>
        <StateChip state={cell.state} />
        {cell.deprecated && <Chip tone="warn">deprecated</Chip>}
        <button type="button" className={`${button} ml-auto`} onClick={onClose}>Close</button>
      </div>
      <Reasons reasons={cell.reasons} />
      {cell.reference && <p className="text-xs">A knowledge path in this agent's org config names the skill. That is a reading list entry, not a grant.</p>}
      <p className="text-xs text-[var(--ink-dim)]">{cell.loaded ? `Loaded ${cell.loaded.at} (${cell.loaded.source}): ${cell.loaded.detail}` : 'No load recorded.'}</p>
      {support && <p className="text-xs text-[var(--ink-dim)]">Runtime: {support}</p>}
    </section>
  );
}
