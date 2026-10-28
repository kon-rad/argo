import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { formatBytes } from '../lib/api.js';
import {
  errorText,
  isAbort,
  uploadFile,
  uploadsApi,
  type UploadDestination,
  type UploadProgress,
  type UploadRecord,
} from '../lib/uploads.js';

/**
 * Uploads: send a file of a gigabyte or more from any browser. It goes to the bucket in resumable chunks, then the
 * server files it under the vault folder chosen here and leaves a `.b2.md` stub there; "Copy to the editing machine" also queues
 * a working copy for video editing. Design: docs/uploads.md.
 */

interface Local {
  key: string;
  file: File;
  progress: UploadProgress | null;
  error: string | null;
  controller: AbortController;
  record: UploadRecord | null;
}

const STATUS_LABEL: Record<UploadRecord['status'], string> = {
  uploading: 'Uploading',
  uploaded: 'Uploaded, filing into the vault',
  ingesting: 'Filing into the vault',
  stored: 'Stored',
  failed: 'Failed',
  aborted: 'Cancelled',
};

const M1_LABEL: Record<NonNullable<UploadRecord['m1_status']>, string> = {
  pending: 'Waiting for the editing machine',
  pulling: 'Copying to the editing machine',
  done: 'On the editing machine',
  failed: 'Editing-machine copy failed',
};

const inputCls = 'w-full rounded border border-[var(--rule)] bg-transparent px-2 py-1 text-sm';

function Bar({ value }: { value: number }) {
  return (
    <div className="h-2 w-full overflow-hidden rounded bg-[var(--paper-sunk)]" role="progressbar" aria-valuenow={Math.round(value * 100)}>
      <div className="h-full bg-[var(--ink)]" style={{ width: `${Math.min(100, value * 100)}%` }} />
    </div>
  );
}

