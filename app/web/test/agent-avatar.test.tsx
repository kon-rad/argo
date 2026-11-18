import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AgentAvatar } from '../src/components/AgentAvatar.js';

afterEach(cleanup);

describe('AgentAvatar', () => {
  it('asks the org API for the portrait and falls back to the initial when it fails', () => {
    render(<AgentAvatar name="rune" team="platform" size={32} />);
    const img = screen.getByTestId('agent-avatar') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('/api/org/avatar/rune');
    expect(img.getAttribute('width')).toBe('32');
    fireEvent.error(img);
    expect(screen.queryByTestId('agent-avatar')).toBeNull();
    expect(screen.getByTestId('agent-avatar-fallback').textContent).toBe('r');
  });

  it('skips the request when the caller knows there is no portrait', () => {
    render(<AgentAvatar name="atlas" avatar={null} />);
    expect(screen.queryByTestId('agent-avatar')).toBeNull();
    expect(screen.getByTestId('agent-avatar-fallback').textContent).toBe('a');
  });
});
