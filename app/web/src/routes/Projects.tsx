import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api, STAGES, type OrgChart, type Stage, type TaskLink, type TrackerFeature, type TrackerItem, type TrackerProject, type TrackerReport } from '../lib/api.js';
import { ago } from '../lib/time.js';

/**
 * The company view of every project: teams own projects, projects are made of
 * features, each feature moves idea (backlog) → designing → building →
 * testing → live, and nothing counts as shipped without a passing
 * verification. Data: the tracker tables, via /api/projects/report.
 */

const LABEL: Record<Stage, string> = {
  idea: 'Backlog', designing: 'Designing', building: 'Building', testing: 'Testing', live: 'Live', parked: 'Parked', done: 'Done',
};
const COLUMNS: Stage[] = ['idea', 'designing', 'building', 'testing', 'live'];
const VIEWS = ['overview', 'divisions', 'board', 'needs', 'teams', 'goals', 'report'] as const;
type View = (typeof VIEWS)[number];
const VIEW_LABEL: Record<View, string> = {
  overview: 'Overview', divisions: 'Divisions', board: 'Board', needs: 'Needs you', teams: 'Teams', goals: 'Goals', report: 'Full report',
};

const chip = 'inline-block rounded border px-1.5 py-0.5 text-xs';
const fileLink = (path: string | null) => (path ? `/file/${path}` : null);

function StageChip({ stage }: { stage: Stage }) {
  const strong = stage === 'testing' || stage === 'live';
  return <span className={`${chip} ${strong ? 'border-[var(--accent)]' : 'border-[var(--rule)] text-[var(--ink-dim)]'}`}>{LABEL[stage]}</span>;
}

/** Segmented by feature stage; the text says the same thing, so color is never the only signal. */
function Progress({ p }: { p: TrackerProject }) {
  const total = p.features.length - p.counts.parked;
  if (total <= 0) return <span className="text-xs text-[var(--ink-faint)]">no features listed</span>;
  const seg = (n: number, cls: string) => (n ? <div className={cls} style={{ width: `${(n / total) * 100}%` }} /> : null);
  return (
    <div className="flex items-center gap-2">
      <div className="flex h-2 w-40 overflow-hidden rounded bg-[var(--paper-sunk)]" aria-hidden>
        {seg(p.counts.live + p.counts.done, 'bg-[var(--accent)]')}
        {seg(p.counts.testing, 'bg-[var(--warn)]')}
        {seg(p.counts.building + p.counts.designing, 'bg-[var(--ink-faint)]')}
      </div>
      <span className="text-xs text-[var(--ink-dim)]">
        {p.counts.live + p.counts.done}/{total} shipped · {p.counts.testing} testing · {p.counts.building + p.counts.designing} in work · {p.counts.idea} backlog
      </span>
    </div>
  );
}

function Items({ items, empty = 'None.' }: { items: TrackerItem[]; empty?: string }) {
  if (!items.length) return <p className="text-sm text-[var(--ink-faint)]">{empty}</p>;
  return (
    <ul className="space-y-1 text-sm">
      {items.map((i) => (
        <li key={`${i.project}/${i.feature ?? ''}/${i.detail}`}>
          <span className="font-medium">{i.feature ? `${i.project} / ${i.title}` : i.title}</span>
          <span className="text-[var(--ink-dim)]">: {i.detail}</span>
        </li>
      ))}
    </ul>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded border border-[var(--rule)] p-3">
      <h2 className="mb-2 font-semibold tracking-tight">{title}</h2>
      {children}
    </section>
  );
}

