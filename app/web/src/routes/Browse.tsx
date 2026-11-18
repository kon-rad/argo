import { useLocation } from 'react-router-dom';
import Tree from '../components/Tree.js';
import FileView from '../components/FileView.js';
import FolderView from '../components/FolderView.js';

/** `/file/Areas/work/note.md` → `Areas/work/note.md`. */
function pathFromLocation(pathname: string): string {
  if (!pathname.startsWith('/file/')) return '';
  return pathname
    .slice('/file/'.length)
    .split('/')
    .map((seg) => {
      try {
        return decodeURIComponent(seg);
      } catch {
        return seg;
      }
    })
    .join('/');
}

export default function Browse() {
  const { pathname } = useLocation();
  const path = pathFromLocation(pathname);

  return (
    <div className="flex h-full">
      {/* Phone width: the tree OR the note, never both squeezed side by side.
          The Browse link in the header gets back to the tree. */}
      <aside
        className={`w-full shrink-0 overflow-y-auto border-r border-[var(--rule)] md:block md:w-72 ${path ? 'hidden' : ''}`}
      >
        <Tree selectedPath={path} />
      </aside>
      <section className={`min-w-0 flex-1 overflow-y-auto md:block ${path ? '' : 'hidden'}`}>
        {path ? (
          path.endsWith('/') ? <FolderView key={path} path={path.replace(/\/+$/, '')} /> : <FileView key={path} path={path} />
        ) : (
          <div className="flex h-full items-center justify-center p-8 text-center text-[var(--ink-dim)]">
            <p>
              Pick a note from the tree, or search with <kbd>⌘K</kbd>.
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
