import { useQuery } from '@tanstack/react-query';
import { Link, Navigate, useParams } from 'react-router-dom';
import { VaultMarkdown } from '../../components/VaultMarkdown.js';
import { fileHref } from '../../lib/api.js';
import { ApiError } from '../../lib/http.js';
import { ago } from '../../lib/time.js';
import { projectsApi, type ProjectPage } from '../Projects.api.js';
import { ArchiveButton, MD, ArchivedChip, Section, StageChip } from './parts.js';

/**
 * `/projects/<area>/<slug>`: one project. Its outcome (what done means), its stage and how
 * it got there, the checks recorded against it, the next action and the start of its
 * README. Data: GET /api/projects/<area>/<slug>.
 */

function Body({ d }: { d: ProjectPage }) {
  const p = d.project;
  return (
    <>
      <header className="mb-4">
        <div className="text-xs text-[var(--ink-dim)]">
          <Link to="/projects" className="hover:underline">Projects</Link> / <Link to={`/areas/${p.area}`} className="hover:underline">{p.area_title}</Link>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-semibold tracking-tight break-words">{p.title}</h1>
          <StageChip stage={p.stage} />
          {(p.archived_at || p.area_archived) && <ArchivedChip />}
          {/* A project hidden by its area comes back with the area, not on its own. */}
          {!p.area_archived && <span className="md:ml-auto"><ArchiveButton area={p.area} project={p.slug} title={p.title} archived={Boolean(p.archived_at)} /></span>}
        </div>
        <div className="mt-1 flex flex-wrap gap-x-4 text-sm text-[var(--ink-dim)]">
          <span>{p.due ? `Due ${p.due}` : 'No due date'}</span>
          <span>Owner: {p.owner ?? 'none'}</span>
          {p.health && <span>health {p.health}</span>}
          {p.started && <span>started {p.started}</span>}
          {p.shipped_at && <span>shipped {p.shipped_at}</span>}
        </div>
        {p.needs_owner && <div className="mt-1 text-sm break-words text-[var(--warn)]">⚑ Needs you: {p.needs_owner}</div>}
        {p.blocked_on && <div className="mt-1 text-sm break-words text-[var(--warn)]">Blocked on: {p.blocked_on}</div>}
        {p.area_archived && <div className="mt-1 text-sm text-[var(--ink-dim)]">Its area is archived, so this project is hidden with it.</div>}
      </header>

      <div className="space-y-3">
        <Section title="Outcome">
          <p className="text-sm break-words">{p.outcome ?? <span className="text-[var(--ink-dim)]">Not set. Say what done means with `cli-projects set {p.area}/{p.slug} --outcome "..."`.</span>}</p>
        </Section>

        <Section title="Next action">
          <p className="text-sm break-words">{p.next_action ?? <span className="text-[var(--ink-dim)]">Not set.</span>}</p>
        </Section>

        <Section title="Stage history">
          {d.stages.length > 0 ? (
            <ul className="space-y-1 text-sm">
              {d.stages.map((s, i) => (
                <li key={i} className="break-words">
                  <span className="text-[var(--ink-faint)]">{s.at.slice(0, 10)}</span> {s.from ?? 'new'} → <b>{s.to}</b>
                  {s.by && <span className="text-[var(--ink-faint)]"> · {s.by}</span>}
                  {s.note && <span className="text-[var(--ink-dim)]"> · {s.note}</span>}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-[var(--ink-dim)]">No stage change recorded.</p>
          )}
        </Section>

        <Section title="Verifications" aside="a project goes live or done only after a passing check">
          {d.verifications.length > 0 ? (
            <ul className="space-y-2 text-sm">
              {d.verifications.map((v, i) => (
                <li key={i} className="min-w-0">
                  <div className="break-words">
                    <span className={v.result === 'pass' ? '' : 'text-[var(--warn)]'}>{v.result === 'pass' ? '✓ pass' : '✗ fail'}</span>{' '}
                    <span className="text-[var(--ink-dim)]">({v.kind})</span> {v.check}
                    <span className="text-[var(--ink-faint)]"> · {ago(v.at)}{v.by ? ` · ${v.by}` : ''}</span>
                  </div>
                  {v.evidence && <pre className="mt-1 max-w-full overflow-x-auto rounded bg-[var(--paper-sunk)] p-2 text-xs whitespace-pre-wrap [overflow-wrap:anywhere]">{v.evidence}</pre>}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-[var(--ink-dim)]">Not verified yet.</p>
          )}
        </Section>

        {d.readme && (
          <Section title="README" aside={<Link to={fileHref(d.readme.path)} className="break-all text-[var(--accent)] underline">{d.readme.path}</Link>}>
            {d.readme.excerpt ? <VaultMarkdown text={d.readme.excerpt} className={MD} /> : <p className="text-sm text-[var(--ink-dim)]">The note has no text under its title yet.</p>}
          </Section>
        )}
      </div>
    </>
  );
}

export default function ProjectDetail() {
  const { area = '', slug = '' } = useParams();
  const page = useQuery({ queryKey: ['projects', 'detail', area, slug], queryFn: () => projectsApi.projectPage(area, slug), retry: false });
  const missing = page.error instanceof ApiError && (page.error.status === 404 || page.error.status === 400);
  return (
    <div className="h-full overflow-y-auto p-4">
      <div className="mx-auto max-w-5xl">
        {page.isError && (missing
          ? <p>No project “{area}/{slug}”. <Link to="/projects" className="text-[var(--accent)] underline">All projects</Link></p>
          : <p>⚠ {page.error.message}</p>)}
        {page.data && <Body d={page.data} />}
      </div>
    </div>
  );
}

/** `/projects/<area-slug>` was the area's address before areas had their own pages. It now lives at `/areas/<area-slug>`. */
export function OldAreaLink() {
  const { area = '' } = useParams();
  return <Navigate to={`/areas/${encodeURIComponent(area)}`} replace />;
}
