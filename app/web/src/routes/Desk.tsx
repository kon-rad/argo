import { lazy, Suspense } from 'react';

const ExternalDesk = lazy(() => import('virtual:hiring-desk'));

/** Browser half of the optional package. The module is fetched only when /desk is opened. */
export default function Desk() {
  return <Suspense fallback={<p>Loading hiring desk…</p>}><ExternalDesk /></Suspense>;
}
