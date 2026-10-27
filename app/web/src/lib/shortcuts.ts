/**
 * Keyboard shortcuts that jump to a page: Ctrl+Cmd+<letter> on a Mac,
 * Ctrl+Win (Super) on a PC keyboard or the Pi. Chromium reports the Win key as
 * metaKey on Linux, so one check covers both, including the Jelly Comb folding
 * keyboard on the TV Pi. Ctrl+Meta is free in Chrome, macOS and labwc except
 * Q (macOS lock screen), F (full screen), D (look up) and Space (emoji), which
 * no shortcut here uses. Add Shift to open a page's full-screen TV view.
 */
export interface Shortcut {
  /** KeyboardEvent.code, so the shortcut follows the key, not the layout. */
  code: string;
  to: string;
  label: string;
  /** Module the page needs; the shortcut is off when the install lacks it. */
  module?: string;
  /** The page's `?kiosk=1` view, opened with Shift. */
  kiosk?: string;
}

export const SHORTCUTS: Shortcut[] = [
  { code: 'KeyB', to: '/', label: 'Browse' },
  { code: 'KeyT', to: '/tv', label: 'TV', module: 'tv', kiosk: '/tv?kiosk=1' },
  { code: 'KeyA', to: '/agents', label: 'Agents', module: 'agents' },
  { code: 'KeyO', to: '/org', label: 'Org', module: 'org' },
  { code: 'KeyN', to: '/board', label: 'Board', module: 'board' },
  { code: 'KeyL', to: '/org/live', label: 'Org live feed', module: 'org', kiosk: '/org/live?kiosk=1' },
  { code: 'KeyP', to: '/ventures', label: 'Ventures', module: 'projects' },
  { code: 'KeyM', to: '/map', label: 'Brain map', module: 'map', kiosk: '/map?kiosk=1' },
  { code: 'KeyU', to: '/usage', label: 'Usage', module: 'usage' },
  { code: 'KeyG', to: '/media', label: 'Media', module: 'media' },
  { code: 'KeyC', to: '/cron', label: 'Cron', module: 'agents' },
  { code: 'KeyR', to: '/ring', label: 'Ring', module: 'ring' },
  { code: 'KeyV', to: '/vector-search', label: 'Vector search' },
  { code: 'KeyE', to: '/database', label: 'Database' },
  { code: 'KeyS', to: '/sources', label: 'Sources' },
];

/** Opens and closes the shortcuts list. */
export const HELP_CODE = 'Slash';

export function available(modules: Set<string>): Shortcut[] {
  return SHORTCUTS.filter((s) => !s.module || modules.has(s.module));
}

/** Ctrl and Meta held, Alt not: Ctrl+Alt is the Pi's own kiosk keys (sb-tv). */
export function isChord(event: Pick<KeyboardEvent, 'ctrlKey' | 'metaKey' | 'altKey'>): boolean {
  return event.ctrlKey && event.metaKey && !event.altKey;
}

type Press = Pick<KeyboardEvent, 'code' | 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>;

/**
 * Whether a press is this key: by code, or else by the character typed. Synthetic
 * input (wtype on the Pi, some Bluetooth keyboards) can carry a meaningless code.
 */
export function isKey(event: Pick<KeyboardEvent, 'code' | 'key'>, code: string): boolean {
  if (event.code === code) return true;
  const key = (event.key ?? '').toLowerCase();
  return code === HELP_CODE ? key === '/' || key === '?' : key === code.replace(/^Key/, '').toLowerCase();
}

/** Where a key press goes, or null when it is not one of the shortcuts. */
export function target(event: Press, shortcuts: Shortcut[]): string | null {
  if (!isChord(event)) return null;
  const s = shortcuts.find((x) => x.code === event.code) ?? shortcuts.find((x) => isKey(event, x.code));
  if (!s) return null;
  return event.shiftKey && s.kiosk ? s.kiosk : s.to;
}

const isMac = (): boolean => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** "⌃⌘T" on a Mac, "Ctrl+Win+T" elsewhere. */
export function keyLabel(code: string, shift = false): string {
  const key = code === HELP_CODE ? '/' : code.replace(/^Key/, '');
  if (isMac()) return `⌃${shift ? '⇧' : ''}⌘${key}`;
  return `Ctrl+${shift ? 'Shift+' : ''}Win+${key}`;
}