function Overview({ r }: { r: TrackerReport }) {
  const g = r.gaps;
  const tile = (label: string, value: number | string, sub?: string) => (
    <div className="rounded border border-[var(--rule)] p-3">
      <div className="text-2xl font-semibold">{value}</div>
      <div className="text-xs text-[var(--ink-dim)]">{label}</div>
      {sub && <div className="text-xs text-[var(--ink-faint)]">{sub}</div>}
    </div>
  );
  const inFlight = r.totals.features.designing + r.totals.features.building + r.totals.features.testing;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
        {tile('projects', r.projects.length, `${r.totals.projects.building} building · ${r.totals.projects.live} live`)}
        {tile('features in flight', inFlight, `${r.totals.features.testing} in testing`)}
        {tile('backlog', r.backlog.total, 'features in idea')}
        {tile('shipped, 7 days', r.shipped_7d.length, `${r.moved_7d.length} stage moves`)}
        {tile('checks, 7 days', `${r.verified_7d.pass} / ${r.verified_7d.fail}`, 'passed / failed')}
        {tile('needs you', r.needs_owner.length)}
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <Section title={`Needs you (${r.needs_owner.length})`}>
          <Items items={r.needs_owner} empty="Nothing is waiting on you." />
        </Section>
        <Section title="Gaps">
          <div className="space-y-2 text-sm">
            <div>
              <b>Goals with no work linked:</b>{' '}
              {g.goals_uncovered.length ? g.goals_uncovered.map((x) => `${x.code} ${x.goal}`).join(' · ') : 'none'}
            </div>
            <div><b>Shipped without a passing check:</b></div>
            <Items items={g.unverified_shipped} />
            <div><b>Failing checks:</b></div>
            <Items items={g.failing} />
            <div><b>In testing, no check yet:</b></div>
            <Items items={g.testing_unverified} />
            <div><b>Stale:</b></div>
            <Items items={g.stale} />
            <div><b>Overdue:</b></div>
            <Items items={g.overdue} />
            {g.no_features.length > 0 && <div><b>Active projects with no features:</b> {g.no_features.join(', ')}</div>}
          </div>
        </Section>
        <Section title="Oldest work in flight">
          <Items items={r.oldest} />
        </Section>
        <Section title="Moved in the last 7 days">
          {r.moved_7d.length ? (
            <ul className="space-y-1 text-sm">
              {r.moved_7d.map((m, i) => (
                <li key={i}>
                  <span className="text-[var(--ink-faint)]">{ago(m.at)}</span> <b>{m.feature ? `${m.project} / ${m.title}` : m.title}</b>{' '}
                  {m.from ?? 'new'} → {m.to}
                  {m.by && <span className="text-[var(--ink-faint)]"> · {m.by}</span>}
                  {m.note && <span className="text-[var(--ink-dim)]"> · {m.note}</span>}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-[var(--ink-faint)]">Nothing moved.</p>
          )}
        </Section>
      </div>
    </div>
  );
}

/** The work graph, read side: every card for a bot (task_links) and the kanban's status for it, when agent-hub answers. */
function useCards() {
  const links = useQuery({ queryKey: ['org', 'tasks'], queryFn: () => api.orgTasks(), staleTime: 30_000, retry: false });
  const board = useQuery({ queryKey: ['hub-board', 'exo'], queryFn: () => api.board('exo'), staleTime: 30_000, retry: false });
  const chart = useQuery({ queryKey: ['org', 'chart'], queryFn: api.orgChart, staleTime: 60_000, retry: false });
  const status = new Map((board.data?.tasks ?? []).map((t) => [t.id, t.status]));
  return { links: links.data?.tasks ?? [], status, chart: chart.data ?? null };
}

/** "Give to…": one card, one bot, tagged with this project and feature. The team's lead is the default. */
function GiveCard({ p, f, chart, onDone }: { p: TrackerProject; f: TrackerFeature; chart: OrgChart | null; onDone: () => void }) {
  const bots = (chart?.agents ?? []).filter((a) => a.runtime !== 'human');
  const team = chart?.teams.find((t) => t.slug === p.team);
  const [bot, setBot] = useState('');
  const [title, setTitle] = useState('');
  const chosen = bot || team?.lead || bots[0]?.name || '';
  const give = useMutation({
    mutationFn: () => api.createTask({ board: 'exo', title, body: '', assignee: chosen, project: p.slug, feature: f.slug }),
    onSuccess: () => {
      setTitle('');
      onDone();
    },
  });
  if (!bots.length) return <p className="text-xs text-[var(--ink-faint)]">The org is not imported here.</p>;
  const sorted = [...bots].sort((a, b) => Number((b.team_slug === p.team) || 0) - Number((a.team_slug === p.team) || 0) || a.name.localeCompare(b.name));
  return (
    <form className="mt-1 space-y-1" onSubmit={(e) => { e.preventDefault(); if (title.trim()) give.mutate(); }}>
      <input aria-label={`Card title for ${f.title}`} className="w-full rounded border border-[var(--rule)] bg-transparent px-1 text-xs" placeholder="What should the bot do?" maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} />
      <div className="flex items-center gap-1 text-xs">
        <select aria-label={`Bot for ${f.title}`} className="rounded border border-[var(--rule)] bg-transparent text-xs" value={chosen} onChange={(e) => setBot(e.target.value)}>
          {sorted.map((a) => <option key={a.name} value={a.name}>{a.name}{a.team_slug === p.team ? '' : ` (${a.team_name ?? a.team_slug ?? 'no team'})`}</option>)}
        </select>
        <button type="submit" disabled={!title.trim() || give.isPending} className="rounded bg-[var(--accent)] px-2 py-0.5 text-white disabled:opacity-50">Give to {chosen}</button>
      </div>
      {give.isError && <div className="text-xs text-[var(--warn)]">{give.error.message}</div>}
    </form>
  );
}

function FeatureCard({ p, f, cards }: { p: TrackerProject; f: TrackerFeature; cards: ReturnType<typeof useCards> }) {
  const qc = useQueryClient();
  const [verifying, setVerifying] = useState(false);
  const [giving, setGiving] = useState(false);
  const [check, setCheck] = useState('');
  const refresh = () => qc.invalidateQueries({ queryKey: ['projects'] });
  const mine = cards.links.filter((t) => t.project_slug === p.slug && t.feature_slug === f.slug);
  const move = useMutation({ mutationFn: (stage: Stage) => api.setFeature(p.slug, f.slug, { stage }), onSuccess: refresh });
  const verify = useMutation({
    mutationFn: (result: 'pass' | 'fail') => api.verifyFeature(p.slug, f.slug, { kind: 'manual', check, result }),
    onSuccess: () => {
      setVerifying(false);
      setCheck('');
      void refresh();
    },
  });
  const v = f.verification;
  return (
    <div className="rounded border border-[var(--rule)] bg-[var(--paper)] p-2 text-sm">
      <div className="font-medium">{f.needs_owner && <span title={f.needs_owner}>⚑ </span>}{f.title}</div>
      <div className="text-xs text-[var(--ink-dim)]">
        {f.days_in_stage}d in stage{f.owner && ` · ${f.owner}`}{f.due && ` · due ${f.due}`}
      </div>
      <div className="mt-1 text-xs">
        {v ? (
          <span className={v.result === 'pass' ? '' : 'text-[var(--warn)]'} title={`${v.check}${v.evidence ? `\n${v.evidence}` : ''}`}>
            {v.result === 'pass' ? '✓ verified' : '✗ check failed'} ({v.kind}, {v.at.slice(0, 10)})
          </span>
        ) : (
          <span className="text-[var(--ink-faint)]">not verified</span>
        )}
      </div>
      {f.needs_owner && <div className="mt-1 text-xs text-[var(--warn)]">Needs you: {f.needs_owner}</div>}
      {mine.length > 0 && (
        <ul className="mt-1 space-y-0.5 text-xs" aria-label={`Cards for ${f.title}`}>
          {mine.map((t: TaskLink) => (
            <li key={t.task_id}>
              <Link className="text-[var(--accent)]" to={`/org/agents/${t.assignee}`}>{t.assignee}</Link>
              {' · '}
              <Link className="text-[var(--ink)]" to={`/agents/board/${t.task_id}`}>{t.title}</Link>
              <span className="text-[var(--ink-dim)]"> · {cards.status.get(t.task_id) ?? 'card'}{t.node ? ` · ${t.node}` : ''}{t.rounds ? ` · round ${t.rounds}` : ''}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-1 flex items-center gap-1">
        <select
          aria-label={`Stage of ${f.title}`}
          className="rounded border border-[var(--rule)] bg-transparent text-xs"
          value={f.stage}
          onChange={(e) => move.mutate(e.target.value as Stage)}
        >
          {STAGES.map((s) => (
            <option key={s} value={s}>{LABEL[s]}</option>
          ))}
        </select>
        <button type="button" className="text-xs text-[var(--accent)]" onClick={() => setVerifying((x) => !x)}>
          verify
        </button>
        <button type="button" className="text-xs text-[var(--accent)]" onClick={() => setGiving((x) => !x)}>
          give to a bot
        </button>
      </div>
      {giving && <GiveCard p={p} f={f} chart={cards.chart} onDone={() => { setGiving(false); void qc.invalidateQueries({ queryKey: ['org', 'tasks'] }); void qc.invalidateQueries({ queryKey: ['hub-board'] }); void refresh(); }} />}
      {move.isError && <div className="mt-1 text-xs text-[var(--warn)]">{move.error.message}</div>}
      {verifying && (
        <div className="mt-1 space-y-1">
          <input
            className="w-full rounded border border-[var(--rule)] bg-transparent px-1 text-xs"
            placeholder="What did you check?"
            value={check}
            onChange={(e) => setCheck(e.target.value)}
          />
          <div className="flex gap-2 text-xs">
            <button type="button" disabled={!check.trim()} onClick={() => verify.mutate('pass')}>✓ pass</button>
            <button type="button" disabled={!check.trim()} onClick={() => verify.mutate('fail')}>✗ fail</button>
          </div>
          {verify.isError && <div className="text-xs text-[var(--warn)]">{verify.error.message}</div>}
        </div>
      )}
    </div>
  );
}

function Board({ r }: { r: TrackerReport }) {
  const cards = useCards();
  const [showClosed, setShowClosed] = useState(false);
  const projects = r.projects.filter((p) => showClosed || !['parked', 'done'].includes(p.stage));
  return (
    <div className="space-y-4">
      <label className="text-xs text-[var(--ink-dim)]">
        <input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} /> show parked and done projects
      </label>
      {projects.map((p) => {
        const hidden = p.counts.parked + p.counts.done;
        return (
          <section key={p.slug} className="rounded border border-[var(--rule)]">
            <header className="flex flex-wrap items-center gap-2 border-b border-[var(--rule)] px-3 py-2">
              {p.priority && <span className="text-xs text-[var(--ink-faint)]">#{p.priority}</span>}
              <span className="font-semibold">{p.title}</span>
              <StageChip stage={p.stage} />
              {p.team && <span className="text-xs text-[var(--ink-dim)]">team {p.team}</span>}
              {p.health && <span className="text-xs text-[var(--ink-dim)]">health {p.health}</span>}
              {p.goals.length > 0 && <span className="text-xs text-[var(--ink-dim)]">goals {p.goals.join(', ')}</span>}
              <Progress p={p} />
              <span className="ml-auto flex gap-2 text-xs">
                {fileLink(p.devlog_path) && <Link className="text-[var(--accent)]" to={fileLink(p.devlog_path)!}>dev log</Link>}
                {fileLink(p.design_path) && <Link className="text-[var(--accent)]" to={fileLink(p.design_path)!}>design</Link>}
              </span>
              <div className="w-full text-sm">
                <span className="text-[var(--ink-dim)]">Next:</span> {p.next_action ?? <span className="text-[var(--ink-faint)]">not set in the Resume block</span>}
                {p.needs_owner && <span className="ml-3 text-[var(--warn)]">⚑ Needs you: {p.needs_owner}</span>}
              </div>
            </header>
            <div className="grid grid-cols-1 gap-2 p-2 md:grid-cols-5">
              {COLUMNS.map((s) => (
                <div key={s} className="min-w-0">
                  <div className="mb-1 text-xs font-medium text-[var(--ink-dim)]">{LABEL[s]} ({p.counts[s]})</div>
                  <div className="space-y-2">
                    {p.features.filter((f) => f.stage === s).map((f) => <FeatureCard key={f.id} p={p} f={f} cards={cards} />)}
                  </div>
                </div>
              ))}
            </div>
            {hidden > 0 && <div className="px-3 pb-2 text-xs text-[var(--ink-faint)]">{p.counts.done} done · {p.counts.parked} parked (not shown)</div>}
          </section>
        );
      })}
    </div>
  );
}

function Needs({ r }: { r: TrackerReport }) {
  const qc = useQueryClient();
  const clear = useMutation({
    mutationFn: (n: TrackerItem) =>
      n.feature ? api.setFeature(n.project, n.feature, { needs_owner: null }) : api.setProject(n.project, { needs_owner: null }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['projects'] }),
  });
  if (!r.needs_owner.length) return <p className="text-[var(--ink-dim)]">Nothing is waiting on you.</p>;
  return (
    <table className="w-full text-sm">
      <thead className="text-left text-xs text-[var(--ink-dim)]">
        <tr><th className="py-1">Priority</th><th>Project / feature</th><th>What you need to do</th><th>Due</th><th /></tr>
      </thead>
      <tbody>
        {r.needs_owner.map((n) => (
          <tr key={`${n.project}/${n.feature ?? ''}`} className="border-t border-[var(--rule)]">
            <td className="py-2">{n.priority ?? ''}</td>
            <td className="font-medium">{n.feature ? `${n.project} / ${n.title}` : n.title}</td>
            <td>{n.detail}</td>
            <td>{n.due ?? ''}</td>
            <td className="text-right">
              <button type="button" className="text-xs text-[var(--accent)]" onClick={() => clear.mutate(n)}>done</button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Teams({ r }: { r: TrackerReport }) {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {r.teams.map((t) => {
        const ps = r.projects.filter((p) => p.team === t.slug);
        return (
          <Section key={t.slug} title={t.name}>
            <div className="mb-2 text-xs text-[var(--ink-dim)]">
              lead {t.lead ?? 'none'} · {t.in_flight} features in flight · {t.shipped_7d} shipped this week
            </div>
            <ul className="space-y-1 text-sm">
              {ps.map((p) => (
                <li key={p.slug} className="flex items-center gap-2">
                  <StageChip stage={p.stage} /> <span className="font-medium">{p.title}</span>
                  <span className="text-xs text-[var(--ink-dim)]">{p.features.length} features</span>
                </li>
              ))}
            </ul>
          </Section>
        );
      })}
      {r.gaps.no_team.length > 0 && <Section title="No team yet"><p className="text-sm">{r.gaps.no_team.join(', ')}</p></Section>}
    </div>
  );
}

/** The org chart: corporation → divisions → projects (with their team) → feature mix. */
function Divisions({ r }: { r: TrackerReport }) {
  const unassigned = r.projects.filter((p) => !p.division);
  const block = (key: string, title: string, sub: string, ps: TrackerProject[]) => (
    <Section key={key} title={title}>
      <div className="mb-2 text-xs text-[var(--ink-dim)]">{sub}</div>
      <ul className="space-y-2 text-sm">
        {ps.map((p) => (
          <li key={p.slug}>
            <div className="flex flex-wrap items-center gap-2">
              <StageChip stage={p.stage} /> <span className="font-medium">{p.title}</span>
              {p.team && <span className="text-xs text-[var(--ink-dim)]">team {p.team}</span>}
              {p.needs_owner && <span className="text-xs text-[var(--warn)]">⚑ {p.needs_owner}</span>}
            </div>
            <Progress p={p} />
          </li>
        ))}
      </ul>
    </Section>
  );
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {r.divisions.map((d) =>
        block(
          d.slug,
          d.name,
          `${d.projects.length} projects · ${d.in_flight} features in flight · ${d.shipped_7d} shipped this week · ${d.needs_owner} need you`,
          r.projects.filter((p) => p.division === d.slug),
        ),
      )}
      {unassigned.length > 0 && block('none', 'No division yet', `${unassigned.length} projects`, unassigned)}
    </div>
  );
}

function Goals({ r }: { r: TrackerReport }) {
  return (
    <table className="w-full text-sm">
      <thead className="text-left text-xs text-[var(--ink-dim)]">
        <tr><th className="py-1">Goal</th><th>Horizon</th><th>Status</th><th>Due</th><th>Linked work</th></tr>
      </thead>
      <tbody>
        {r.goals.filter((g) => !g.code.startsWith('T')).map((g) => {
          const linked = [...g.projects, ...g.features];
          return (
            <tr key={g.code} className="border-t border-[var(--rule)] align-top">
              <td className="py-2"><b>{g.code}</b> {g.goal}</td>
              <td>{g.horizon}</td>
              <td>{g.status}</td>
              <td>{g.due ?? ''}</td>
              <td>{linked.length ? linked.join(', ') : <span className="text-[var(--warn)]">nothing linked</span>}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function FullReport() {
  const md = useQuery({ queryKey: ['projects', 'markdown'], queryFn: api.projectsMarkdown });
  if (md.isError) return <p>⚠ {md.error.message}</p>;
  return <article className="prose max-w-none"><ReactMarkdown remarkPlugins={[remarkGfm]}>{md.data?.text ?? ''}</ReactMarkdown></article>;
}

export default function Projects() {
  const [params, setParams] = useSearchParams();
  const view = (VIEWS as readonly string[]).includes(params.get('view') ?? '') ? (params.get('view') as View) : 'overview';
  const report = useQuery({ queryKey: ['projects', 'report'], queryFn: api.projectsReport, refetchInterval: 60_000 });
  const r = report.data;

  return (
    <div className="h-full overflow-y-auto p-4">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold tracking-tight">Projects</h1>
        {/* Scrolls inside its own strip on a phone instead of widening the page. */}
        <nav className="flex max-w-full gap-1 overflow-x-auto whitespace-nowrap text-sm" aria-label="Projects views">
          {VIEWS.map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setParams(v === 'overview' ? {} : { view: v })}
              className={`rounded px-2 py-1 ${v === view ? 'bg-[var(--paper-sunk)] text-[var(--ink)]' : 'text-[var(--ink-dim)] hover:text-[var(--ink)]'}`}
            >
              {VIEW_LABEL[v]}
              {v === 'needs' && r ? ` (${r.needs_owner.length})` : ''}
            </button>
          ))}
        </nav>
        <span className="ml-auto text-xs text-[var(--ink-faint)]">{r?.as_of ? `updated ${ago(r.as_of)}` : ''}</span>
      </div>
      {report.isError && <p>⚠ {report.error.message}</p>}
      {r && r.projects.length === 0 && (
        <p className="mb-3 text-sm text-[var(--ink-dim)]">
          No projects in this database yet. Add one with `cli-projects add-project`, or point this app at the database that holds the tracker.
        </p>
      )}
      {r && view === 'overview' && <Overview r={r} />}
      {r && view === 'divisions' && <Divisions r={r} />}
      {r && view === 'board' && <Board r={r} />}
      {r && view === 'needs' && <Needs r={r} />}
      {r && view === 'teams' && <Teams r={r} />}
      {r && view === 'goals' && <Goals r={r} />}
      {view === 'report' && <FullReport />}
    </div>
  );
}
