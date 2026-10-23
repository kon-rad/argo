import { useEffect, useId, useRef } from 'react';
import { HELP_CODE, keyLabel, type Shortcut } from '../lib/shortcuts.js';
import type { AppMeta } from '../lib/api.js';

/** The ⓘ button at the right of the header and the list of keyboard shortcuts it opens. */
export default function ShortcutsHelp({ shortcuts, open, onOpenChange, build }: {
  shortcuts: Shortcut[];
  open: boolean;
  onOpenChange(open: boolean): void;
  /** Version and commit of the running app, from /api/meta. */
  build?: Pick<AppMeta, 'version' | 'commit' | 'commitShort' | 'builtAt'>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onOpenChange(false); };
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onOpenChange(false); };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [open, onOpenChange]);

  const rows: [string, string][] = [
    ...shortcuts.map((s): [string, string] => [keyLabel(s.code), s.label]),
    ...shortcuts.filter((s) => s.kiosk).map((s): [string, string] => [keyLabel(s.code, true), `${s.label}, full screen`]),
    ['⌘K / Ctrl+K', 'Search'],
    [keyLabel(HELP_CODE), 'This list'],
  ];

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-label="Keyboard shortcuts"
        title="Keyboard shortcuts"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => onOpenChange(!open)}
        className="flex h-6 w-6 items-center justify-center rounded-full border border-[var(--rule)] text-xs text-[var(--ink-dim)] hover:text-[var(--ink)]"
      >
        i
      </button>
      {open && (
        <div id={panelId} role="dialog" aria-label="Keyboard shortcuts"
          className="absolute right-0 z-50 mt-2 w-72 rounded border border-[var(--rule)] bg-[var(--paper)] p-3 text-sm shadow-lg">
          <p className="mb-2 font-semibold">Keyboard shortcuts</p>
          <table className="w-full">
            <tbody>
              {rows.map(([keys, label]) => (
                <tr key={keys}>
                  <td className="py-0.5 pr-3 whitespace-nowrap"><kbd className="font-mono text-xs">{keys}</kbd></td>
                  <td className="py-0.5 text-[var(--ink-dim)]">{label}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-xs text-[var(--ink-dim)]">On a PC or Jelly Comb keyboard, Win is the ⌘ key.</p>
          {build?.version && (
            <p
              className="mt-2 border-t border-[var(--rule)] pt-1.5 text-xs text-[var(--ink-dim)]"
              title={[
                build.commit ? `commit ${build.commit}` : null,
                build.builtAt ? `built ${new Date(build.builtAt).toLocaleString()}` : null,
              ].filter(Boolean).join(' · ') || undefined}
            >
              Second Brain v{build.version}
              {build.commitShort ? ` · ${build.commitShort}` : ''}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
