import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CONTRACT_VERSION, type Approval, type DeskOperatorApi, type OperatorJob, type Provider, type ReleaseRequest, type WorkerResult } from '@secondbrain/desk-contracts/desk';
import Desk from '../src/routes/desk/Desk.js';

afterEach(() => cleanup());

const brief = 'Summarize a public corpus.';
const makeJob = (overrides: Partial<OperatorJob> = {}): OperatorJob => ({
  id: 'job-42', revision: 4,
  publicState: {
    stage: 'accepted', jobRef: 'arkiv:test/job-42', conflict: false, rejected: [],
    job: { version: CONTRACT_VERSION, domain: 'example', chainId: 'arkiv:test', type: 'job', jobId: 'job-42', nonce: 'n-1', client: 'wallet:client', skill: 'research', brief, budgetAtomic: '5000', asset: 'USDC', paymentChainId: 'arc:test', deadline: 2_000_000_000 },
    offer: { version: CONTRACT_VERSION, domain: 'example', chainId: 'arkiv:test', type: 'offer', jobRef: 'arkiv:test/job-42', providerId: 'provider-1', provider: 'wallet:provider', skillVersion: 'research/1', amountAtomic: '4200', paymentChainId: 'arc:test', asset: 'USDC', recipient: 'wallet:provider', transferInterface: 'unselected', expiresAt: 2_000_000_000 },
    acceptance: { version: CONTRACT_VERSION, domain: 'example', chainId: 'arkiv:test', type: 'acceptance', jobRef: 'arkiv:test/job-42', offerRef: 'arkiv:test/offer-42', client: 'wallet:client', offerDigest: 'sha256:offer', nonce: 'n-2', expiresAt: 2_000_000_000 },
    acceptanceDigest: 'sha256:acceptance', offerRef: 'arkiv:test/offer-42', acceptanceRef: 'arkiv:test/acceptance-42',
  }, execution: 'awaiting_operator', ...overrides,
});
const provider: Provider = { version: CONTRACT_VERSION, domain: 'example', chainId: 'arkiv:test', type: 'provider', providerId: 'provider-1', profileRef: 'arkiv:test/provider-1', owner: 'wallet:provider', skill: 'research', skillVersion: 'research/1', identityRefs: [], paymentAddress: 'wallet:provider' };

function fakeApi(initial = makeJob()) {
  let current = initial;
  const api: DeskOperatorApi = {
    mode: 'fixture',
    inbox: vi.fn(async () => ({ kind: 'ok' as const, value: [current] })),
    jobs: vi.fn(async () => ({ kind: 'ok' as const, value: [current] })),
    job: vi.fn(async () => ({ kind: 'ok' as const, value: current })),
    providers: vi.fn(async () => ({ kind: 'ok' as const, value: [provider] })),
    approve: vi.fn(async (_id: string, _request: Approval) => ({ kind: 'ok' as const, value: current })),
    decline: vi.fn(async (_id: string) => ({ kind: 'ok' as const, value: current })),
    cancel: vi.fn(async (_id: string) => ({ kind: 'ok' as const, value: current })),
    preview: vi.fn(async () => ({ kind: 'ok' as const, value: ({ artifactHash: `sha256:${'a'.repeat(64)}`, mediaType: 'text/markdown', artifactRef: '# private result\n\nSafe preview.', boundedTrace: 'synthetic trace' }) as WorkerResult })),
    release: vi.fn(async (_id: string, _request: ReleaseRequest) => ({ kind: 'ok' as const, value: current })),
  };
  return { api, get current() { return current; }, set current(job: OperatorJob) { current = job; } };
}

async function openJob(api: DeskOperatorApi) {
  render(<Desk operatorApi={api} />);
  await screen.findByText('Hiring Desk');
  fireEvent.click(screen.getByRole('button', { name: 'Inbox' }));
  const card = await screen.findByRole('button', { name: /research.*(Awaiting operator|Ready for review)/s });
  fireEvent.click(card);
  await screen.findByText('Summarize a public corpus.');
}

function completeApprovalForm() {
  fireEvent.change(screen.getByLabelText('Corpus digest'), { target: { value: 'sha256:corpus' } });
  fireEvent.change(screen.getByLabelText('Execution plan digest'), { target: { value: 'sha256:plan' } });
  fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'model-small' } });
}

