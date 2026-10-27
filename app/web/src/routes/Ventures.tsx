import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { api, type Venture, type VentureBrand } from '../lib/api.js';

/**
 * Ventures: the things the owner runs. Each has a vault home folder, an
 * optional parent (one level), its projects, KPIs and a brand kit read from
 * the folder's brand/brand.md. Nothing here names a venture; it renders
 * whatever the database holds.
 */

const chip = 'inline-block rounded border border-[var(--rule)] px-1.5 py-0.5 text-xs text-[var(--ink-dim)]';
const HEX = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/** Every hex color anywhere in the tokens, with the key path that names it. */
export function swatches(tokens: Record<string, unknown>, path = ''): { name: string; hex: string }[] {
  const out: { name: string; hex: string }[] = [];
  for (const [k, v] of Object.entries(tokens)) {
    const name = path ? `${path}.${k}` : k;
    if (typeof v === 'string' && HEX.test(v)) out.push({ name, hex: v });
    else if (v && typeof v === 'object' && !Array.isArray(v)) out.push(...swatches(v as Record<string, unknown>, name));
  }
  return out;
}

function Brand({ brand }: { brand: VentureBrand }) {
  const colors = swatches(brand.tokens);
  const other = Object.entries(brand.tokens).filter(([, v]) => typeof v !== 'object' || v === null || Array.isArray(v));
  const fonts = brand.tokens.fonts && typeof brand.tokens.fonts === 'object' ? Object.entries(brand.tokens.fonts as Record<string, unknown>) : [];
  const files = [...brand.assets.logo, ...brand.assets.fonts, ...brand.assets.images];
  return (
    <section aria-label="Brand" className="mt-6">
      <h2 className="mb-2 text-sm font-medium">Brand</h2>
      {colors.length > 0 && (
        <ul className="mb-3 flex flex-wrap gap-2">
          {colors.map((c) => (
            <li key={c.name} className="flex items-center gap-2 rounded border border-[var(--rule)] px-2 py-1 text-xs">
              <span className="inline-block h-4 w-4 rounded border border-[var(--rule)]" style={{ background: c.hex }} aria-hidden />
              <span>{c.name}</span>
              <code className="text-[var(--ink-dim)]">{c.hex}</code>
            </li>
          ))}
        </ul>
      )}
      {fonts.length > 0 && <p className="mb-2 text-sm">Fonts: {fonts.map(([k, v]) => `${k} ${String(v)}`).join(' · ')}</p>}
      {other.filter(([k]) => k !== 'venture').map(([k, v]) => (
        <p key={k} className="text-sm"><span className="text-[var(--ink-dim)]">{k}:</span> {String(v)}</p>
      ))}
      {brand.body && <p className="mt-2 whitespace-pre-wrap text-sm text-[var(--ink-dim)]">{brand.body}</p>}
      {files.length > 0 && (
        <ul className="mt-2 text-xs">
          {files.map((f) => <li key={f}><Link className="underline" to={`/file/${f}`}>{f}</Link></li>)}
        </ul>
      )}
      <p className="mt-2 text-xs"><Link className="underline" to={`/file/${brand.file}`}>{brand.file}</Link></p>
    </section>
  );
}

