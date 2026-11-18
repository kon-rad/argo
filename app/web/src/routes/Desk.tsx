import { lazy, Suspense, type ComponentType } from 'react';

const packageName = '@secondbrain/hiring-desk/web';
const ExternalDesk = lazy(async () => import(/* @vite-ignore */ packageName) as Promise<{ default: ComponentType }>);

/** Browser half of the optional package. The module is fetched only when /desk is opened. */
export default function Desk() {
  return <Suspense fallback={<p>Loading hiring desk…</p>}><ExternalDesk /></Suspense>;
}
