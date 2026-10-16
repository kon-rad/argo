import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import NavMenu from '../src/components/NavMenu.js';

const items = [{ to: '/agents', label: 'Agents' }, { to: '/usage', label: 'Usage' }, { to: '/cron', label: 'Cron' }];
const setup = (path = '/') => render(
  <MemoryRouter initialEntries={[path]}>
    <NavMenu label="Agents" items={items} />
    <Routes><Route path="*" element={<div data-testid="page" />} /></Routes>
  </MemoryRouter>);

afterEach(cleanup);

describe('NavMenu', () => {
  it('opens on click, lists its links, and closes on Escape', () => {
    setup();
    const button = screen.getByRole('button', { name: /agents/i });
    expect(button.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('menuitem', { name: 'Usage' }).getAttribute('href')).toBe('/usage');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menuitem', { name: 'Usage' })).toBeNull();
  });

  it('closes after choosing a link and on a click outside', () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: /agents/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Usage' }));
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /agents/i }));
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('marks the menu active when the current page is one of its links', () => {
    setup('/usage/session/mac/s1');
    expect(screen.getByRole('button', { name: /agents/i }).getAttribute('data-active')).toBe('true');
  });
});
