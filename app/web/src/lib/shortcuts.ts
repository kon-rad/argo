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
  { code: 'KeyP', to: '/projects', label: 'Projects', module: 'projects' },
  { code: 'KeyM', to: '/map', label: 'Brain map', module: 'map', kiosk: '/map?kiosk=1' },
  { code: 'KeyU', to: '/usage', label: 'Usage', module: 'usage' },
  { code: 'KeyG', to: '/media', label: 'Media', module: 'media' },
  { code: 'KeyC', to: '/cron', label: 'Cron', module: 'agents' },
  { code: 'KeyR', to: '/ring', label: 'Ring', module: 'ring' },
  { code: 'KeyV', to: '/vector-search', label: 'Vector search' },
  { code: 'KeyE', to: '/database', label: 'Database' },
  { code: 'KeyS', to: '/sources', label: 'Sources' },
];

/**
 * "Go to" sequences: press `g`, let go, then the letter, with no modifier held. They exist
 * for the pages whose letter the chord already gave to another page (Ctrl+Cmd+A is Agents,
 * so areas are `g a`). Ignored while typing in a field.
 */
export interface GoShortcut {
  /** The letter typed after `g`. */
  key: string;
  to: string;
  label: string;
  module?: string;
}

export const GO_SHORTCUTS: GoShortcut[] = [
  { key: 'a', to: '/areas', label: 'Areas', module: 'projects' },
  { key: 'p', to: '/projects', label: 'Projects', module: 'projects' },
];

/** How long after `g` the second key still counts. */
export const GO_WINDOW_MS = 1500;

export function availableGo(modules: Set<string>): GoShortcut[] {
  return GO_SHORTCUTS.filter((s) => !s.module || modules.has(s.module));
}

type Plain = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey'> & { target?: EventTarget | null };

/** A key typed into a field, a select or an editor is text, never a shortcut. */
export function isTyping(target: EventTarget | null | undefined): boolean {
  const el = target as (Partial<HTMLElement> & { tagName?: string }) | null | undefined;
  if (!el || typeof el.tagName !== 'string') return false;
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || el.isContentEditable === true || el.getAttribute?.('contenteditable') === 'true';
}

/**
 * One step of a `g <letter>` sequence. `armedAt` is when `g` was last pressed (null when
 * it was not). Returns the page to open, or whether this press arms the sequence.
 */
export function goStep(event: Plain, armedAt: number | null, now: number, shortcuts: GoShortcut[]): { to: string | null; armedAt: number | null } {
  if (event.ctrlKey || event.metaKey || event.altKey || isTyping(event.target)) return { to: null, armedAt: null };
  const key = (event.key ?? '').toLowerCase();
  if (armedAt !== null && now - armedAt <= GO_WINDOW_MS) {
    const s = shortcuts.find((x) => x.key === key);
    if (s) return { to: s.to, armedAt: null };
  }
  return { to: null, armedAt: key === 'g' ? now : null };
}

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
