import { log } from './logger.js';

export interface ActiveRun {
  sourceId: number;
  /** Resolves once the caller has created the `ingest_runs` row. */
  runId: Promise<number>;
  controller: AbortController;
}

export interface Claim {
  /** Puts the job on the chain and publishes `runId` to anyone holding a 409. */
  start(runId: number, job: (runId: number, signal: AbortSignal) => Promise<void>): void;
  /** Releases the claim when the run row could not be created. */
  abandon(err: unknown): void;
}

const active = new Map<number, ActiveRun>();
let chain: Promise<unknown> = Promise.resolve();

export function activeRun(sourceId: number): ActiveRun | null {
  return active.get(sourceId) ?? null;
}

export function activeSourceIds(): number[] {
  return [...active.keys()];
}

/**
 * Claims a source **synchronously**. The caller then awaits a database insert
 * before it can start the job, and two concurrent POSTs would both clear an
 * async check — so the claim has to land before the first `await`, not after.
 *
 * Returns null when the source already has a claim; the caller reports 409
 * with `activeRun(sourceId).runId`.
 */
export function claim(sourceId: number): Claim | null {
  if (active.has(sourceId)) return null;

  let publish!: (id: number) => void;
  let fail!: (err: unknown) => void;
  const runId = new Promise<number>((resolve, reject) => {
    publish = resolve;
    fail = reject;
  });
  // A 409 racing an insert failure is the only consumer; without this an
  // unconsumed rejection would take the process down.
  runId.catch(() => {});

  active.set(sourceId, { sourceId, runId, controller: new AbortController() });

  return {
    start(id, job) {
      const entry = active.get(sourceId);
      if (!entry) throw new Error(`claim on source ${sourceId} was already released`);
      publish(id);
      // One chain, process-wide: jobs run strictly one at a time.
      chain = chain.then(async () => {
        try {
          await job(id, entry.controller.signal);
        } catch (err) {
          log.error(`run ${id} failed:`, err);
        } finally {
          active.delete(sourceId);
        }
      });
    },
    abandon(err) {
      active.delete(sourceId);
      fail(err);
    },
  };
}

/** Signals every in-flight job to stop, then waits for the chain to drain. */
export async function drain(): Promise<void> {
  for (const entry of active.values()) entry.controller.abort();
  await chain;
}

/** Test seam only: forgets state between suites. */
export function resetQueue(): void {
  active.clear();
  chain = Promise.resolve();
}
