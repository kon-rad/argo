import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { CardNotes } from '../src/components/CardNotes.js';
import { ChatInput } from '../src/components/ChatInput.js';

afterEach(() => cleanup());

describe('CardNotes', () => {
  it('links the vault notes a card names and drops refs that are not vault files', () => {
    render(
      <MemoryRouter>
        <CardNotes
          refs={['Research/ai/model-routing-by-role-research.md', 'ghost-note', 'jev-performance-and-cost-plan-research']}
          resolved={{
            'Research/ai/model-routing-by-role-research.md': 'Research/ai/model-routing-by-role-research.md',
            'ghost-note': null,
            'jev-performance-and-cost-plan-research': 'Research/ai/jev-performance-and-cost-plan-research.md',
          }}
        />
      </MemoryRouter>,
    );
    const links = screen.getAllByRole('link');
    expect(links.map((a) => a.textContent)).toEqual(['model-routing-by-role-research.md', 'jev-performance-and-cost-plan-research.md']);
    expect(links[0]!.getAttribute('href')).toBe('/file/Research/ai/model-routing-by-role-research.md');
  });

  it('renders nothing when no ref resolves', () => {
    const { container } = render(<MemoryRouter><CardNotes refs={['x/y.md']} resolved={{}} /></MemoryRouter>);
    expect(container.innerHTML).toBe('');
  });
});

describe('ChatInput', () => {
  it('is a three-line box: Enter submits, Shift+Enter does not', () => {
    const submit = vi.fn();
    render(<ChatInput label="Message" value="hi" onChange={() => {}} onSubmit={submit} />);
    const box = screen.getByLabelText('Message') as HTMLTextAreaElement;
    expect(box.rows).toBe(3);
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
    expect(submit).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(submit).toHaveBeenCalledOnce();
  });
});
