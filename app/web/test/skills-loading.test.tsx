import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Routes } from 'react-router-dom';

const moduleGate = vi.hoisted(() => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  return { pending, release };
});
vi.mock('../src/routes/skills/Skills.js', async () => {
  await moduleGate.pending;
  return { default: () => <p>Skills module loaded</p> };
});
import { FEATURE_ROUTES } from '../src/features.js';

afterEach(cleanup);
it('shows an accessible loading state while the actual Skills route module is delayed', async () => {
  render(<MemoryRouter initialEntries={['/skills']}><Routes>{FEATURE_ROUTES.skills}</Routes></MemoryRouter>);
  expect(screen.getByRole('status').textContent).toMatch(/Loading skills/);
  expect(screen.queryByText('Skills module loaded')).toBeNull();
  await act(async () => { moduleGate.release(); });
  expect(await screen.findByText('Skills module loaded')).toBeTruthy();
  expect(screen.queryByRole('status')).toBeNull();
});
