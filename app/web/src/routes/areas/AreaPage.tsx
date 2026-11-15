import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { VaultMarkdown } from '../../components/VaultMarkdown.js';
import { fileHref, rawUrl } from '../../lib/api.js';
import { ApiError } from '../../lib/http.js';
import { ago } from '../../lib/time.js';
import { projectsApi, type AreaKpi, type AreaPage as AreaPageData, type ProjectRow } from '../Projects.api.js';
import { ArchiveButton, ArchivedChip, eventText, LinkGroups, Section, StageChip, StatusChip } from './parts.js';

/**
 * `/areas/<slug>`: the area's home page. The header and the roadmap come from the tracker;
 * the description, links, style guide, assets, goals and KPI definitions come from the
 * area's home note. Areas differ, so a section the area does not have is not drawn.
 * Data: GET /api/areas/<slug>.
 */

const num = (n: number): string => (Number.isInteger(n) ? n.toLocaleString('en-US') : n.toLocaleString('en-US', { maximumFractionDigits: 2 }));

/** The trend of one KPI as a small line. The numbers next to it say the same thing in text. */
function Sparkline({ values, label }: { values: number[]; label: string }) {
  const w = 120;
  const h = 32;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const x = (i: number) => 2 + (i * (w - 4)) / (values.length - 1);
  const y = (v: number) => h - 3 - ((v - min) / span) * (h - 6);
  return (
    <svg role="img" aria-label={label} viewBox={`0 0 ${w} ${h}`} width={w} height={h} className="shrink-0">
      <polyline fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" points={values.map((v, i) => `${x(i)},${y(v)}`).join(' ')} />
      <circle cx={x(values.length - 1)} cy={y(values.at(-1)!)} r="2.5" fill="var(--accent)" />
    </svg>
  );
}

function Kpi({ k }: { k: AreaKpi }) {
  const unit = k.unit ? ` ${k.unit}` : '';
  const first = k.readings[0];
  const verdict = k.on_target === null ? null : k.on_target ? 'at target' : k.direction === 'down' ? 'above target' : 'below target';
  return (
    <li className="min-w-0 rounded border border-[var(--rule)] p-2" aria-label={k.name}>
      <div className="text-xs text-[var(--ink-dim)]">{k.name}</div>
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <span className="text-xl font-semibold">{k.latest ? num(k.latest.value) : 'no reading'}</span>
          {k.latest && <span className="text-sm text-[var(--ink-dim)]">{unit}</span>}
        </div>
        {k.readings.length >= 2 && <Sparkline values={k.readings.map((r) => r.value)} label={`${k.name}: ${num(first!.value)} to ${num(k.latest!.value)} over ${k.readings.length} readings`} />}
      </div>
      <div className="text-xs text-[var(--ink-dim)]">
        {k.target !== null && <>target {num(k.target)}{unit}{k.by ? ` by ${k.by}` : ''}</>}
        {verdict && <span className={k.on_target ? '' : 'text-[var(--warn)]'}>{k.target !== null ? ' · ' : ''}{k.on_target ? '✓ ' : ''}{verdict}</span>}
        {k.readings.length >= 2 && <> · from {num(first!.value)} {ago(first!.at)}</>}
        {k.latest && <> · read {ago(k.latest.at)}</>}
      </div>
    </li>
  );
}

function RoadmapRow({ p, today }: { p: ProjectRow; today: string }) {
  const late = p.due !== null && p.due < today;
  return (
    <li className="min-w-0 border-t border-[var(--rule)] py-2 first:border-t-0">
      <div className="flex flex-wrap items-center gap-2">
        <Link to={`/projects/${p.area}/${p.slug}`} className="font-medium text-[var(--accent)] hover:underline">{p.title}</Link>
        <StageChip stage={p.stage} />
        <span className={`text-xs ${late ? 'text-[var(--warn)]' : 'text-[var(--ink-dim)]'}`}>{p.due ? `due ${p.due}${late ? ' (overdue)' : ''}` : 'no due date'}</span>
        {p.owner && <span className="text-xs text-[var(--ink-dim)]">{p.owner}</span>}
      </div>
      {p.outcome && p.outcome !== p.title && <div className="text-sm break-words text-[var(--ink-dim)]">Outcome: {p.outcome}</div>}
      {p.next_action && <div className="text-sm break-words text-[var(--ink-dim)]">Next: {p.next_action}</div>}
    </li>
  );
}

