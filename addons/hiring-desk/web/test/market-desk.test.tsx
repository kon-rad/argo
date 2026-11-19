import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MarketDesk } from '../src/MarketDesk.js';
afterEach(cleanup);
const job = {
  id: 'job-one', title: 'Animation commission', brief: '<script>untrusted brief</script>', status: 'review', priceAtomic: '1000000',
  cardId: 't_123abc', artifactSha256: 'a'.repeat(64), summary: 'Reviewed summary', paymentTx: null, pendingPaymentTx: null, swarmRef: null, uploadState: 'not-started',
};
it('reviews the exact private MP4 and sends one hash-bound Release action', async () => {
  const request = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => new Response(JSON.stringify(init?.method === 'POST' ? { job } : { jobs: [job] }), { headers: { 'content-type': 'application/json' } }));
  const view = render(<MarketDesk request={request as typeof fetch} />);
  fireEvent.click(await screen.findByText('Animation commission'));
  const video = view.container.querySelector('video')!;
  expect(video.getAttribute('src')).toContain(`/operator/jobs/job-one/artifact?hash=${job.artifactSha256}`);
  expect(view.container.querySelector('script')).toBeNull();
  fireEvent.click(screen.getByText('Release reviewed summary'));
  await waitFor(() => expect(request).toHaveBeenCalledWith('/api/desk/market/operator/jobs/job-one/release', expect.objectContaining({ method: 'POST', body: JSON.stringify({ artifactSha256: job.artifactSha256, summary: job.summary }) })));
  expect(view.container.querySelector('a[href^="swarm:"]')).toBeNull();
});
it('does not allow another release or cancellation after verified payment', async () => {
  const request = vi.fn(async () => new Response(JSON.stringify({ jobs: [{ ...job, status: 'released', paymentTx: `0x${'b'.repeat(64)}`, uploadState: 'uploading' }] }), { headers: { 'content-type': 'application/json' } }));
  render(<MarketDesk request={request as typeof fetch} />);
  fireEvent.click(await screen.findByText('Animation commission'));
  expect(screen.queryByText('Release reviewed summary')).toBeNull(); expect(screen.queryByText('Cancel commission')).toBeNull();
  expect(screen.getByText(/Do not request another transfer/)).toBeTruthy();
  expect(screen.getByText('Reconcile existing delivery')).toBeTruthy();
});
it('shows service unavailability instead of a pretend empty operational inbox', async () => {
  render(<MarketDesk request={vi.fn(async () => new Response('', { status: 503 })) as typeof fetch} />);
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Commission service is not configured.');
});
