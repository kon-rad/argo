import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, fileHref, type TreeResponse } from '../lib/api.js';
import { useVaultScan } from '../lib/useVaultScan.js';

const PAGE = 200;

interface Props {
  selectedPath: string;
}

export default function Tree({ selectedPath }: Props) {
  const { vault, running, busy, rescan } = useVaultScan();

  return (
    <nav aria-label="Vault tree" data-testid="tree" className="p-2 text-[13px]">
      {vault && (
        <div className="mb-1 flex items-center justify-between px-1 text-[var(--ink-faint)]">
          <span>{running ? 'scanning vault…' : 'Files'}</span>
          {/* The tree reads the index, not the disk: refreshing means rescanning
              the vault, and the open folders refetch when the scan lands. */}
          <button
            type="button"
            disabled={busy}
            onClick={rescan}
            title="Rescan the vault for new files and folders"
            aria-label="Refresh file tree"
            className="rounded px-1.5 py-0.5 hover:bg-[var(--paper-sunk)] hover:text-[var(--ink)] disabled:hover:bg-transparent"
          >
            <span className={busy ? 'inline-block animate-spin' : 'inline-block'}>↻</span>
          </button>
        </div>
      )}
      <Dir path="" depth={0} selectedPath={selectedPath} defaultOpen />
    </nav>
  );
}

interface DirProps {
  path: string;
  depth: number;
  selectedPath: string;
  defaultOpen?: boolean;
}

function Dir({ path, depth, selectedPath, defaultOpen = false }: DirProps) {
  // A directory on the path to the selected file starts open, so a shared
  // /file/... URL lands with its place in the tree already visible.
  const onSelectedPath = path !== '' && selectedPath.startsWith(`${path}/`);
  const [open, setOpen] = useState(defaultOpen || onSelectedPath);
  const [limit, setLimit] = useState(PAGE);

  // Nothing is fetched for a closed directory: that is the whole point of a
  // lazy tree over a vault with 12,000 files in it.
  const { data, isPending, error } = useQuery<TreeResponse>({
    queryKey: ['tree', path, limit],
    queryFn: () => api.tree(path, 0, limit),
    enabled: open,
  });

  const name = path.split('/').pop() ?? '';
  const indent = { paddingLeft: `${depth * 12}px` };

  return (
    <div>
      {path !== '' && (
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          style={indent}
          className="flex w-full items-center gap-1 rounded px-1 py-0.5 text-left hover:bg-[var(--paper-sunk)]"
        >
          <span className="w-3 shrink-0 text-[var(--ink-faint)]">{open ? '▾' : '▸'}</span>
          <span className="truncate">{name}</span>
        </button>
      )}

      {open && (
        <div>
          {isPending && (
            <div style={{ paddingLeft: `${(depth + 1) * 12 + 16}px` }} className="py-0.5 text-[var(--ink-faint)]">
              loading…
            </div>
          )}
          {error && (
            <div style={{ paddingLeft: `${(depth + 1) * 12 + 16}px` }} className="py-0.5 text-red-500">
              {(error as Error).message}
            </div>
          )}
          {data?.dirs.map((dir) => (
            <Dir key={dir.path} path={dir.path} depth={depth + 1} selectedPath={selectedPath} />
          ))}
          {data?.files.map((file) => (
            <Link
              key={file.path}
              to={fileHref(file.path)}
              style={{ paddingLeft: `${(depth + 1) * 12 + 16}px` }}
              className={`block truncate rounded py-0.5 pr-1 hover:bg-[var(--paper-sunk)] ${
                file.path === selectedPath
                  ? 'bg-[var(--paper-sunk)] font-medium text-[var(--ink)]'
                  : 'text-[var(--ink-dim)]'
              }`}
              title={file.path}
            >
              {file.name}
            </Link>
          ))}
          {data?.has_more && (
            <button
              type="button"
              onClick={() => setLimit((l) => l + PAGE)}
              style={{ paddingLeft: `${(depth + 1) * 12 + 16}px` }}
              className="block w-full py-0.5 text-left text-[var(--accent)] hover:underline"
            >
              show more ({data.total - data.files.length} left)
            </button>
          )}
        </div>
      )}
    </div>
  );
}