function Body({ d }: { d: AreaPageData }) {
  const a = d.area;
  const today = new Date().toISOString().slice(0, 10);
  const assets = d.style?.assets ?? null;
  return (
    <>
      <header className="mb-4">
        <div className="text-xs text-[var(--ink-dim)]"><Link to="/areas" className="hover:underline">Areas</Link>{a.division_name ? ` / ${a.division_name}` : ''}</div>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-semibold tracking-tight break-words">{a.title}</h1>
          {a.archived_at ? <ArchivedChip /> : <StatusChip status={a.status} />}
          {a.health && <span className="text-xs text-[var(--ink-dim)]">health {a.health}</span>}
          <span className="md:ml-auto"><ArchiveButton area={a.slug} title={a.title} archived={Boolean(a.archived_at)} /></span>
        </div>
        {d.home?.description && <p className="mt-1 break-words">{d.home.description}</p>}
        <div className="mt-1 flex flex-wrap gap-x-4 text-sm text-[var(--ink-dim)]">
          <span>Owner: {a.owner ?? 'none'}</span>
          <span>Team: {a.team_name ?? a.team ?? 'none'}{a.members.length > 0 ? ` (${a.members.join(', ')})` : ''}</span>
          {d.home && <Link to={fileHref(d.home.path)} className="text-[var(--accent)] hover:underline">home note</Link>}
        </div>
        {a.needs_owner && <div className="mt-1 text-sm break-words text-[var(--warn)]">⚑ Needs you: {a.needs_owner}</div>}
        {a.archived_at && <div className="mt-1 text-sm text-[var(--ink-dim)]">Archived {ago(a.archived_at)}. It and its projects are hidden from the active lists.</div>}
      </header>

      <div className="space-y-3">
        {d.home?.excerpt && (
          <Section title="About">
            <VaultMarkdown text={d.home.excerpt} />
          </Section>
        )}
        {!d.home && (
          <p className="text-sm text-[var(--ink-dim)]">
            This area has no home note yet. Set one with `cli-areas set {a.slug} --home PATH`; its frontmatter holds the description, links, style, goals and KPIs.
          </p>
        )}

        {d.links.length > 0 && (
          <Section title="Links">
            <LinkGroups groups={d.links} />
          </Section>
        )}

        {d.style && (
          <Section title="Style and assets">
            <div className="space-y-3">
              {d.style.other.length > 0 && <LinkGroups groups={d.style.other} />}
              {d.style.guide && (
                <div className="min-w-0">
                  <div className="mb-1 text-xs text-[var(--ink-dim)]">
                    Style guide: <Link to={fileHref(d.style.guide.path)} className="break-all text-[var(--accent)] underline">{d.style.guide.path}</Link>
                  </div>
                  {d.style.guide.markdown !== null ? (
                    <div className="max-h-[32rem] overflow-y-auto rounded bg-[var(--paper-sunk)] p-3">
                      <VaultMarkdown text={d.style.guide.markdown} />
                      {d.style.guide.truncated && <p className="mt-2 text-xs text-[var(--ink-dim)]">Cut here. Open the note for the rest.</p>}
                    </div>
                  ) : (
                    <p className="text-sm text-[var(--ink-dim)]">That note is not in the index, so it is not shown here.</p>
                  )}
                </div>
              )}
              {assets && (
                <div className="min-w-0">
                  <div className="mb-1 text-xs text-[var(--ink-dim)]">
                    Assets: <Link to={fileHref(assets.path)} className="break-all text-[var(--accent)] underline">{assets.path}</Link>
                  </div>
                  {assets.images.length > 0 ? (
                    <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6" aria-label="Asset images">
                      {assets.images.map((img) => (
                        <li key={img.path} className="min-w-0">
                          <Link to={fileHref(img.path)} title={img.path} className="block rounded border border-[var(--rule)] bg-[var(--paper-sunk)] p-1">
                            <img src={rawUrl(img.path)} alt={img.name} loading="lazy" className="h-24 w-full object-contain" />
                            <span className="block truncate text-center text-xs text-[var(--ink-dim)]">{img.name}</span>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-sm text-[var(--ink-dim)]">No images in that folder.</p>
                  )}
                  {assets.more > 0 && <p className="mt-1 text-xs text-[var(--ink-dim)]">and {assets.more} more in the folder.</p>}
                </div>
              )}
            </div>
          </Section>
        )}

        {d.goals.length > 0 && (
          <Section title="Goals">
            <ul className="list-disc space-y-1 pl-5 text-sm">
              {d.goals.map((g, i) => <li key={i} className="break-words">{g.code && g.code !== g.text ? <b>{g.code} </b> : null}{g.text}</li>)}
            </ul>
          </Section>
        )}

        {d.kpis.length > 0 && (
          <Section title="KPIs">
            <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {d.kpis.map((k) => <Kpi key={k.key} k={k} />)}
            </ul>
          </Section>
        )}

        <Section title="Roadmap" aside="open projects, by due date">
          {d.roadmap.length > 0 ? (
            <ul>{d.roadmap.map((p) => <RoadmapRow key={p.slug} p={p} today={today} />)}</ul>
          ) : (
            <p className="text-sm text-[var(--ink-dim)]">No open projects. Add one with `cli-projects add {a.slug}/&lt;project&gt; --outcome "..."`.</p>
          )}
          <Link to={`/projects?area=${a.slug}`} className="mt-2 inline-block text-sm text-[var(--accent)] hover:underline">All projects of this area</Link>
        </Section>

        <Section title="Recent activity" aside="the last 14 days of the change history">
          {d.recent.length > 0 ? (
            <ul className="space-y-1 text-sm">
              {d.recent.map((e) => (
                <li key={e.id} className="break-words">
                  <span className="text-[var(--ink-faint)]">{ago(e.at)}</span>{' '}
                  <b>{e.project ? (e.project_title ?? e.project) : a.title}</b> {eventText(e)}
                  <span className="text-[var(--ink-faint)]"> · {e.actor}</span>
                  {e.note && e.kind !== 'frontmatter' && <span className="text-[var(--ink-dim)]"> · {e.note}</span>}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-[var(--ink-dim)]">Nothing changed in the last 14 days.</p>
          )}
        </Section>
      </div>
    </>
  );
}

export default function AreaPage() {
  const { slug = '' } = useParams();
  const page = useQuery({ queryKey: ['projects', 'area', slug], queryFn: () => projectsApi.areaPage(slug), retry: false });
  const missing = page.error instanceof ApiError && (page.error.status === 404 || page.error.status === 400);
  return (
    <div className="h-full overflow-y-auto p-4">
      <div className="mx-auto max-w-5xl">
        {page.isError && (missing
          ? <p>No area “{slug}”. <Link to="/areas" className="text-[var(--accent)] underline">All areas</Link></p>
          : <p>⚠ {page.error.message}</p>)}
        {page.data && <Body d={page.data} />}
      </div>
    </div>
  );
}
