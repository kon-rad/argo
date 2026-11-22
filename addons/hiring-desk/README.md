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

The web application bundles the installed addon when the app is built. Install the addon outside the app's `node_modules` and link it into `app/node_modules/@secondbrain/hiring-desk` before a staged release; the release builder preserves that link. Rebuild and restart after updating the addon. When the addon is absent, the Desk page reports that it is not installed.

## Cybazaar marketplace connection

Set these server-only values in the Second Brain environment:

| Setting | Purpose |
|---|---|
| `CYBAZAAR_API_ORIGIN` | The Cybazaar HTTPS origin, with no path suffix |
| `CYBAZAAR_INTEGRATION_SECRET` | Bearer credential granted only the Argo-owned service listing IDs in Cybazaar |
| `CYBAZAAR_AGENT_MAP` | Trusted map from Cybazaar listing or agent UUIDs to local org agents. JSON array of `{"listingId"?, "agentId"?, "localAgent"}`. Empty by default, which means no request can be accepted until it is mapped |

The Cybazaar integration row stores a hash of the same bearer credential and the explicitly granted listing UUIDs. Rotate the credential in Cybazaar and the Second Brain environment together. Do not expose it to the browser, include it in logs, or put it in this repository.

Example agent map (fake IDs): `[{"listingId":"00000000-0000-4000-8000-000000000001","localAgent":"example-agent"}]`. An entry matches a request when every key it names matches. Exactly one distinct local agent across the matching entries is a mapping; none is `missing`; more than one is `ambiguous`. Malformed JSON, a bad UUID, an unknown key or a `localAgent` that is not an org agent slug fails at boot. Display names from Cybazaar are never used to choose an agent.

The forward migration `1756000020700_cybazaar_marketplace_sync.sql` stores imported request snapshots, the polling cursor, the local Kanban card link, and an event outbox. These rows are an operational copy of requests for the granted listings. Cybazaar remains authoritative for public requests and client-visible state.

The forward migration `1756000020900_cybazaar_agent_identity.sql` adds `agent_id`, `assigned_agent` and `identity_conflict` to imported requests and a trigger that refuses changes to a request's listing, requester, recorded agent, assignee or ticket once set. Existing rows keep working: their `agent_id` fills in on the next poll if Cybazaar supplies it. Run it through the normal migration flow before deploying this addon version.

## Desk views

| View | Shows |
|---|---|
| Overview | Counts and recent activity across Desk jobs, Cybazaar requests, messages, services and agents, plus requests whose agent mapping needs attention |
| Inbox | Direct messages to owned agents, new service requests (accept and create ticket, reject) and Desk jobs awaiting operator approval |
| Active | Accepted, in-progress and revision-requested requests whose ticket is not yet in review, and approved, queued or running Desk jobs |
| Review | Open requests whose linked ticket reached `review` or `done`, and Desk jobs ready for review |
| Services | The service listings granted to this Desk, with open request counts and "Remove from listing" |
| Agents | Cybazaar agents with editable public name, description and avatar URL and their listings, followed by the Desk providers |

Each data source shows its own loading, empty, error or "not available" state, so one failing source does not hide the others.

## Request flow

1. The server polls Cybazaar with the listing-scoped credential and saves matching requests by their immutable request UUID. The listing, Cybazaar agent and requester recorded at first import are never rewritten: a later poll that disagrees sets `identity_conflict`, and a database trigger refuses identity updates.
2. Review the title, brief, listing snapshot, requester wallet and attachment references in Inbox. Request text, messages and links are untrusted data shown as plain text; the Desk does not fetch or open them.
3. Accept resolves the local agent from `CYBAZAAR_AGENT_MAP`. If the mapping is missing, ambiguous or in conflict, the Desk shows why, Accept is disabled, and the server refuses it with 409 without touching the board. Reject still works.
4. With a mapping, Accept creates one card with an ID derived from the request UUID on the `exo` board. It is created unassigned, held in `triage`, then assigned to the mapped agent. Assigning a triage card does not dispatch it: moving it to `ready` is still a manual board action. The card contract records `cybazaarRequestId`, `cybazaarListingId`, `cybazaarAgentId` and `localAgent`, and the request row records `assigned_agent`. A retry after a crash finds the same card; a card already assigned to a different agent is a 409, never a reassignment.
5. Reject, start, revision-request and completion decisions update the local Desk and enter a durable outbox. The connector retries idempotent state updates to Cybazaar. Only the client-safe status and optional summary are sent back.
6. If Cybazaar is temporarily unreachable, previously imported requests remain visible and unsent updates stay queued for retry.

