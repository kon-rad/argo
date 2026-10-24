import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { useCallback, useState } from 'react';
import MobileMenu, { MenuButton } from '../src/components/MobileMenu.js';
import type { NavItem } from '../src/components/NavMenu.js';

const SECTIONS: [string, NavItem[]][] = [
  ['Vault', [{ to: '/', label: 'Browse', end: true }, { to: '/database', label: 'Database' }]],
  ['Work', [{ to: '/projects', label: 'Projects' }, { to: '/agents', label: 'Agents' }]],
];

function Harness({ onLogout }: { onLogout?: () => void }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const where = useLocation();
  return (
    <>
      <MenuButton open={open} onToggle={() => setOpen((o) => !o)} controls="m" />
      <MobileMenu
        id="m"
        open={open}
        onClose={close}
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
    for (const label of ['Browse', 'Database', 'Projects', 'Agents']) expect(screen.getByRole('link', { name: label })).toBeTruthy();
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