function Detail({ slug }: { slug: string }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['venture', slug], queryFn: () => api.venture(slug), retry: false });
  const scaffold = useMutation({
    mutationFn: () => api.scaffoldVenture(slug),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['venture', slug] }); void qc.invalidateQueries({ queryKey: ['ventures'] }); },
  });
  if (q.isLoading) return <p className="text-sm text-[var(--ink-dim)]">Loading…</p>;
  if (q.error || !q.data) return <p className="text-sm">No venture "{slug}".</p>;
  const v = q.data;
  return (
    <article>
      <p className="text-xs"><Link className="underline" to="/ventures">All ventures</Link>{v.parent && <> · part of <Link className="underline" to={`/ventures/${v.parent}`}>{v.parent}</Link></>}</p>
      <h1 className="mt-1 text-xl">{v.name} <span className={chip}>{v.kind}</span></h1>
      {v.summary && <p className="mt-1 text-sm text-[var(--ink-dim)]">{v.summary}</p>}
      <p className="mt-2 text-sm">
        {v.home_path
          ? <>Home: <Link className="underline" to={`/file/${v.home_path}/README.md`}>{v.home_path}</Link></>
          : <span className="text-[var(--ink-dim)]">No home folder set.</span>}
        {v.home_path && (!v.has_readme || !v.has_brand) && (
          <button type="button" className="ml-3 rounded border border-[var(--rule)] px-2 py-0.5 text-xs" disabled={scaffold.isPending} onClick={() => scaffold.mutate()}>
            Create README and brand folder
          </button>
        )}
      </p>
      {v.links.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-3 text-sm">
          {v.links.map((l) => <li key={l.url}><a className="underline" href={l.url} rel="noreferrer" target="_blank">{l.label}</a></li>)}
        </ul>
      )}
      {v.goals.length > 0 && <p className="mt-2 text-sm">Goals: {v.goals.join(', ')}</p>}

      {v.kpis.length > 0 && (
        <section aria-label="KPIs" className="mt-6">
          <h2 className="mb-2 text-sm font-medium">KPIs</h2>
          <table className="text-sm">
            <tbody>
              {v.kpis.map((k) => (
                <tr key={k.key}>
                  <td className="pr-4">{k.label}</td>
                  <td className="pr-4">{k.value === null ? 'no data' : `${k.value.toLocaleString('en-US')} ${k.unit === 'usd' ? 'USD' : k.unit}`}</td>
                  <td className="text-[var(--ink-dim)]">{k.target ? `target ${k.target.toLocaleString('en-US')}` : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section aria-label="Projects" className="mt-6">
        <h2 className="mb-2 text-sm font-medium">Projects</h2>
        {v.projects.length === 0 ? <p className="text-sm text-[var(--ink-dim)]">None linked yet.</p> : (
          <ul className="text-sm">
            {v.projects.map((p) => <li key={p.slug}>{p.title} <span className={chip}>{p.stage}</span></li>)}
          </ul>
        )}
      </section>

      {v.brand ? <Brand brand={v.brand} /> : <p className="mt-6 text-sm text-[var(--ink-dim)]">No brand file yet.</p>}
    </article>
  );
}

function Row({ v, all, depth }: { v: Venture; all: Venture[]; depth: number }) {
  return (
    <>
      <li className="border-b border-[var(--rule)] py-2" style={{ paddingLeft: depth * 20 }}>
        <Link className="underline" to={`/ventures/${v.slug}`}>{v.name}</Link> <span className={chip}>{v.kind}</span>
        {v.projects.length > 0 && <span className="ml-2 text-xs text-[var(--ink-dim)]">{v.projects.length} projects</span>}
        {v.summary && <p className="text-xs text-[var(--ink-dim)]">{v.summary}</p>}
      </li>
      {all.filter((c) => c.parent === v.slug).map((c) => <Row key={c.slug} v={c} all={all} depth={depth + 1} />)}
    </>
  );
}

export default function Ventures() {
  const { slug } = useParams();
  const list = useQuery({ queryKey: ['ventures'], queryFn: api.ventures, retry: false, enabled: !slug });
  return (
    <main className="mx-auto max-w-3xl px-4 py-6">
      {slug ? <Detail slug={slug} /> : (
        <>
          <h1 className="mb-3 text-xl">Ventures</h1>
          {list.isLoading && <p className="text-sm text-[var(--ink-dim)]">Loading…</p>}
          {list.data && list.data.ventures.length === 0 && (
            <p className="text-sm">No ventures yet. Create one with <code>cli-projects venture &lt;slug&gt; --name "…" --home Areas/&lt;folder&gt;</code>.</p>
          )}
          <ul>{(list.data?.ventures ?? []).filter((v) => !v.parent).map((v) => <Row key={v.slug} v={v} all={list.data!.ventures} depth={0} />)}</ul>
        </>
      )}
    </main>
  );
}