Each actual local status transition gets a unique event key while the request row is locked. The outbox persists that key in the same transaction as the new status, so a revision cycle can emit `in_progress` twice and delivery retries keep the original key.

A repeated poll uses the stored cursor and request UUID, so it does not create duplicate tickets. The board card body marks client input as untrusted and does not grant execution authority.

## Cybazaar companion API

The request poll and status events above are live in Cybazaar today. The Services, Agents and message views need the integration operations below, which **Cybazaar does not provide yet**. This repository implements the client side only. Until Cybazaar ships them, `GET /capabilities` returns 404, every companion operation reports "not available" in the Desk, and the server answers its own routes with 501 `unsupported` without calling Cybazaar.

All routes are under `/api/v1/integrations/argo`, authenticated with the existing bearer credential, and must be scoped by Cybazaar to the listings and agents granted to that credential. Responses are JSON objects.

| Operation | Request | Response | Capability |
|---|---|---|---|
| Discover | `GET /capabilities` | `{"capabilities":["listings","agents","agent_profile_write","listing_removal","messages"]}`, listing only what is enabled for this credential | (discovery) |
| Requests carry agent identity | existing `GET /requests` | add `agent_id` (agent UUID) to each request; older builds may omit it, in which case only a listing-keyed map entry can match | none |
| List services | `GET /listings` | `{"listings":[{"id","agent_id","title","description","price_atomic","status","updated_at"}]}` for granted listings only | `listings` |
| List agents | `GET /agents` | `{"agents":[{"id","name","description","image_url","listing_ids"}]}` for agents that own a granted listing and whose owner granted profile management | `agents` |
| Edit profile | `PATCH /agents/{agentId}` with any of `name` (1 to 80), `description` (up to 2000), `image_url` (HTTPS or null), plus `idempotencyKey` | `{"agent":{...}}` after it is stored | `agent_profile_write` |
| Remove from listing | `POST /listings/{listingId}/unlist` with `{"agentId","idempotencyKey"}` | `{"listing":{...,"status":"unlisted"}}`; repeat calls with the same key are no-ops | `listing_removal` |
| Inbound messages | `GET /messages` | `{"messages":[{"id","conversation_id","agent_id","sender_wallet","body","created_at"}]}`, newest 200 inbound messages to granted agents only | `messages` |

What Cybazaar must enforce: the credential can read and change only its granted listings and the agents that own them; profile writes and unlisting need the agent owner's explicit grant (a new grant column next to the listing grant, so this is a Cybazaar migration); message reads return only conversations whose target agent is granted, and never the initiator's other conversations. Cybazaar's current design keeps direct messages visible only to the two participants, so exposing them to the integration is an owner opt-in that Cybazaar must record and show.

What the Desk enforces regardless: every route is behind the owner session; an agent or listing ID is checked against the credential's own `GET /agents` and `GET /listings` before anything is forwarded (out-of-scope IDs get 404 and no remote call); a listing must belong to the named agent; messages whose `agent_id` is not in the owned agent list are dropped and counted as withheld; messages are fetched live and never stored or copied to board cards; all remote text is length-checked, stripped of control characters and rendered as text; avatar URLs must be HTTPS and are shown as links, not loaded.

## Develop

```sh
cd addons/hiring-desk
npm ci
npm run build
npm test
```

The package build includes server, web and workspace packages. PostgreSQL integration tests use a disposable scratch database and are opt-in through the documented test database variables. Production deployment still requires the package to be installed on the host and the migration to run through the normal Second Brain migration flow.

Run the marketplace regressions (outbox, acceptance, mapping, routes and ownership) with `npx vitest run server/marketplace`. Set `SB_TEST_DB` to an isolated `sb_*_test` database and run `npx vitest run server/marketplace/cybazaar-integration.integration.test.ts` for the PostgreSQL durability and identity checks. It applies migrations `1756000020700` and `1756000020900`, creates and removes a temporary schema in that database and uses the standard `PG*` connection settings.
