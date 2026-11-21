# Hiring Desk addon

The Hiring Desk is an optional Second Brain service. Its operator console combines ordinary internal jobs with requests imported from Cybazaar. Cybazaar remains an independent marketplace with its own application, API, and PostgreSQL database.

## Install in a Second Brain checkout

```sh
cd app
npm install @secondbrain/hiring-desk
npm run build
secondbrain doctor
```

Add `desk` to the enabled modules. Configure the ordinary Desk runtime separately if its private work queue is needed. Cybazaar marketplace polling uses only the settings below and does not require Cybazaar tables in the Second Brain database.

## Cybazaar marketplace connection

Set these server-only values in the Second Brain environment:

| Setting | Purpose |
|---|---|
| `CYBAZAAR_API_ORIGIN` | The Cybazaar HTTPS origin, with no path suffix |
| `CYBAZAAR_INTEGRATION_SECRET` | Bearer credential granted only the Argo-owned service listing IDs in Cybazaar |

The Cybazaar integration row stores a hash of the same bearer credential and the explicitly granted listing UUIDs. Rotate the credential in Cybazaar and the Second Brain environment together. Do not expose it to the browser, include it in logs, or put it in this repository.

The forward migration `1756000020700_cybazaar_marketplace_sync.sql` stores imported request snapshots, the polling cursor, the local Kanban card link, and an event outbox. These rows are an operational copy of requests for the granted listings. Cybazaar remains authoritative for public requests and client-visible state.

## Request flow

1. Open the Marketplace section in the private Hiring Desk. The server polls Cybazaar with the listing-scoped credential and saves matching requests by their immutable request UUID.
2. Review the title, brief, listing snapshot, requester wallet and attachment references. Request text and links are untrusted data; the Desk does not fetch or open them.
3. Accepting creates one deterministic, unassigned triage card on the ordinary `exo` Kanban board. Dispatch remains a manual operator action using the existing board controls.
4. Reject, start, revision-request and completion decisions update the local Desk and enter a durable outbox. The connector retries idempotent state updates to Cybazaar. Only the client-safe status and optional summary are sent back.
5. If Cybazaar is temporarily unreachable, previously imported requests remain visible and unsent updates stay queued for retry.

Each actual local status transition gets a unique event key while the request row is locked. The outbox persists that key in the same transaction as the new status, so a revision cycle can emit `in_progress` twice and delivery retries keep the original key. Existing queued keys remain valid; no migration is required.

A repeated poll uses the stored cursor and request UUID, so it does not create duplicate tickets. The board card body marks client input as untrusted and does not grant execution authority.

## Develop

```sh
cd addons/hiring-desk
npm ci
npm run build
npm test
```

The package build includes server, web and workspace packages. PostgreSQL integration tests use a disposable scratch database and are opt-in through the documented test database variables. Production deployment still requires the package to be installed on the host and the migration to run through the normal Second Brain migration flow.

Run the revision-cycle regression with `npx vitest run server/marketplace/cybazaar-integration.test.ts`. Set `SB_TEST_DB` to an isolated `sb_*_test` database and run `npx vitest run server/marketplace/cybazaar-integration.integration.test.ts` for the PostgreSQL durability check. It creates and removes a temporary schema in that database and uses the standard `PG*` connection settings.