export default function Uploads() {
  const qc = useQueryClient();
  const config = useQuery({ queryKey: ['uploads-config'], queryFn: uploadsApi.config });
  const destinations: UploadDestination[] = config.data?.destinations ?? [];
  const list = useQuery({
    queryKey: ['uploads'],
    queryFn: uploadsApi.list,
    refetchInterval: (q) =>
      q.state.data?.uploads.some((u) => ['uploading', 'uploaded', 'ingesting'].includes(u.status) || ['pending', 'pulling'].includes(u.m1_status ?? ''))
        ? 4000
        : false,
  });

  const [files, setFiles] = useState<File[]>([]);
  const [destDir, setDestDir] = useState('');
  const [touchedDest, setTouchedDest] = useState(false);
  const [description, setDescription] = useState('');
  const [tags, setTags] = useState('');
  const [toM1, setToM1] = useState(false);
  const [local, setLocal] = useState<Local[]>([]);
  const [drag, setDrag] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);

  // Pre-select a preset folder from the file names and the description until the user picks one.
  const hint = `${files.map((f) => f.name).join(' ')} ${description}`.trim();
  useEffect(() => {
    if (touchedDest || !hint) return;
    const t = setTimeout(() => {
      void uploadsApi.suggest(hint).then((r) => {
        if (r.destination) setDestDir(r.destination.path);
      }, () => {});
    }, 250);
    return () => clearTimeout(t);
  }, [hint, touchedDest]);

  const tooBig = useMemo(() => files.find((f) => config.data && f.size > config.data.maxBytes), [files, config.data]);
  const ready = files.length > 0 && destDir.trim() !== '' && !tooBig;

  function start(): void {
    const meta = { destDir: destDir.trim(), description: description.trim(), tags: tags.split(',').map((t) => t.trim()).filter(Boolean), toM1 };
    const batch: Local[] = files.map((file) => ({
      key: `${file.name}:${file.size}:${Date.now()}:${Math.random()}`,
      file,
      progress: null,
      error: null,
      controller: new AbortController(),
      record: null,
    }));
    setLocal((cur) => [...batch, ...cur]);
    setFiles([]);
    const patch = (key: string, p: Partial<Local>): void => setLocal((cur) => cur.map((l) => (l.key === key ? { ...l, ...p } : l)));
    // Files go one after another: four parts at a time already fills a typical uplink.
    void (async () => {
      for (const item of batch) {
        try {
          const record = await uploadFile(item.file, meta, (progress) => patch(item.key, { progress }), item.controller.signal);
          patch(item.key, { record });
        } catch (err) {
          patch(item.key, { error: isAbort(err) ? 'Cancelled' : errorText(err) });
        }
        void qc.invalidateQueries({ queryKey: ['uploads'] });
      }
    })();
  }

  async function act(fn: () => Promise<unknown>): Promise<void> {
    setNote(null);
    await fn().catch((err: unknown) => setNote(errorText(err)));
    void qc.invalidateQueries({ queryKey: ['uploads'] });
  }

  const liveIds = new Set(local.filter((l) => !l.error && l.progress).map((l) => l.progress!.id));
  const history = (list.data?.uploads ?? []).filter((u) => !liveIds.has(u.id) || u.status !== 'uploading');

  return (
    <div className="mx-auto h-full max-w-4xl overflow-y-auto p-4">
      <h1 className="mb-1 text-xl font-semibold">Uploads</h1>
      <p className="mb-4 text-sm text-[var(--ink-dim)]">
        Big files from any browser, {config.data ? `up to ${formatBytes(config.data.maxBytes)} each` : ''}. They go straight to Backblaze B2 in resumable
        chunks, so a dropped connection picks up where it stopped.
      </p>

      {config.isError && <div className="mb-4 text-[var(--ink-dim)]">Uploads are unavailable: {errorText(config.error)}</div>}

      <div
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); setFiles([...e.dataTransfer.files]); }}
        className={`mb-3 flex cursor-pointer flex-col items-center justify-center rounded border-2 border-dashed px-4 py-8 text-center ${drag ? 'border-[var(--ink)]' : 'border-[var(--rule)]'}`}
        onClick={() => picker.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') picker.current?.click(); }}
      >
        <input ref={picker} type="file" multiple hidden aria-label="Choose files" onChange={(e) => setFiles([...(e.target.files ?? [])])} />
        {files.length === 0 ? (
          <span>Drop files here or tap to choose</span>
        ) : (
          <ul className="text-sm">
            {files.map((f) => (
              <li key={f.name + f.size}>{f.name} <span className="text-[var(--ink-dim)]">{formatBytes(f.size)}</span></li>
            ))}
          </ul>
        )}
      </div>
      {tooBig && <div className="mb-3 text-sm text-red-600">{tooBig.name} is over the limit of {formatBytes(config.data!.maxBytes)}.</div>}

      <div className="mb-3 grid gap-3 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="mb-1 block text-[var(--ink-dim)]">Vault folder</span>
          <input
            list="upload-dests"
            value={destDir}
            onChange={(e) => { setDestDir(e.target.value); setTouchedDest(true); }}
            placeholder="Areas/alex/vlogs"
            className={inputCls}
          />
          <datalist id="upload-dests">
            {destinations.map((d) => (<option key={d.path} value={d.path}>{d.label}</option>))}
          </datalist>
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-[var(--ink-dim)]">Tags (comma separated)</span>
          <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="vlog, tokyo" className={inputCls} />
        </label>
      </div>
      {destinations.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-1">
          {destinations.map((d) => (
            <button
              key={d.path}
              type="button"
              onClick={() => { setDestDir(d.path); setTouchedDest(true); }}
              className={`rounded border px-2 py-0.5 text-xs ${destDir === d.path ? 'border-[var(--ink)]' : 'border-[var(--rule)] text-[var(--ink-dim)]'}`}
              title={d.path}
            >
              {d.label}
            </button>
          ))}
        </div>
      )}
      <label className="mb-3 block text-sm">
        <span className="mb-1 block text-[var(--ink-dim)]">Description (saved in the note next to the file; also picks the folder)</span>
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} className={inputCls} placeholder="Tokyo vlog, day 3, raw footage" />
      </label>
      <label className="mb-4 flex items-center gap-2 text-sm">
        <input type="checkbox" checked={toM1} onChange={(e) => setToM1(e.target.checked)} />
        Also copy to my editing machine
      </label>
      <button
        type="button"
        disabled={!ready}
        onClick={start}
        className="mb-8 rounded border border-[var(--ink)] px-4 py-1.5 text-sm disabled:opacity-40"
      >
        Upload {files.length > 1 ? `${files.length} files` : files.length === 1 ? 'file' : ''}
      </button>

      {local.some((l) => !l.record) && (
        <section className="mb-6" aria-label="In progress">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-[var(--ink-dim)]">In progress</h2>
          {local.filter((l) => !l.record).map((l) => (
            <div key={l.key} className="mb-3 rounded border border-[var(--rule)] p-3">
              <div className="mb-1 flex items-center justify-between gap-2 text-sm">
                <span className="truncate">{l.file.name}</span>
                {!l.error && <button type="button" className="text-xs text-[var(--ink-dim)] underline" onClick={() => l.controller.abort()}>Cancel</button>}
              </div>
              {l.error ? (
                <div className="text-sm text-red-600">{l.error}. Choose the file again to resume.</div>
              ) : (
                <>
                  <Bar value={l.progress ? l.progress.sentBytes / l.progress.totalBytes : 0} />
                  <div className="mt-1 text-xs text-[var(--ink-dim)]">
                    {l.progress ? `${formatBytes(l.progress.sentBytes)} of ${formatBytes(l.progress.totalBytes)} · part ${l.progress.partsDone}/${l.progress.partCount}` : 'Starting…'}
                  </div>
                </>
              )}
            </div>
          ))}
        </section>
      )}

      {note && <div className="mb-3 text-sm text-red-600" role="alert">{note}</div>}
      <section aria-label="History">
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-[var(--ink-dim)]">Recent uploads</h2>
        {list.data && history.length === 0 && <div className="text-sm text-[var(--ink-dim)]">Nothing uploaded yet.</div>}
        {history.map((u) => (
          <div key={u.id} className="mb-2 rounded border border-[var(--rule)] p-3 text-sm">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="truncate font-medium">{u.filename}</span>
              <span className="text-xs text-[var(--ink-dim)]">{formatBytes(u.size_bytes)} · {new Date(u.created_at).toLocaleString()}</span>
            </div>
            <div className="text-xs text-[var(--ink-dim)]">
              {STATUS_LABEL[u.status]}
              {u.m1_status ? ` · ${M1_LABEL[u.m1_status]}` : ''}
              {' · '}
              {u.stub_path ? <Link className="underline" to={`/file/${u.stub_path}`}>{u.b2_path}</Link> : u.dest_dir}
            </div>
            {u.error && <div className="text-xs text-red-600">{u.error}</div>}
            {u.m1_error && <div className="text-xs text-red-600">{u.m1_error}</div>}
            <div className="mt-1 flex gap-3 text-xs">
              {u.status === 'failed' && <button type="button" className="underline" onClick={() => void act(() => uploadsApi.retry(u.id))}>Retry filing</button>}
              {u.status === 'uploading' && <button type="button" className="underline" onClick={() => void act(() => uploadsApi.abort(u.id))}>Discard</button>}
              {(u.status === 'stored' || u.status === 'uploaded' || u.status === 'ingesting') && (!u.to_m1 || u.m1_status === 'failed') && (
                <button type="button" className="underline" onClick={() => void act(() => uploadsApi.toM1(u.id))}>Copy to the editing machine</button>
              )}
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}
