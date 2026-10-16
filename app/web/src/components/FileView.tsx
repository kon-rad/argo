import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { remarkWikilink } from '../lib/wikilink.js';
import Editor from './Editor.js';
import ListenButton from './ListenButton.js';
import {
  api,
  b2Url,
  downloadUrl,
  EDITABLE_EXTS,
  fileHref,
  formatBytes,
  rawUrl,
  type FileResponse,
  type OutLink,
} from '../lib/api.js';

const IMAGE = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg', '.bmp', '.ico']);
const VIDEO = new Set(['.mp4', '.mov', '.webm', '.mkv']);
const AUDIO = new Set(['.mp3', '.wav', '.m4a', '.ogg', '.flac']);

interface Props {
  path: string;
}

export default function FileView({ path }: Props) {
  const { data, isPending, error } = useQuery<FileResponse>({
    queryKey: ['file', path],
    queryFn: () => api.file(path),
  });
  const [editing, setEditing] = useState(false);
  useEffect(() => setEditing(false), [path]);

  if (isPending) return <Centered>loading…</Centered>;
  if (error) return <Centered tone="error">{(error as Error).message}</Centered>;

  const { file, frontmatter, tags, links, backlinks } = data;
  const b2Path = typeof frontmatter['b2_path'] === 'string' ? frontmatter['b2_path'] : null;

  return (
    <article className="mx-auto max-w-3xl px-4 py-6 md:px-6">
      <header className="mb-5 border-b border-[var(--rule)] pb-3">
        <h1 className="text-xl font-semibold tracking-tight">{file.title ?? file.name}</h1>
        <p className="mt-1 font-mono text-xs text-[var(--ink-faint)]">{file.path}</p>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--ink-dim)]">
          <span>
            {formatBytes(file.size_bytes)} · modified {new Date(file.mtime).toLocaleString()}
          </span>
          <a href={downloadUrl(file.path)} download={file.name} className="text-[var(--accent)] hover:underline">
            Download
          </a>
          {EDITABLE_EXTS.has(file.ext) && !editing && (
            <button type="button" onClick={() => setEditing(true)} className="text-[var(--accent)] hover:underline">
              Edit
            </button>
          )}
          {file.is_markdown && !editing && <ListenButton path={file.path} />}
        </div>
        {tags.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {tags.map((tag) => (
              <Link
                key={tag}
                to={`/search?q=${encodeURIComponent(tag)}`}
                className="rounded-full border border-[var(--rule)] bg-[var(--paper-sunk)] px-2 py-0.5 text-xs text-[var(--ink-dim)] hover:text-[var(--ink)]"
              >
                #{tag}
              </Link>
            ))}
          </div>
        )}
      </header>

      {b2Path && !editing && <B2Media stubPath={file.path} b2Path={b2Path} />}

      {editing ? (
        <Editor path={file.path} onDone={() => setEditing(false)} />
      ) : file.is_markdown && file.body !== null ? (
        <Markdown body={file.body} dir={file.parent_path} links={links} />
      ) : (
        <Preview path={file.path} ext={file.ext} />
      )}

      {Object.keys(frontmatter).length > 0 && <Frontmatter data={frontmatter} />}

      {backlinks.length > 0 && (
        <section className="mt-8 border-t border-[var(--rule)] pt-4">
          <h2 className="mb-2 text-xs font-semibold tracking-wide text-[var(--ink-dim)] uppercase">
            Linked from ({backlinks.length})
          </h2>
          <ul className="space-y-1">
            {backlinks.map((back) => (
              <li key={back.id}>
                <Link to={fileHref(back.path)} className="text-[var(--accent)] hover:underline">
                  {back.title ?? back.path}
                </Link>
                <span className="ml-2 font-mono text-xs text-[var(--ink-faint)]">{back.path}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </article>
  );
}

function Markdown({ body, dir, links }: { body: string; dir: string; links: OutLink[] }) {
  const byTarget = useMemo(() => {
    const map = new Map<string, OutLink>();
    for (const link of links) map.set(link.target_raw.trim().toLowerCase(), link);
    return map;
  }, [links]);

  return (
    <div className="prose">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkWikilink]}
        // The default transform drops any unknown protocol, which would erase
        // every wikilink before it reached the renderer. Everything else keeps
        // the default's javascript: protection.
        urlTransform={(url) => (url.startsWith('wikilink:') ? url : defaultUrlTransform(url))}
        components={{
          a({ href, children }) {
            if (!href?.startsWith('wikilink:')) {
              return (
                <a href={href} target="_blank" rel="noreferrer">
                  {children}
                </a>
              );
            }
            // mdast-to-hast percent-encodes the url, so `[[PARA Guide]]`
            // arrives as `wikilink:PARA%20Guide` and has to be decoded before
            // it can be matched against the target_raw the scanner stored.
            const target = decodeTarget(href.slice('wikilink:'.length));
            const resolved = byTarget.get(target.trim().toLowerCase());
            if (resolved?.path) return <Link to={fileHref(resolved.path)}>{children}</Link>;
            // A dead link renders as a visible gap, never as navigation that
            // quietly goes somewhere plausible but wrong.
            return (
              <span className="wikilink-dead" title={`No note in the vault matches “${target}”`}>
                {children}
              </span>
            );
          },
          img({ src, alt }) {
            return <img src={resolveAsset(src, dir)} alt={alt ?? ''} loading="lazy" />;
          },
        }}
      >
        {body}
      </ReactMarkdown>
    </div>
  );
}

function decodeTarget(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** Relative image sources are vault paths; absolute URLs are left alone. */
function resolveAsset(src: unknown, dir: string): string {
  if (typeof src !== 'string' || src === '') return '';
  if (/^(https?:|data:|blob:)/.test(src)) return src;
  const clean = src.replace(/^\.\//, '');
  return rawUrl(clean.startsWith('/') ? clean.slice(1) : dir ? `${dir}/${clean}` : clean);
}

function Preview({ path, ext }: { path: string; ext: string }) {
  const src = rawUrl(path);
  if (IMAGE.has(ext)) return <img src={src} alt={path} className="max-w-full rounded" />;
  if (VIDEO.has(ext)) return <video src={src} controls className="max-w-full rounded" />;
  if (AUDIO.has(ext)) return <audio src={src} controls className="w-full" />;
  if (ext === '.pdf') return <iframe src={src} title={path} className="h-[75vh] w-full rounded border border-[var(--rule)]" />;
  return (
    <p className="text-[var(--ink-dim)]">
      No inline preview for <code>{ext || 'this file'}</code>.{' '}
      <a href={src} className="text-[var(--accent)] hover:underline">
        Open it raw
      </a>
      .
    </p>
  );
}

/** A stub for a big file kept in Backblaze B2: play it, or download the original. */
function B2Media({ stubPath, b2Path }: { stubPath: string; b2Path: string }) {
  const ext = b2Path.slice(b2Path.lastIndexOf('.')).toLowerCase();
  const src = b2Url(stubPath);
  const name = b2Path.split('/').pop() ?? b2Path;
  return (
    <section className="mb-6 rounded border border-[var(--rule)] bg-[var(--paper-sunk)] p-3">
      {VIDEO.has(ext) && <video src={src} controls preload="metadata" className="mb-2 max-w-full rounded" />}
      {AUDIO.has(ext) && <audio src={src} controls preload="metadata" className="mb-2 w-full" />}
      {IMAGE.has(ext) && <img src={src} alt={name} className="mb-2 max-w-full rounded" />}
      <div className="flex flex-wrap items-center gap-x-3 text-xs text-[var(--ink-dim)]">
        <span className="font-mono">{name}</span>
        <a href={b2Url(stubPath, true)} download={name} className="text-[var(--accent)] hover:underline">
          Download original
        </a>
      </div>
    </section>
  );
}

function Frontmatter({ data }: { data: Record<string, unknown> }) {
  return (
    <section className="mt-8 border-t border-[var(--rule)] pt-4">
      <h2 className="mb-2 text-xs font-semibold tracking-wide text-[var(--ink-dim)] uppercase">
        Frontmatter
      </h2>
      <table className="text-xs">
        <tbody>
          {Object.entries(data).map(([key, value]) => (
            <tr key={key} className="align-top">
              <th className="py-1 pr-4 text-left font-medium text-[var(--ink-dim)]">{key}</th>
              <td className="py-1 font-mono break-all">
                {typeof value === 'string' ? value : JSON.stringify(value)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function Centered({ children, tone }: { children: React.ReactNode; tone?: 'error' }) {
  return (
    <div className={`p-6 ${tone === 'error' ? 'text-red-500' : 'text-[var(--ink-dim)]'}`}>
      {children}
    </div>
  );
}
