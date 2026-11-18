import { Router } from 'express';
import { buildOverview, defaultFundDeps, type FundDeps, type FundOverview } from '../fund.js';
import { wrap } from './http.js';

/** Chain reads are slow and rate limited, so one result is shared for this long. */
const TTL_MS = 30_000;

/**
 * The fund module's API: one read-only overview. Nothing here signs, proposes
 * or approves; trades are approved on the fund's own device or wallet.
 */
export function fundRouter(vaultRoot: string, deps: Partial<FundDeps> = {}): Router {
  const d: FundDeps = { ...defaultFundDeps, ...deps };
  const router = Router();
  let cached: { at: number; value: Promise<FundOverview> } | null = null;

  router.get(
    '/',
    wrap(async (req, res) => {
      const fresh = req.query.refresh === '1';
      if (!cached || fresh || d.now() - cached.at > TTL_MS) {
        const value = buildOverview(vaultRoot, d);
        cached = { at: d.now(), value };
        value.catch(() => {
          if (cached?.value === value) cached = null;
        });
      }
      res.json(await cached.value);
    }),
  );

  return router;
}
