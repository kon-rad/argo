import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { fileHref } from '../lib/api.js';
import FileView from './FileView.js';

/**
 * A vault file in a dismissable modal: Esc, the backdrop and the close button
 * all close it; the body scrolls inside, so it works at 390 px wide. "Open"
 * goes to the full page.
 */
export function PreviewModal({ path, onClose }: { path: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-2 md:p-6"
      onClick={onClose}
      data-testid="preview-backdrop"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Preview of ${path}`}
        className="flex max-h-full w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-[var(--rule)] bg-[var(--paper)] shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-[var(--rule)] px-3 py-2 text-xs">
          <span className="min-w-0 flex-1 truncate font-mono text-[var(--ink-dim)]">{path}</span>
          <Link to={fileHref(path)} onClick={onClose} className="text-[var(--accent)] hover:underline">
            Open
          </Link>
          <button type="button" onClick={onClose} aria-label="Close preview" className="px-1 text-base leading-none text-[var(--ink-dim)] hover:text-[var(--ink)]">
            ×
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <FileView path={path} />
        </div>
      </div>
    </div>
  );
}