describe('private hiring Desk', () => {
  it('keeps client acceptance separate from operator approval and sends current revision plus idempotency key', async () => {
    const fake = fakeApi();
    const approved = makeJob({ revision: 5, execution: 'approved', approval: {
      expectedRevision: 4, idempotencyKey: 'server-key', acceptanceDigest: 'sha256:acceptance', skillVersion: 'research/1', corpusDigest: 'sha256:corpus', inputRefs: [], audience: 'job-42', expiresAt: 2_000_000_000,
      limits: { tools: [], model: 'model-small', maxCostAtomic: '4200', costAsset: 'USDC', maxRuntimeSeconds: 300, maxOutputTokens: 4000 }, planDigest: 'sha256:plan',
    } });
    vi.mocked(fake.api.approve).mockImplementation(async (_id, request) => {
      expect(request.acceptanceDigest).toBe('sha256:acceptance');
      fake.current = approved;
      return { kind: 'ok', value: approved };
    });
    await openJob(fake.api);
    expect(screen.getByText('Client accepted')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Approve and dispatch' }) as HTMLButtonElement).disabled).toBe(true);
    completeApprovalForm();
    fireEvent.click(screen.getByRole('button', { name: 'Approve and dispatch' }));
    await screen.findByText('Operator approved');
    expect(fake.api.approve).toHaveBeenCalledWith('job-42', expect.objectContaining({ expectedRevision: 4, idempotencyKey: expect.any(String), acceptanceDigest: 'sha256:acceptance' }));
    expect(screen.queryByRole('button', { name: 'Approve and dispatch' })).toBeNull();
  });

  it('refreshes the selected job when a mutation reports a stale revision', async () => {
    const fake = fakeApi();
    const latest = makeJob({ revision: 9 });
    vi.mocked(fake.api.approve).mockResolvedValue({ kind: 'failed', message: 'STALE_REVISION: expected 4, found 9' });
    vi.mocked(fake.api.job).mockResolvedValueOnce({ kind: 'ok', value: makeJob() }).mockResolvedValue({ kind: 'ok', value: latest });
    await openJob(fake.api);
    completeApprovalForm();
    fireEvent.click(screen.getByRole('button', { name: 'Approve and dispatch' }));
    await screen.findByText(/revision 9/i);
    expect(fake.api.job).toHaveBeenCalledTimes(2);
    expect(await screen.findByText(/latest revision has been loaded/i)).toBeTruthy();
  });

  it('uses the exact preview hash and media type on release, and does not render embedded HTML', async () => {
    const fake = fakeApi(makeJob({ revision: 6, execution: 'review', result: { artifactHash: 'sha256:old', mediaType: 'text/markdown', artifactRef: 'private://artifact', boundedTrace: 'trace' } }));
    vi.mocked(fake.api.preview).mockResolvedValue({ kind: 'ok', value: { artifactHash: `sha256:${'b'.repeat(64)}`, mediaType: 'text/markdown', artifactRef: '# Result\n\n<script>window.pwned=true</script>', boundedTrace: 'trace' } });
    vi.mocked(fake.api.release).mockImplementation(async (_id, request) => ({ kind: 'ok', value: makeJob({ revision: 7, execution: 'released', result: { ...request, artifactRef: 'private://artifact', boundedTrace: 'trace' } }) }));
    await openJob(fake.api);
    fireEvent.click(screen.getByRole('button', { name: 'Load private result' }));
    await screen.findByText('Result');
    expect(document.querySelector('script')).toBeNull();
    fireEvent.change(screen.getByLabelText('Public destination'), { target: { value: 'swarm://synthetic-destination' } });
    fireEvent.click(screen.getByRole('button', { name: 'Approve release' }));
    await waitFor(() => expect(fake.api.release).toHaveBeenCalledWith('job-42', expect.objectContaining({ expectedRevision: 6, idempotencyKey: expect.any(String), artifactHash: `sha256:${'b'.repeat(64)}`, mediaType: 'text/markdown', publicDestination: 'swarm://synthetic-destination' })));
  });

  it('shows denied actions as an accessible session or authorization error', async () => {
    const fake = fakeApi();
    vi.mocked(fake.api.approve).mockResolvedValue({ kind: 'denied', message: 'Session expired' });
    await openJob(fake.api);
    completeApprovalForm();
    fireEvent.click(screen.getByRole('button', { name: 'Approve and dispatch' }));
    expect((await screen.findByRole('alert')).textContent).toContain('denied: Session expired');
  });
});
