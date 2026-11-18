import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { LIFECYCLE_STATUSES, SKILL_SOURCES } from '@secondbrain/contracts/skills';
import DataTable from '../../components/DataTable.js';
import { skillsApi, type LibraryResponse, type SkillRow } from './api.js';
import { button, Chip, Digest, Empty, ErrorState, input, lifecycleTone, Loading, Revision } from './ui.js';

const FLAGS = ['override', 'duplicate', 'invalid', 'dirty'] as const;
type Flag = (typeof FLAGS)[number];

export function matches(row: SkillRow, q: string, source: string, status: string, flag: string): boolean {
  if (source && !row.candidates.some((c) => c.source === source)) return false;
  if (status && row.lifecycle.status !== status) return false;
  if (flag && !row.flags[flag as Flag]) return false;
  if (!q) return true;
  const needle = q.toLowerCase();
  return [row.name, row.effective?.description ?? '', ...row.candidates.flatMap((c) => [c.id, c.source, c.category ?? ''])]
    .some((s) => s.toLowerCase().includes(needle));
}

/** The searchable library: every skill name, its effective package and every other candidate. */
export default function Library() {
  const qc = useQueryClient();
  const lib = useQuery({ queryKey: ['skills', 'library'], queryFn: () => skillsApi.library() });
  const [q, setQ] = useState('');
  const [source, setSource] = useState('');
  const [status, setStatus] = useState('');
  const [flag, setFlag] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const rows = useMemo(() => (lib.data?.skills ?? []).filter((r) => matches(r, q, source, status, flag)), [lib.data, q, source, status, flag]);

  async function refresh(): Promise<void> {
    setRefreshing(true);
    try {
      qc.setQueryData(['skills', 'library'], await skillsApi.library(true));
    } catch {
      void lib.refetch();
    } finally {
      setRefreshing(false);
    }
  }

  if (lib.isPending) return <Loading what="the skill library" />;
  if (lib.isError) return <ErrorState error={lib.error} retry={() => void lib.refetch()} />;
  const data = lib.data;

  return (
    <div className="space-y-3 p-3 md:p-4">
      <ModeBanner data={data} />
      <div className="flex flex-wrap items-center gap-2">
        <input aria-label="Search skills" type="search" className={`${input} min-w-0 flex-1 basis-48`} placeholder="Search name, description, source, category" value={q} onChange={(e) => setQ(e.target.value)} />
        <select aria-label="Source" className={input} value={source} onChange={(e) => setSource(e.target.value)}>
          <option value="">any source</option>
          {SKILL_SOURCES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select aria-label="Status" className={input} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">any status</option>
          {LIFECYCLE_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select aria-label="Flag" className={input} value={flag} onChange={(e) => setFlag(e.target.value)}>
          <option value="">any flag</option>
          {FLAGS.map((f) => <option key={f} value={f}>{f}</option>)}
        </select>
        <button type="button" className={button} disabled={refreshing} onClick={() => void refresh()}>{refreshing ? 'Rescanning…' : 'Rescan'}</button>
      </div>
      <p className="text-xs text-[var(--ink-dim)]">{rows.length} of {data.skills.length} skills</p>
      {data.skills.length === 0 ? (
        <Empty>No skills found. The library reads the vault's skill folders, the engine's skills and any extra folders listed in settings; none of them has a package with a SKILL.md yet.</Empty>
      ) : rows.length === 0 ? (
        <Empty>No skill matches these filters.</Empty>
      ) : (
          <DataTable label="Skills" phone="cards" className="w-full text-sm">
            <thead className="text-left text-xs text-[var(--ink-dim)]">
              <tr><th className="py-1">Skill</th><th>Package</th><th>Version</th><th>Status</th><th>Agents</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.name} className="border-t border-[var(--rule)] align-top">
                  <td className="py-2 pr-3">
                    <Link className="font-medium text-[var(--accent)]" to={`/skills/s/${encodeURIComponent(r.name)}`}>{r.name}</Link>
                    <p className="line-clamp-2 max-w-md text-xs text-[var(--ink-dim)]">{r.effective?.description || 'No description.'}</p>
                  </td>
                  <td className="pr-3"><PackageCell row={r} /></td>
                  <td className="pr-3">{r.effective ? <span className="space-y-0.5"><Digest value={r.effective.digest} /><br /><Revision revision={r.effective.revision} dirty={r.effective.dirty} /></span> : '-'}</td>
                  <td className="pr-3"><Chip tone={lifecycleTone(r.lifecycle.status)}>{r.lifecycle.status}</Chip></td>
                  <td className="text-xs"><Counts row={r} /></td>
                </tr>
              ))}
            </tbody>
          </DataTable>
      )}
    </div>
  );
}

function PackageCell({ row }: { row: SkillRow }) {
  return (
    <div className="flex flex-wrap items-center gap-1 text-xs">
      <code>{row.effective?.id ?? 'no usable package'}</code>
      {row.flags.override && <Chip tone="accent" title="A private package replaces a shared one with the same name">override</Chip>}
      {row.flags.duplicate && <Chip tone="warn" title="More than one package has this name">duplicate</Chip>}
      {row.flags.invalid && <Chip tone="bad" title="At least one candidate failed validation">invalid</Chip>}
      {row.flags.dirty && <Chip tone="warn" title="Uncommitted changes">uncommitted</Chip>}
      {row.candidates.length > 1 && <span className="text-[var(--ink-faint)]">{row.candidates.length} candidates</span>}
    </div>
  );
}

function Counts({ row }: { row: SkillRow }) {
  return (
    <span className="text-[var(--ink-dim)]">
      {row.assigned} assigned · {row.denied} denied · {row.references} named in knowledge
    </span>
  );
}

export function ModeBanner({ data }: { data: Pick<LibraryResponse, 'mode' | 'policy' | 'roots'> }) {
  const { mode, policy, roots } = data;
  return (
    <section aria-label="Policy" className="space-y-1 rounded border border-[var(--rule)] p-3 text-sm">
      {mode === 'legacy' ? (
        <p><Chip tone="accent">No managed policy</Chip> Every agent sees its runtime's whole skill folder, as before. Assignments below are informational until a policy file turns management on.</p>
      ) : (
        <p><Chip tone="ok">Managed</Chip> Agents get the skills the policy assigns them. Denials win over grants.</p>
      )}
      <p className="text-xs text-[var(--ink-dim)]">
        Policy file <code>{policy.file}</code>{' '}
        {policy.exists ? <>at <Revision revision={policy.revision} dirty={policy.dirty} /> <Digest value={policy.digest} /></> : '(not present)'}
      </p>
      {policy.errors.length > 0 && (
        <ul role="alert" className="list-disc pl-5 text-xs text-[var(--warn)]">{policy.errors.map((e) => <li key={e}>{e}</li>)}</ul>
      )}
      {policy.warnings.length > 0 && <ul className="list-disc pl-5 text-xs text-amber-700 dark:text-amber-400">{policy.warnings.map((e) => <li key={e}>{e}</li>)}</ul>}
      <details className="text-xs">
        <summary className="cursor-pointer text-[var(--ink-dim)]">{roots.length} skill folders</summary>
        <ul className="mt-1 space-y-0.5">
          {roots.map((r) => (
            <li key={r.id}>
              <code>{r.id}</code> {r.label}: {r.exists ? `${r.packages} packages` : 'missing'}
              {r.git ? (r.revision ? <> at <code title={r.revision}>{r.revision.slice(0, 8)}</code></> : '') : ' (not in Git)'}
              {r.error && <span className="text-[var(--warn)]"> {r.error}</span>}
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}
