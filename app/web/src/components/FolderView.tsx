import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, fileHref, type TreeResponse } from '../lib/api.js';

/** A vault folder opened from a link (`/file/Areas/x/kit/`): its subfolders and files, one level. */
export default function FolderView({ path }: { path: string }) {
  const { data, isPending, error } = useQuery<TreeResponse>({
    queryKey: ['tree', path, 'folder-view'],
    queryFn: () => api.tree(path, 0, 500),
  });
  if (isPending) return <p className="p-6 text-[var(--ink-dim)]">loading…</p>;
  if (error) return <p className="p-6 text-red-500">{(error as Error).message}</p>;
  const empty = data.dirs.length === 0 && data.files.length === 0;
  return (
    <div className="p-6 text-sm">
      <h1 className="mb-3 break-all text-lg font-semibold">{path}/</h1>
      {empty && <p className="text-[var(--ink-dim)]">Nothing is indexed in this folder.</p>}
      <ul className="space-y-1">
        {data.dirs.map((d) => (
          <li key={d.path}>
            <Link className="text-[var(--accent)] hover:underline" to={fileHref(`${d.path}/`)}>{d.name}/</Link>
            <span className="ml-2 text-xs text-[var(--ink-faint)]">{d.child_count} files</span>
          </li>
        ))}
        {data.files.map((f) => (
          <li key={f.path}><Link className="text-[var(--accent)] hover:underline" to={fileHref(f.path)}>{f.name}</Link></li>
        ))}
      </ul>
      {data.has_more && <p className="mt-2 text-xs text-[var(--ink-faint)]">First 500 files shown.</p>}
    </div>
  );
}
