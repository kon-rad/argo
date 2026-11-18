import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { useCallback, useRef, useState } from 'react';
import MobileMenu, { MenuButton } from '../src/components/MobileMenu.js';
import { currentItem, type NavItem } from '../src/components/NavMenu.js';

const SECTIONS: [string, NavItem[]][] = [
  ['Vault', [{ to: '/', label: 'Browse', end: true, also: ['/file/*'] }, { to: '/database', label: 'Database' }]],
  ['Work', [{ to: '/projects', label: 'Projects' }, { to: '/agents', label: 'Agents' }]],
  ['Docs', [{ to: '/file/docs', label: 'Docs' }]],
];

function Harness({ onLogout }: { onLogout?: () => void }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const where = useLocation();
  const button = useRef<HTMLButtonElement>(null);
  return (
    <>
      <MenuButton ref={button} open={open} onToggle={() => setOpen((o) => !o)} controls="m" />
      <MobileMenu
        id="m"
        open={open}
        onClose={close}
        opener={button}
        sections={SECTIONS}
        search={<input aria-label="Search the vault" />}
        footer={onLogout ? <button type="button" onClick={onLogout}>Log out</button> : null}
      />
      <div data-testid="where">{where.pathname}</div>
      <Routes><Route path="*" element={null} /></Routes>
    </>
  );
}

const mount = (path = '/projects', onLogout?: () => void) =>
  render(<MemoryRouter initialEntries={[path]}><Harness onLogout={onLogout} /></MemoryRouter>);

afterEach(cleanup);

describe('MobileMenu', () => {
  it('is closed until the menu button is pressed, then lists every section with the current page marked', () => {
    mount('/projects');
    expect(screen.queryByRole('navigation')).toBeNull();
    const button = screen.getByRole('button', { name: 'Menu' });
    expect(button.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    const nav = screen.getByRole('navigation');
    expect(nav.textContent).toContain('Vault');
    expect(nav.textContent).toContain('Work');
    for (const label of ['Browse', 'Database', 'Projects', 'Agents', 'Docs']) expect(screen.getByRole('link', { name: label })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Projects' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('link', { name: 'Agents' }).getAttribute('aria-current')).toBeNull();
    expect(screen.getByLabelText('Search the vault')).toBeTruthy();
  });

  it('closes on a link, on Escape and on the backdrop', () => {
    mount('/projects');
    const open = () => fireEvent.click(screen.getByRole('button', { name: 'Menu' }));
    open();
    fireEvent.click(screen.getByRole('link', { name: 'Database' }));
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(screen.getByTestId('where').textContent).toBe('/database');
    open();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('navigation')).toBeNull();
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Close menu' }));
    expect(screen.queryByRole('navigation')).toBeNull();
    open();
    fireEvent.click(screen.getByTestId('menu-backdrop'));
    expect(screen.queryByRole('navigation')).toBeNull();
  });

  it('is a labelled modal dialog the menu button points at', () => {
    mount('/projects');
    const button = screen.getByRole('button', { name: 'Menu' });
    fireEvent.click(button);
    const dialog = screen.getByRole('dialog', { name: 'Menu' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(button.getAttribute('aria-controls')).toBe(dialog.id);
    expect(dialog.contains(screen.getByRole('navigation', { name: 'Sections' }))).toBe(true);
    // Each section is a labelled list, so a screen reader announces "Work, list, 2 items".
    expect(screen.getByRole('list', { name: 'Work' }).querySelectorAll('li').length).toBe(2);
  });

  it('moves focus into the menu when it opens and back to the menu button when it closes', () => {
    mount('/projects');
    const button = screen.getByRole('button', { name: 'Menu' });
    button.focus();
    fireEvent.click(button);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close menu' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.activeElement).toBe(button);
  });

  it('keeps Tab inside the menu, wrapping at both ends', () => {
    const out = vi.fn();
    mount('/projects', out);
    fireEvent.click(screen.getByRole('button', { name: 'Menu' }));
    const first = screen.getByRole('button', { name: 'Close menu' });
    const last = screen.getByRole('button', { name: 'Log out' });
    last.focus();
    expect(fireEvent.keyDown(document, { key: 'Tab' })).toBe(false); // prevented: the menu moved focus itself
    expect(document.activeElement).toBe(first);
    expect(fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })).toBe(false);
    expect(document.activeElement).toBe(last);
    // In the middle the browser's own Tab order is left alone.
    screen.getByRole('link', { name: 'Projects' }).focus();
    expect(fireEvent.keyDown(document, { key: 'Tab' })).toBe(true);
  });

  it('marks one current page: a note counts as Browse, a note under a Docs folder as Docs', () => {
    mount('/file/Areas/note.md');
    fireEvent.click(screen.getByRole('button', { name: 'Menu' }));
    expect(screen.getByRole('link', { name: 'Browse' }).getAttribute('aria-current')).toBe('page');
    cleanup();
    mount('/file/docs/setup.md');
    fireEvent.click(screen.getByRole('button', { name: 'Menu' }));
    expect(screen.getByRole('link', { name: 'Docs' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('link', { name: 'Browse' }).getAttribute('aria-current')).toBeNull();
  });
});

describe('currentItem', () => {
  it('finds the page a path is on, and nothing for a page with no link', () => {
    expect(currentItem(SECTIONS, '/')?.label).toBe('Browse');
    expect(currentItem(SECTIONS, '/projects')?.label).toBe('Projects');
    expect(currentItem(SECTIONS, '/agents/history')?.label).toBe('Agents');
    expect(currentItem(SECTIONS, '/file/a/b.md')?.label).toBe('Browse');
    expect(currentItem(SECTIONS, '/file/docs/a.md')?.label).toBe('Docs');
    expect(currentItem(SECTIONS, '/search')).toBeUndefined();
  });

  it('stops the page behind from scrolling while open, and restores it', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Menu' }));
    expect(document.body.style.overflow).toBe('hidden');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.body.style.overflow).toBe('');
  });

  it('shows the footer (status chips, log out)', () => {
    const out = vi.fn();
    mount('/', out);
    fireEvent.click(screen.getByRole('button', { name: 'Menu' }));
    fireEvent.click(screen.getByRole('button', { name: 'Log out' }));
    expect(out).toHaveBeenCalled();
  });
});
